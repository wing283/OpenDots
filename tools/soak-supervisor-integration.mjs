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

function summarizeCustomEvents(customEvents) {
  const names = customEvents.map((event) => event.name);
  const count = (name) => names.filter((item) => item === name).length;
  const cache = customEvents
    .filter((event) =>
      ['sv.cache.hit', 'sv.cache.miss', 'sv.cache.store', 'sv.cache.store.skipped', 'sv.cache.bypass'].includes(event.name),
    )
    .map((event) => ({
      name: event.name,
      workerId: event.value?.workerId || '',
      key: event.value?.payload?.key || '',
      reason: event.value?.payload?.reason || '',
      sourceRunId: event.value?.payload?.source_run_id || '',
    }));
  return {
    names,
    cache,
    cacheHits: count('sv.cache.hit'),
    cacheMisses: count('sv.cache.miss'),
    cacheStores: count('sv.cache.store'),
    cacheStoreSkipped: count('sv.cache.store.skipped'),
    cacheBypasses: count('sv.cache.bypass'),
    approvalRequired: count('sv.approval.required'),
    approvalResolved: count('sv.approval.resolved'),
    planCacheHits: count('sv.plan.cache.hit'),
    planCacheMisses: count('sv.plan.cache.miss'),
    planCacheStores: count('sv.plan.cache.store'),
  };
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

function evaluateDagCache(first, second, keyComparison) {
  const expected = ['light_calc', 'light_sort', 'heavy_logic', 'heavy_design_review'];
  const firstById = Object.fromEntries((first.workers || []).map((worker) => [worker.id, worker]));
  const secondById = Object.fromEntries((second.workers || []).map((worker) => [worker.id, worker]));
  const firstIds = Object.keys(firstById).sort();
  const secondIds = Object.keys(secondById).sort();
  const exactWorkers =
    JSON.stringify(firstIds) === JSON.stringify([...expected].sort()) &&
    JSON.stringify(secondIds) === JSON.stringify([...expected].sort());
  const independent =
    expected.every((id) => (firstById[id]?.dependsOn || []).length === 0) &&
    expected.every((id) => (secondById[id]?.dependsOn || []).length === 0);
  const keysStable = expected.every((id) => keyComparison[id]?.same === true);
  const firstPlanCachePrimed =
    first.planCacheMisses >= 1 && first.planCacheStores >= 1;
  const secondPlanCacheHit = second.planCacheHits >= 1;
  const fullCacheHit =
    second.cacheHits === expected.length && second.cacheMisses === 0;
  const evidenceProjected =
    Number(first.evidence?.totalCount || 0) > 0 &&
    first.evidence?.spaceName === 'Supervisor Evidence' &&
    Number(second.evidence?.totalCount || 0) > 0 &&
    second.evidence?.spaceName === 'Supervisor Evidence';
  const completedWithoutRunError = !first.runError && !second.runError;
  return {
    pass:
      exactWorkers &&
      independent &&
      keysStable &&
      firstPlanCachePrimed &&
      secondPlanCacheHit &&
      fullCacheHit &&
      evidenceProjected &&
      completedWithoutRunError,
    exactWorkers,
    independent,
    keysStable,
    firstPlanCachePrimed,
    secondPlanCacheHit,
    fullCacheHit,
    evidenceProjected,
    completedWithoutRunError,
    firstCache: {
      hits: first.cacheHits,
      misses: first.cacheMisses,
      stores: first.cacheStores,
      skipped: first.cacheStoreSkipped,
    },
    secondCache: {
      hits: second.cacheHits,
      misses: second.cacheMisses,
      stores: second.cacheStores,
      skipped: second.cacheStoreSkipped,
    },
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
  const customSummary = summarizeCustomEvents(customEvents);
  return {
    threadId: thread.id,
    wallMs: Number(wallMs.toFixed(3)),
    supervisorRunId: snapshot.supervisorRunId || '',
    supervisorPid: Number(snapshot.supervisorPid || 0),
    eventCounts: snapshot.eventCounts || {},
    approval: snapshot.approval || {},
    workers: snapshot.workers || [],
    terminalRunning: snapshot.running === true,
    cancelled: snapshot.cancelled === true,
    cancelledAt: snapshot.cancelledAt || '',
    runError,
    evidence: evidence
      ? {
          totalCount: evidence.evidence?.totalCount ?? evidence.evidence?.totalCount ?? 0,
          pageTitle: evidence.page?.title || '',
          spaceName: evidence.space?.name || '',
        }
      : null,
    ...sumTokenCost(customEvents),
    ...customSummary,
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

  const expectedIds = ['calc_small', 'format_small'];
  const firstIds = (results.planCacheSmallFirst.workers || [])
    .map((worker) => worker.id)
    .filter(Boolean)
    .sort();
  const secondIds = (results.planCacheSmallSecond.workers || [])
    .map((worker) => worker.id)
    .filter(Boolean)
    .sort();
  const stableWorkers =
    JSON.stringify(firstIds) === JSON.stringify([...expectedIds].sort()) &&
    JSON.stringify(secondIds) === JSON.stringify([...expectedIds].sort());

  results.planCacheSmallVerdict = {
    pass:
      !results.planCacheSmallFirst.runError &&
      !results.planCacheSmallSecond.runError &&
      results.planCacheSmallFirst.planCacheMisses >= 1 &&
      results.planCacheSmallFirst.planCacheStores >= 1 &&
      results.planCacheSmallSecond.planCacheHits >= 1 &&
      results.planCacheSmallSecond.cacheHits === expectedIds.length &&
      results.planCacheSmallSecond.cacheMisses === 0 &&
      stableWorkers,
    firstRunCompleted: !results.planCacheSmallFirst.runError,
    secondRunCompleted: !results.planCacheSmallSecond.runError,
    firstPlanCacheMisses: results.planCacheSmallFirst.planCacheMisses,
    firstPlanCacheStores: results.planCacheSmallFirst.planCacheStores,
    secondPlanCacheHits: results.planCacheSmallSecond.planCacheHits,
    secondResultCacheHits: results.planCacheSmallSecond.cacheHits,
    secondResultCacheMisses: results.planCacheSmallSecond.cacheMisses,
    expectedResultCacheHits: expectedIds.length,
    stableWorkers,
    firstWorkerIds: firstIds,
    secondWorkerIds: secondIds,
  };
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
  const firstStoreKeys = Object.fromEntries(
    results.dagCacheFirst.cache
      .filter((item) => item.name === 'sv.cache.store')
      .map((item) => [item.workerId, item.key]),
  );
  const secondLookupKeys = Object.fromEntries(
    results.dagCacheSecond.cache
      .filter((item) => ['sv.cache.hit', 'sv.cache.miss'].includes(item.name))
      .map((item) => [item.workerId, item.key]),
  );
  results.cacheKeyComparison = Object.fromEntries(
    [...new Set([...Object.keys(firstStoreKeys), ...Object.keys(secondLookupKeys)])].map(
      (workerId) => [
        workerId,
        {
          firstStoreKey: firstStoreKeys[workerId] || '',
          secondLookupKey: secondLookupKeys[workerId] || '',
          same:
            !!firstStoreKeys[workerId] &&
            firstStoreKeys[workerId] === secondLookupKeys[workerId],
        },
      ],
    ),
  );
  results.dagCacheVerdict = evaluateDagCache(
    results.dagCacheFirst,
    results.dagCacheSecond,
    results.cacheKeyComparison,
  );
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
  let markerCleaned = false;
  try {
    await stat(marker);
  } catch {
    markerCleaned = true;
  }
  const finalApprovalStatus = String(result.approval?.status || '');
  results.writerApproval = {
    ...result,
    approvalSent,
    approvalResponse,
    markerExists,
    markerContent,
    markerCleaned,
  };
  results.writerApprovalVerdict = {
    pass:
      approvalSent &&
      approvalResponse?.ok === true &&
      !result.runError &&
      result.terminalRunning === false &&
      markerExists &&
      markerContent === 'OPENDOTS_WRITER_APPROVED' &&
      markerCleaned &&
      result.approvalRequired >= 1 &&
      result.approvalResolved >= 1 &&
      finalApprovalStatus === 'approved',
    approvalSent,
    approvalAccepted: approvalResponse?.ok === true,
    approvalRequiredEvents: result.approvalRequired,
    approvalResolvedEvents: result.approvalResolved,
    finalApprovalStatus,
    markerExact: markerContent === 'OPENDOTS_WRITER_APPROVED',
    markerCleaned,
    runCompleted: !result.runError && result.terminalRunning === false,
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
  const cancelCode = result.runError?.code || '';
  results.cancelVerdict = {
    pass:
      cancelSent &&
      cancelResponse?.ok === true &&
      cancelResponse?.cancelled === true &&
      result.cancelled === true &&
      result.terminalRunning === false &&
      cancelCode === 'SUPERVISOR_CANCELLED',
    cancelSent,
    cancelAccepted: cancelResponse?.ok === true,
    cancelResponseMarkedCancelled: cancelResponse?.cancelled === true,
    terminalCancelled: result.cancelled === true,
    terminalStopped: result.terminalRunning === false,
    runErrorCode: cancelCode,
  };
}

console.log(JSON.stringify(results, null, 2));
