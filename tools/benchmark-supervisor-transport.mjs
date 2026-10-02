import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { HttpAgent } from '@ag-ui/client';
import { ProxiedCopilotRuntimeAgent } from '@copilotkit/core';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    n: values.length,
    meanMs: Number(mean.toFixed(3)),
    medianMs: Number(pick(0.5).toFixed(3)),
    p95Ms: Number(pick(0.95).toFixed(3)),
    minMs: Number(sorted[0].toFixed(3)),
    maxMs: Number(sorted.at(-1).toFixed(3)),
  };
}

async function directRun(url) {
  const agent = new HttpAgent({ url });
  const input = {
    threadId: `direct-${randomUUID()}`,
    runId: `run-${randomUUID()}`,
    messages: [{ id: randomUUID(), role: 'user', content: 'transport benchmark' }],
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  };
  const start = performance.now();
  await new Promise((resolve, reject) => {
    agent.run(input).subscribe({
      error: reject,
      complete: resolve,
    });
  });
  return performance.now() - start;
}

async function proxiedRun(runtimeUrl, runtimeAgentId, threadId) {
  const agent = new ProxiedCopilotRuntimeAgent({
    runtimeUrl,
    agentId: `bench-local-${randomUUID()}`,
    runtimeAgentId,
  });
  agent.threadId = threadId;
  agent.addMessage({
    id: randomUUID(),
    role: 'user',
    content: 'transport benchmark',
  });
  const start = performance.now();
  try {
    await agent.runAgent();
  } finally {
    await agent.detachActiveRun();
  }
  return performance.now() - start;
}

const directUrl = arg('--direct');
const runtimeUrl = arg('--runtime');
const runtimeAgentId = arg('--agent-id');
const threadId = arg('--thread-id');
const repeats = Number(arg('--repeats', '30'));
const warmup = Number(arg('--warmup', '3'));

if (!directUrl || !runtimeUrl || !runtimeAgentId || !threadId)
  throw new Error('Required: --direct --runtime --agent-id --thread-id');

for (let i = 0; i < warmup; i++) {
  await directRun(directUrl);
  await proxiedRun(runtimeUrl, runtimeAgentId, threadId);
}

const direct = [];
const proxied = [];
for (let i = 0; i < repeats; i++) {
  direct.push(await directRun(directUrl));
  proxied.push(await proxiedRun(runtimeUrl, runtimeAgentId, threadId));
}

const d = stats(direct);
const p = stats(proxied);
const steadyDirect = stats(await directSeries(directUrl, repeats, warmup));
const steadyProxy = stats(
  await proxiedSeries(runtimeUrl, runtimeAgentId, threadId, repeats, warmup),
);
const delta = (a, b) => ({
  meanMs: Number((b.meanMs - a.meanMs).toFixed(3)),
  medianMs: Number((b.medianMs - a.medianMs).toFixed(3)),
  p95Ms: Number((b.p95Ms - a.p95Ms).toFixed(3)),
});
const result = {
  coldStart: {
    direct: d,
    viaOpenDots: p,
    overhead: delta(d, p),
  },
  steadyState: {
    direct: steadyDirect,
    viaOpenDots: steadyProxy,
    overhead: delta(steadyDirect, steadyProxy),
  },
};
console.log(JSON.stringify(result, null, 2));


async function directSeries(url, count, warmupCount) {
  const agent = new HttpAgent({ url });
  const values = [];
  const one = async () => {
    const input = {
      threadId: 'direct-steady-thread',
      runId: `run-${randomUUID()}`,
      messages: [{ id: randomUUID(), role: 'user', content: 'transport benchmark' }],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    };
    const start = performance.now();
    await new Promise((resolve, reject) => {
      agent.run(input).subscribe({ error: reject, complete: resolve });
    });
    return performance.now() - start;
  };
  for (let i = 0; i < warmupCount; i++) await one();
  for (let i = 0; i < count; i++) values.push(await one());
  return values;
}

async function proxiedSeries(runtimeUrl, runtimeAgentId, threadId, count, warmupCount) {
  const agent = new ProxiedCopilotRuntimeAgent({
    runtimeUrl,
    agentId: 'bench-steady',
    runtimeAgentId,
  });
  agent.threadId = threadId;
  const values = [];
  const one = async () => {
    agent.addMessage({
      id: randomUUID(),
      role: 'user',
      content: 'transport benchmark',
    });
    const start = performance.now();
    await agent.runAgent();
    return performance.now() - start;
  };
  try {
    for (let i = 0; i < warmupCount; i++) await one();
    for (let i = 0; i < count; i++) values.push(await one());
  } finally {
    await agent.detachActiveRun();
  }
  return values;
}
