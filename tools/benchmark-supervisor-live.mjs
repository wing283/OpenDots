import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { HttpAgent } from '@ag-ui/client';
import { ProxiedCopilotRuntimeAgent } from '@copilotkit/core';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function runState() {
  return {
    workers: Number(arg('--workers', '1')),
    maxParallel: Number(arg('--max-parallel', '1')),
    verify: arg('--verify', 'false') === 'true',
    synthesize: arg('--synthesize', 'false') === 'true',
  };
}

function input(prompt, label) {
  return {
    threadId: `${label}-${randomUUID()}`,
    runId: `run-${randomUUID()}`,
    messages: [{ id: randomUUID(), role: 'user', content: prompt }],
    state: runState(),
    tools: [],
    context: [],
    forwardedProps: {},
  };
}

function summarize(snapshot) {
  const workers = Array.isArray(snapshot?.workers) ? snapshot.workers : [];
  return {
    supervisorRunId: snapshot?.supervisorRunId ?? '',
    workers: workers.length,
    tokens: workers.reduce((sum, worker) => sum + Number(worker?.tokens || 0), 0),
    costUsd: Number(
      workers.reduce((sum, worker) => sum + Number(worker?.costUsd || 0), 0).toFixed(6),
    ),
    eventCounts: snapshot?.eventCounts ?? {},
  };
}

async function direct(url, prompt) {
  const agent = new HttpAgent({ url });
  let snapshot = {};
  let runError = null;
  const start = performance.now();
  await new Promise((resolve, reject) => {
    agent.run(input(prompt, 'direct-live')).subscribe({
      next(event) {
        if (event.type === 'STATE_SNAPSHOT') snapshot = event.snapshot ?? {};
        if (event.type === 'RUN_ERROR')
          runError = { code: event.code ?? '', message: event.message ?? '' };
      },
      error: reject,
      complete: resolve,
    });
  });
  return {
    wallMs: Number((performance.now() - start).toFixed(3)),
    ...summarize(snapshot),
    runError,
  };
}

async function proxied(runtimeUrl, runtimeAgentId, threadId, prompt) {
  const agent = new ProxiedCopilotRuntimeAgent({
    runtimeUrl,
    agentId: `live-local-${randomUUID()}`,
    runtimeAgentId,
  });
  agent.threadId = threadId;
  agent.setState(runState());
  agent.addMessage({ id: randomUUID(), role: 'user', content: prompt });
  let snapshot = {};
  let runError = null;
  const sub = agent.subscribe({
    onStateSnapshotEvent: ({ event }) => {
      snapshot = event.snapshot ?? {};
    },
    onRunErrorEvent: ({ event }) => {
      runError = { code: event.code ?? '', message: event.message ?? '' };
    },
  });
  const start = performance.now();
  try {
    await agent.runAgent();
  } finally {
    sub.unsubscribe();
    await agent.detachActiveRun();
  }
  return {
    wallMs: Number((performance.now() - start).toFixed(3)),
    ...summarize(snapshot),
    runError,
  };
}

const directUrl = arg('--direct');
const runtimeUrl = arg('--runtime');
const runtimeAgentId = arg('--agent-id');
const threadId = arg('--thread-id');
const prompt = arg('--prompt', 'Return exactly: 2 + 2 = 4');
const order = arg('--order', 'direct-first');

if (!directUrl || !runtimeUrl || !runtimeAgentId || !threadId)
  throw new Error('Required: --direct --runtime --agent-id --thread-id');
if (!['direct-first', 'opendots-first'].includes(order))
  throw new Error('--order must be direct-first or opendots-first');

const nonceA = randomUUID();
const nonceB = randomUUID();
const directPrompt = `${prompt}\n\n[benchmark_nonce=${nonceA}]`;
const openDotsPrompt = `${prompt}\n\n[benchmark_nonce=${nonceB}]`;

let directResult;
let openDotsResult;
if (order === 'direct-first') {
  directResult = await direct(directUrl, directPrompt);
  openDotsResult = await proxied(runtimeUrl, runtimeAgentId, threadId, openDotsPrompt);
} else {
  openDotsResult = await proxied(runtimeUrl, runtimeAgentId, threadId, openDotsPrompt);
  directResult = await direct(directUrl, directPrompt);
}

console.log(
  JSON.stringify(
    {
      order,
      direct: directResult,
      viaOpenDots: openDotsResult,
      delta: {
        wallMs: Number((openDotsResult.wallMs - directResult.wallMs).toFixed(3)),
        tokens: openDotsResult.tokens - directResult.tokens,
        costUsd: Number((openDotsResult.costUsd - directResult.costUsd).toFixed(6)),
      },
      runState: runState(),
      note:
        'Distinct benchmark_nonce values avoid exact-goal Result Cache reuse between paired runs.',
    },
    null,
    2,
  ),
);
