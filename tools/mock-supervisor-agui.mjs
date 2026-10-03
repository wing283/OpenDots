import http from 'node:http';

const port = Number(process.env.MOCK_SUPERVISOR_PORT || 28793);
let planCacheSoakRuns = 0;

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

function worker(id, dependsOn = []) {
  return {
    id,
    title: id,
    status: 'stopped',
    action: 'COMPLETE',
    phase: 'complete',
    provider: 'mock',
    model: 'mock',
    complexity: 'light',
    mode: 'read_only',
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

  let supervisorRunId = 'ci-supervisor-run';
  let workers = [worker('planner'), worker('worker', ['planner'])];
  let customEvents = [custom('sv.cache.miss', 'worker', { key: 'ci-key' })];
  let eventCounts = { CACHE_MISS: 1, WORKFLOW_PHASE: 2 };

  if (isPlanCacheSoak) {
    planCacheSoakRuns += 1;
    supervisorRunId = `ci-plan-cache-run-${planCacheSoakRuns}`;
    workers = [worker('calc_small'), worker('format_small')];
    if (planCacheSoakRuns === 1) {
      customEvents = [
        custom('sv.plan.cache.miss', '', { key: 'ci-plan-key', reason: 'not_found' }),
        custom('sv.plan.cache.store', '', { key: 'ci-plan-key', workers: 2 }),
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
        custom('sv.plan.cache.hit', '', { key: 'ci-plan-key', workers: 2 }),
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

  const events = [
    { type: 'RUN_STARTED', threadId, runId },
    {
      type: 'STATE_SNAPSHOT',
      snapshot: {
        bridge: 'supervisor-agui',
        bridgeRunId: runId,
        supervisorRunId,
        supervisorPid: 4242,
        running: true,
        activeCount: 1,
        capacity: 3,
        eventCounts,
        workers: workers.map((item) => ({
          ...item,
          status: item.id === 'planner' ? 'running' : 'waiting',
          action: item.id === 'planner' ? 'PLAN' : 'WAIT',
          phase: item.id === 'planner' ? 'planning' : 'dag',
          waitingFor: item.dependsOn,
        })),
      },
    },
    ...customEvents,
    { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: 'ci-mock-ok' },
    { type: 'TEXT_MESSAGE_END', messageId },
    {
      type: 'STATE_SNAPSHOT',
      snapshot: {
        bridge: 'supervisor-agui',
        bridgeRunId: runId,
        supervisorRunId,
        supervisorPid: 4242,
        running: false,
        activeCount: 0,
        capacity: 3,
        eventCounts,
        workers,
      },
    },
    { type: 'RUN_FINISHED', threadId, runId },
  ];

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'close',
  });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`CI Supervisor AG-UI mock listening on ${port}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
