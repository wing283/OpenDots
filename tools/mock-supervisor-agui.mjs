import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const port = Number(process.env.MOCK_SUPERVISOR_PORT || 28793);
const workspace = process.env.MOCK_SUPERVISOR_WORKSPACE || '';
let planCacheSoakRuns = 0;
let dagCacheSoakRuns = 0;
const approvals = new Map();
const cancellations = new Map();
const threadSnapshots = new Map();

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function worker(
  id,
  { dependsOn = [], mode = 'read_only', complexity = 'light' } = {},
) {
  return {
    id,
    title: id,
    status: 'stopped',
    action: 'COMPLETE',
    phase: 'complete',
    provider: 'mock',
    model: 'mock',
    complexity,
    mode,
    dependsOn,
    waitingFor: [],
    downstreamWaitingCount: 0,
    reason: '',
    costUsd: 0,
    tokens: 0,
  };
}

function custom(name, workerId = '', payload = {}) {
  return {
    type: 'CUSTOM',
    name,
    value: { payload, workerId },
  };
}

function snapshot({
  bridgeRunId,
  supervisorRunId,
  workers,
  running,
  eventCounts = {},
  approval = {},
  cancelled = false,
}) {
  return {
    type: 'STATE_SNAPSHOT',
    snapshot: {
      bridge: 'supervisor-agui',
      bridgeRunId,
      supervisorRunId,
      supervisorPid: 4242,
      running,
      cancelled,
      activeCount: running ? 1 : 0,
      capacity: 3,
      eventCounts,
      workers,
      approval,
    },
  };
}

