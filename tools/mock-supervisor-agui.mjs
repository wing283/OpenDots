import http from 'node:http';

const port = Number(process.env.MOCK_SUPERVISOR_PORT || 28793);

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const body = JSON.stringify({
      ok: true,
      bridgeReady: true,
      runReady: true,
      version: 'ci-mock',
      execution: { activeCount: 0, capacity: 3, missingRequiredEnv: [] },
    });
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  if (req.method !== 'POST' || !['/', '/run'].includes(req.url || '')) {
    res.writeHead(404).end();
    return;
  }

  let raw = '';
  for await (const chunk of req) raw += chunk;
  const input = raw ? JSON.parse(raw) : {};
  const threadId = String(input.threadId || 'ci-thread');
  const runId = String(input.runId || 'ci-run');
  const messageId = `${runId}-assistant`;

  const events = [
    { type: 'RUN_STARTED', threadId, runId },
    {
      type: 'STATE_SNAPSHOT',
      snapshot: {
        bridge: 'supervisor-agui',
        bridgeRunId: runId,
        supervisorRunId: 'ci-supervisor-run',
        supervisorPid: 4242,
        running: true,
        activeCount: 1,
        capacity: 3,
        eventCounts: { CACHE_MISS: 1 },
        workers: [
          {
            id: 'planner',
            title: 'Planner',
            status: 'running',
            action: 'PLAN',
            phase: 'planning',
            provider: 'mock',
            model: 'mock',
            complexity: 'light',
            mode: 'read_only',
            dependsOn: [],
            waitingFor: [],
            downstreamWaitingCount: 1,
            reason: '',
            costUsd: 0,
            tokens: 0,
          },
          {
            id: 'worker',
            title: 'Worker',
            status: 'waiting',
            action: 'WAIT',
            phase: 'dag',
            provider: 'mock',
            model: 'mock',
            complexity: 'light',
            mode: 'read_only',
            dependsOn: ['planner'],
            waitingFor: ['planner'],
            downstreamWaitingCount: 0,
            reason: '',
            costUsd: 0,
            tokens: 0,
          },
        ],
      },
    },
    {
      type: 'CUSTOM',
      name: 'sv.cache.miss',
      value: { payload: { key: 'ci-key' }, workerId: 'worker' },
    },
    { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: 'ci-mock-ok' },
    { type: 'TEXT_MESSAGE_END', messageId },
    {
      type: 'STATE_SNAPSHOT',
      snapshot: {
        bridge: 'supervisor-agui',
        bridgeRunId: runId,
        supervisorRunId: 'ci-supervisor-run',
        supervisorPid: 4242,
        running: false,
        activeCount: 0,
        capacity: 3,
        eventCounts: { CACHE_MISS: 1, WORKFLOW_PHASE: 2 },
        workers: [
          {
            id: 'planner',
            title: 'Planner',
            status: 'stopped',
            action: 'COMPLETE',
            phase: 'complete',
            provider: 'mock',
            model: 'mock',
            complexity: 'light',
            mode: 'read_only',
            dependsOn: [],
            waitingFor: [],
            downstreamWaitingCount: 1,
            reason: '',
            costUsd: 0,
            tokens: 0,
          },
          {
            id: 'worker',
            title: 'Worker',
            status: 'stopped',
            action: 'COMPLETE',
            phase: 'complete',
            provider: 'mock',
            model: 'mock',
            complexity: 'light',
            mode: 'read_only',
            dependsOn: ['planner'],
            waitingFor: [],
            downstreamWaitingCount: 0,
            reason: '',
            costUsd: 0,
            tokens: 0,
          },
        ],
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
