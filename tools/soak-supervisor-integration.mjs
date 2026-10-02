import { randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ProxiedCopilotRuntimeAgent } from '@copilotkit/core';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function json(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(`${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function createThread(base, dotId, title) {
  return json(`${base}/api/conversations`, {
    method: 'POST',
    body: JSON.stringify({ dotId, title }),
  });
}

function sumTokenCost(customEvents) {
  const report = [...customEvents]
    .reverse()
    .find((event) => event.name === 'sv.token.cost.report');
  const payload = report?.value?.payload || {};
  return {
    tokens: Number(payload.actual_total_tokens || 0),
    costUsd: Number(payload.actual_cost_usd || 0),
    baselineCostUsd: Number(payload.baseline_cost_usd || 0),
    costSavingsPercent: Number(payload.cost_savings_percent || 0),
  };
}

async function projectEvidence(base, supervisorRunId) {
  if (!supervisorRunId) return null;
  return json(`${base}/api/supervisor/evidence`, {
    method: 'POST',
    body: JSON.stringify({ supervisorRunId }),
  });
}

async function runOne({
  base,
  runtime,
  dotId,
  title,
  prompt,
  state,
  onSnapshot,
}) {
  const thread = await createThread(base, dotId, title);
  const agent = new ProxiedCopilotRuntimeAgent({
    runtimeUrl: runtime,
    agentId: `soak-${randomUUID()}`,
    runtimeAgentId: dotId,
  });
  agent.threadId = thread.id;
  agent.setState(state);
  agent.addMessage({ id: randomUUID(), role: 'user', content: prompt });

  let snapshot = {};
  let runError = null;
  const customEvents = [];
  const snapshots = [];
  const sub = agent.subscribe({
    onStateSnapshotEvent: ({ event }) => {
      const next = event.snapshot || {};
      if (next.bridge !== 'supervisor-agui') return;
      snapshot = next;
      snapshots.push(snapshot);
      if (onSnapshot) void onSnapshot(snapshot);
    },
    onCustomEvent: ({ event }) => {
      customEvents.push(event);
    },
    onRunErrorEvent: ({ event }) => {
      runError = { code: event.code || '', message: event.message || '' };
    },
  });

  const started = performance.now();
  try {
    await agent.runAgent();
  } finally {
    sub.unsubscribe();
    await agent.detachActiveRun();
  }
  const wallMs = performance.now() - started;
  const evidence = await projectEvidence(base, snapshot.supervisorRunId);
  return {
    threadId: thread.id,
    wallMs: Number(wallMs.toFixed(3)),
    supervisorRunId: snapshot.supervisorRunId || '',
    supervisorPid: Number(snapshot.supervisorPid || 0),
    eventCounts: snapshot.eventCounts || {},
    approval: snapshot.approval || {},
    workers: snapshot.workers || [],
    runError,
    evidence: evidence
      ? {
          totalCount: evidence.evidence?.totalCount ?? evidence.evidence?.totalCount ?? 0,
          pageTitle: evidence.page?.title || '',
          spaceName: evidence.space?.name || '',
        }
      : null,
    ...sumTokenCost(customEvents),
    customEventNames: customEvents.map((event) => event.name),
    snapshots: snapshots.length,
  };
}

const base = arg('--base');
const runtime = arg('--runtime');
const dotId = arg('--agent-id');
const workspace = arg('--workspace');
const mode = arg('--mode', 'all');
if (!base || !runtime || !dotId)
  throw new Error('Required: --base --runtime --agent-id');

const results = {};

if (mode === 'plan-cache-small') {
  const prompt = [
    'Supervisor cache regression. Create exactly two independent read_only light workers with depends_on=[] and preserve these IDs exactly.',
    '1) calc_small: compute 37 + 58 and verify the addition with a second method.',
    '2) format_small: convert the exact input words alpha, beta, gamma into a JSON array of three strings and verify the array length is 3.',
    'Do not create files, do not use a writer, and do not add dependencies.',
  ].join('\n');
  const state = { workers: 2, maxParallel: 2, verify: false, synthesize: false };
  results.planCacheSmallFirst = await runOne({
    base,
    runtime,
    dotId,
    title: 'Plan cache small 1',
    prompt,
    state,
  });
  results.planCacheSmallSecond = await runOne({
    base,
    runtime,
    dotId,
    title: 'Plan cache small 2',
    prompt,
    state,
  });
}

if (mode === 'all' || mode === 'dag-cache') {
  const prompt = [
    'Supervisor/OpenDots integration regression. Create exactly four independent workers with depends_on=[] for every worker.',
    '1) light_calc: complexity=light, read_only. Compute the sum of integers 1 through 100 and independently verify it with a second method.',
    '2) light_sort: complexity=light, read_only. Sort 赤、青、黄、緑、白 by Japanese reading in gojuuon order and include each reading.',
    '3) heavy_logic: complexity=heavy, read_only. For independent sensor failures A/B each 0.02 plus a separate common-cause failure event 0.005, calculate the probability that at least one sensor remains normal, state the model equation and caveat.',
    '4) heavy_design_review: complexity=heavy, read_only. Review a hypothetical 24 V BLDC servo controller architecture containing input protection, 3-phase MOSFET bridge, gate driver, current sensing, MCU and CAN-FD. Identify the top engineering verification items without modifying any files.',
    'Do not create a writer worker. Keep all four workers independent and preserve the worker IDs exactly as specified.',
  ].join('\n');

  const state = { workers: 4, maxParallel: 4, verify: true, synthesize: true };
  results.dagCacheFirst = await runOne({
    base,
    runtime,
    dotId,
    title: 'DAG cache soak 1',
    prompt,
    state,
  });
  results.dagCacheSecond = await runOne({
    base,
    runtime,
    dotId,
    title: 'DAG cache soak 2',
    prompt,
    state,
  });
}

if (mode === 'all' || mode === 'writer-approval') {
  if (!workspace) throw new Error('--workspace is required for writer-approval');
  const marker = join(workspace, 'OPENDOTS_SOAK_WRITER_MARKER.txt');
  await rm(marker, { force: true });

  let approvalSent = false;
  let approvalResponse = null;
  const state = { workers: 1, maxParallel: 1, verify: false, synthesize: false };
  const prompt = [
    'Create exactly one worker. It must be mode=writer and complexity=light.',
    'This is an isolated validation worktree. Modify exactly one file and no others:',
    'OPENDOTS_SOAK_WRITER_MARKER.txt in the current working directory.',
    'The complete file content must be exactly: OPENDOTS_WRITER_APPROVED',
    'Do not run network actions, do not modify git configuration, do not commit, and do not touch any other file.',
  ].join('\n');

  const result = await runOne({
    base,
    runtime,
    dotId,
    title: 'Writer approval soak',
    prompt,
    state,
    onSnapshot: async (snapshot) => {
      if (
        approvalSent ||
        !snapshot.supervisorRunId ||
        snapshot.approval?.status !== 'pending'
      )
        return;
      approvalSent = true;
      approvalResponse = await json(`${base}/api/supervisor/approval`, {
        method: 'POST',
        body: JSON.stringify({
          supervisorRunId: snapshot.supervisorRunId,
          decision: 'approve',
        }),
      });
    },
  });

  let markerExists = false;
  let markerContent = '';
  try {
    await stat(marker);
    markerExists = true;
    markerContent = (await readFile(marker, 'utf8')).trim();
  } catch {}
  await rm(marker, { force: true });
  results.writerApproval = {
    ...result,
    approvalSent,
    approvalResponse,
    markerExists,
    markerContent,
    markerCleaned: true,
  };
}

if (mode === 'all' || mode === 'cancel') {
  let cancelSent = false;
  let cancelResponse = null;
  const state = { workers: 4, maxParallel: 4, verify: false, synthesize: false };
  const prompt = [
    'Create four independent heavy read_only engineering-analysis workers.',
    'Each worker must perform a distinct multi-step trade study of a hypothetical 24 V robot servo: thermal, power integrity, control latency, and CAN-FD robustness.',
    'Do not modify files or perform external actions.',
    'Provide detailed evidence-backed reasoning in every worker.',
  ].join('\n');

  const result = await runOne({
    base,
    runtime,
    dotId,
    title: 'Run cancel soak',
    prompt,
    state,
    onSnapshot: async (snapshot) => {
      if (
        cancelSent ||
        !snapshot.running ||
        !snapshot.supervisorRunId ||
        !snapshot.supervisorPid
      )
        return;
      cancelSent = true;
      await new Promise((resolve) => setTimeout(resolve, 750));
      cancelResponse = await json(`${base}/api/supervisor/cancel`, {
        method: 'POST',
        body: JSON.stringify({
          supervisorRunId: snapshot.supervisorRunId,
          supervisorPid: snapshot.supervisorPid,
        }),
      });
    },
  });
  results.cancel = { ...result, cancelSent, cancelResponse };
}

console.log(JSON.stringify(results, null, 2));