function writeSse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function waitUntil(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, {
      ok: true,
      bridgeReady: true,
      runReady: true,
      version: 'ci-mock',
      execution: { activeCount: 0, capacity: 3, missingRequiredEnv: [] },
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/thread-status') {
    const body = await readJson(req);
    const threadId = String(body.threadId || '');
    const restored = threadSnapshots.get(threadId);
    if (!restored) {
      sendJson(res, 404, {
        ok: false,
        error: 'No Supervisor workflow is bound to this thread.',
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      threadId,
      bindingStatus: restored.cancelled
        ? 'cancelled'
        : restored.running
          ? 'active'
          : 'finished',
      correlationState: restored.cancelled
        ? 'cancelled'
        : restored.running
          ? 'matched'
          : 'finished',
      snapshot: restored,
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/evidence') {
    const body = await readJson(req);
    const runId = String(body.supervisorRunId || 'ci-supervisor-run');
    sendJson(res, 200, {
      ok: true,
      evidence: {
        runId,
        totalCount: 1,
        items: [
          {
            id: 'EV-CI-0001',
            category: 'ci_mock',
            source: 'mock-supervisor-agui',
            trust: 'mechanical',
            capturedAt: '2026-10-03T00:00:00Z',
            sha256: 'ci-mock-sha256',
            payloadPreview: 'Deterministic CI evidence projection.',
          },
        ],
      },
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/approval') {
    const body = await readJson(req);
    const runId = String(body.supervisorRunId || '');
    const state = approvals.get(runId);
    if (!state) {
      sendJson(res, 404, { ok: false, error: 'approval run not found' });
      return;
    }
    state.status = body.decision === 'approve' ? 'approved' : 'declined';
    if (state.status === 'approved' && workspace) {
      await writeFile(
        join(workspace, 'OPENDOTS_SOAK_WRITER_MARKER.txt'),
        'OPENDOTS_WRITER_APPROVED',
        'utf8',
      );
    }
    sendJson(res, 200, {
      ok: true,
      approval: {
        runId,
        status: state.status,
        decision: body.decision,
      },
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/cancel') {
    const body = await readJson(req);
    const runId = String(body.supervisorRunId || '');
    const state = cancellations.get(runId);
    if (!state) {
      sendJson(res, 404, { ok: false, error: 'cancel run not found' });
      return;
    }
    state.cancelled = true;
    sendJson(res, 200, {
      ok: true,
      supervisorRunId: runId,
      supervisorPid: 4242,
      cancelled: true,
    });
    return;
  }

  if (req.method !== 'POST' || !['/', '/run'].includes(req.url || '')) {
    res.writeHead(404).end();
    return;
  }

  const input = await readJson(req);
  const threadId = String(input.threadId || 'ci-thread');
  const runId = String(input.runId || 'ci-run');
  const messageId = `${runId}-assistant`;
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const latestUser = [...messages]
    .reverse()
    .find((message) => message?.role === 'user');
  const prompt = String(latestUser?.content || '');
  const isPlanCacheSoak = prompt.includes('Supervisor cache regression.');
  const isDagCacheSoak = prompt.includes(
    'Supervisor/OpenDots integration regression.',
  );
  const isWriterSoak = prompt.includes('OPENDOTS_SOAK_WRITER_MARKER.txt');
  const isCancelSoak = prompt.includes(
    'Create four independent heavy read_only engineering-analysis workers.',
  );

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'close',
  });

  if (isWriterSoak) {
    const supervisorRunId = 'ci-writer-run';
    const writer = worker('writer', { mode: 'writer' });
    approvals.set(supervisorRunId, { status: 'pending' });
    writeSse(res, { type: 'RUN_STARTED', threadId, runId });
    writeSse(
      res,
      custom('sv.approval.required', 'writer', {
        run_id: supervisorRunId,
        status: 'pending',
      }),
    );
    writeSse(
      res,
      snapshot({
        bridgeRunId: runId,
        supervisorRunId,
        running: true,
        approval: { status: 'pending' },
        workers: [{ ...writer, status: 'waiting', action: 'WAIT' }],
      }),
    );

    const resolved = await waitUntil(
      () => approvals.get(supervisorRunId)?.status !== 'pending',
    );
    const approval = approvals.get(supervisorRunId);
    if (!resolved || !approval || approval.status !== 'approved') {
      writeSse(res, {
        type: 'RUN_ERROR',
        code: 'SUPERVISOR_APPROVAL_FAILED',
        message: 'Mock writer approval was not approved.',
      });
      approvals.delete(supervisorRunId);
      res.end();
      return;
    }

    writeSse(
      res,
      custom('sv.approval.resolved', 'writer', {
        run_id: supervisorRunId,
        status: 'approved',
      }),
    );
    writeSse(res, {
      type: 'TEXT_MESSAGE_START',
      messageId,
      role: 'assistant',
    });
    writeSse(res, {
      type: 'TEXT_MESSAGE_CONTENT',
      messageId,
      delta: 'ci-writer-approved',
    });
    writeSse(res, { type: 'TEXT_MESSAGE_END', messageId });
    const writerFinal = snapshot({
      bridgeRunId: runId,
      supervisorRunId,
      running: false,
      approval: { status: 'approved' },
      workers: [writer],
    });
    threadSnapshots.set(threadId, writerFinal.snapshot);
    writeSse(res, writerFinal);
    writeSse(res, { type: 'RUN_FINISHED', threadId, runId });
    approvals.delete(supervisorRunId);
    res.end();
    return;
  }

  if (isCancelSoak) {
    const supervisorRunId = 'ci-cancel-run';
    const cancelWorkers = [
      worker('thermal', { complexity: 'heavy' }),
      worker('power_integrity', { complexity: 'heavy' }),
      worker('control_latency', { complexity: 'heavy' }),
      worker('can_fd', { complexity: 'heavy' }),
    ];
    cancellations.set(supervisorRunId, { cancelled: false });
    writeSse(res, { type: 'RUN_STARTED', threadId, runId });
    writeSse(
      res,
      snapshot({
        bridgeRunId: runId,
        supervisorRunId,
        running: true,
        workers: cancelWorkers.map((item) => ({
          ...item,
          status: 'running',
          action: 'WORK',
          phase: 'worker',
        })),
      }),
    );

    const cancelled = await waitUntil(
      () => cancellations.get(supervisorRunId)?.cancelled === true,
    );
    if (!cancelled) {
      writeSse(res, {
        type: 'RUN_ERROR',
        code: 'SUPERVISOR_CANCEL_TIMEOUT',
        message: 'Mock cancellation was not received.',
      });
      cancellations.delete(supervisorRunId);
      res.end();
      return;
    }

    const cancelFinal = snapshot({
      bridgeRunId: runId,
      supervisorRunId,
      running: false,
      cancelled: true,
      workers: cancelWorkers,
    });
    threadSnapshots.set(threadId, cancelFinal.snapshot);
    writeSse(res, cancelFinal);
    writeSse(res, {
      type: 'RUN_ERROR',
      code: 'SUPERVISOR_CANCELLED',
      message: 'Supervisor workflow was cancelled by the OpenDots user.',
    });
    cancellations.delete(supervisorRunId);
    res.end();
    return;
  }

  let supervisorRunId = 'ci-supervisor-run';
  let workers = [
    worker('planner'),
    worker('worker', { dependsOn: ['planner'] }),
  ];
  let customEvents = [custom('sv.cache.miss', 'worker', { key: 'ci-key' })];
  let eventCounts = { CACHE_MISS: 1, WORKFLOW_PHASE: 2 };

  if (isDagCacheSoak) {
    dagCacheSoakRuns += 1;
    supervisorRunId = `ci-dag-cache-run-${dagCacheSoakRuns}`;
    workers = [
      worker('light_calc'),
      worker('light_sort'),
      worker('heavy_logic', { complexity: 'heavy' }),
      worker('heavy_design_review', { complexity: 'heavy' }),
    ];
    if (dagCacheSoakRuns === 1) {
      customEvents = [
        custom('sv.plan.cache.miss', '', {
          key: 'ci-dag-plan-key',
          reason: 'not_found',
        }),
        custom('sv.plan.cache.store', '', {
          key: 'ci-dag-plan-key',
          workers: 4,
        }),
        ...workers.flatMap((item) => [
          custom('sv.cache.miss', item.id, {
            key: `ci-dag-${item.id}-key`,
          }),
          custom('sv.cache.store', item.id, {
            key: `ci-dag-${item.id}-key`,
          }),
        ]),
      ];
      eventCounts = {
        PLAN_CACHE_MISS: 1,
        PLAN_CACHE_STORE: 1,
        CACHE_MISS: 4,
        CACHE_STORE: 4,
        EVIDENCE_RECORDED: 4,
      };
    } else {
      customEvents = [
        custom('sv.plan.cache.hit', '', {
          key: 'ci-dag-plan-key',
          workers: 4,
        }),
        ...workers.map((item) =>
          custom('sv.cache.hit', item.id, {
            key: `ci-dag-${item.id}-key`,
            source_run_id: 'ci-dag-cache-run-1',
          }),
        ),
      ];
      eventCounts = {
        PLAN_CACHE_HIT: 1,
        CACHE_HIT: 4,
        EVIDENCE_RECORDED: 4,
      };
    }
  } else if (isPlanCacheSoak) {
    planCacheSoakRuns += 1;
    supervisorRunId = `ci-plan-cache-run-${planCacheSoakRuns}`;
    workers = [worker('calc_small'), worker('format_small')];
    if (planCacheSoakRuns === 1) {
      customEvents = [
        custom('sv.plan.cache.miss', '', {
          key: 'ci-plan-key',
          reason: 'not_found',
        }),
        custom('sv.plan.cache.store', '', {
          key: 'ci-plan-key',
          workers: 2,
        }),
        custom('sv.cache.miss', 'calc_small', { key: 'ci-calc-key' }),
        custom('sv.cache.store', 'calc_small', { key: 'ci-calc-key' }),
        custom('sv.cache.miss', 'format_small', { key: 'ci-format-key' }),
        custom('sv.cache.store', 'format_small', { key: 'ci-format-key' }),
      ];
      eventCounts = {
        PLAN_CACHE_MISS: 1,
        PLAN_CACHE_STORE: 1,
        CACHE_MISS: 2,
        CACHE_STORE: 2,
      };
    } else {
      customEvents = [
        custom('sv.plan.cache.hit', '', {
          key: 'ci-plan-key',
          workers: 2,
        }),
        custom('sv.cache.hit', 'calc_small', {
          key: 'ci-calc-key',
          source_run_id: 'ci-plan-cache-run-1',
        }),
        custom('sv.cache.hit', 'format_small', {
          key: 'ci-format-key',
          source_run_id: 'ci-plan-cache-run-1',
        }),
      ];
      eventCounts = {
        PLAN_CACHE_HIT: 1,
        CACHE_HIT: 2,
      };
    }
  }

  const runningSnapshot = snapshot({
    bridgeRunId: runId,
    supervisorRunId,
    running: true,
    eventCounts,
    workers: workers.map((item) => ({
      ...item,
      status: item.id === 'planner' ? 'running' : 'waiting',
      action: item.id === 'planner' ? 'PLAN' : 'WAIT',
      phase: item.id === 'planner' ? 'planning' : 'dag',
      waitingFor: item.dependsOn,
    })),
  });
  const finalSnapshot = snapshot({
    bridgeRunId: runId,
    supervisorRunId,
    running: false,
    eventCounts,
    workers,
  });
  threadSnapshots.set(threadId, finalSnapshot.snapshot);

  const events = [
    { type: 'RUN_STARTED', threadId, runId },
    runningSnapshot,
    ...customEvents,
    { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: 'ci-mock-ok' },
    { type: 'TEXT_MESSAGE_END', messageId },
    finalSnapshot,
    { type: 'RUN_FINISHED', threadId, runId },
  ];

  for (const event of events) writeSse(res, event);
  res.end();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`CI Supervisor AG-UI mock listening on ${port}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
