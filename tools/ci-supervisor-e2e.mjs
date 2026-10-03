import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ProxiedCopilotRuntimeAgent } from '@copilotkit/core';
import { WorkspaceStore } from '../src/server/workspace.ts';

const mockPort = 28799;
const appPort = 4319;
const root = await mkdtemp(join(tmpdir(), 'opendots-supervisor-ci-'));
const dbPath = join(root, 'workspace.sqlite');
const ownerId = 'ci-owner';

const workspace = new WorkspaceStore(dbPath, ownerId);
const supervisorDot = workspace.dots()[0];
if (!supervisorDot) throw new Error('Workspace did not create a default Dot.');
const dotId = supervisorDot.id;
workspace.close();

const children = [];

function start(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  children.push(child);
  return child;
}

async function waitFor(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

let agent;
let subscription;
try {
  start(process.execPath, ['tools/mock-supervisor-agui.mjs'], {
    MOCK_SUPERVISOR_PORT: String(mockPort),
  });
  await waitFor(`http://127.0.0.1:${mockPort}/health`);

  start(
    process.execPath,
    ['--import', 'tsx', 'src/server/index.ts'],
    {
      HOST: '127.0.0.1',
      PORT: String(appPort),
      DATABASE_PATH: dbPath,
      OWNER_ID: ownerId,
      SUPERVISOR_AGUI_URL: `http://127.0.0.1:${mockPort}/`,
      SUPERVISOR_DOT_ID: dotId,
      INTELLIGENCE_API_KEY: '',
      OPENAI_API_KEY: '',
      OPENAI_MODEL: '',
    },
  );

  const healthResponse = await waitFor(
    `http://127.0.0.1:${appPort}/api/supervisor/health`,
  );
  const health = await healthResponse.json();
  if (health.runReady !== true)
    throw new Error(`Supervisor health was not run-ready: ${JSON.stringify(health)}`);

  const conversationResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/conversations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dotId,
        title: 'CI Supervisor mock E2E',
      }),
    },
  );
  if (!conversationResponse.ok)
    throw new Error(
      `Conversation creation failed: ${conversationResponse.status} ${await conversationResponse.text()}`,
    );
  const conversation = await conversationResponse.json();

  agent = new ProxiedCopilotRuntimeAgent({
    runtimeUrl: `http://127.0.0.1:${appPort}/api/copilotkit`,
    agentId: `ci-local-${randomUUID()}`,
    runtimeAgentId: dotId,
  });
  agent.threadId = conversation.id;
  agent.setState({
    workers: 2,
    maxParallel: 2,
    verify: false,
    synthesize: false,
  });
  agent.addMessage({
    id: randomUUID(),
    role: 'user',
    content: 'CI mock integration turn',
  });

  let snapshot = {};
  let runError = null;
  const custom = [];
  subscription = agent.subscribe({
    onStateSnapshotEvent: ({ event }) => {
      if (event.snapshot?.bridge === 'supervisor-agui')
        snapshot = event.snapshot;
    },
    onCustomEvent: ({ event }) => custom.push(event),
    onRunErrorEvent: ({ event }) => {
      runError = {
        code: event.code || '',
        message: event.message || '',
      };
    },
  });

  const result = await agent.runAgent();

  if (runError)
    throw new Error(`Unexpected RUN_ERROR: ${JSON.stringify(runError)}`);
  if (snapshot.running !== false)
    throw new Error(`Final snapshot did not stop: ${JSON.stringify(snapshot)}`);
  if (snapshot.supervisorRunId !== 'ci-supervisor-run')
    throw new Error('Supervisor run id did not traverse the runtime.');

  const workers = Array.isArray(snapshot.workers) ? snapshot.workers : [];
  const planner = workers.find((worker) => worker.id === 'planner');
  const worker = workers.find((item) => item.id === 'worker');
  if (!planner || !worker)
    throw new Error(`Expected DAG workers missing: ${JSON.stringify(workers)}`);
  if (JSON.stringify(worker.dependsOn) !== JSON.stringify(['planner']))
    throw new Error(`DAG dependency was lost: ${JSON.stringify(worker)}`);
  if (!custom.some((event) => event.name === 'sv.cache.miss'))
    throw new Error('Supervisor custom cache event did not traverse CopilotKit SSE.');

  const messages = result.newMessages || [];
  if (!messages.some((message) => String(message.content || '').includes('ci-mock-ok')))
    throw new Error(`Assistant result missing: ${JSON.stringify(messages)}`);

  console.log(
    JSON.stringify(
      {
        pass: true,
        dotId,
        threadId: conversation.id,
        supervisorRunId: snapshot.supervisorRunId,
        workers: workers.map((item) => ({
          id: item.id,
          status: item.status,
          dependsOn: item.dependsOn,
        })),
        customEvents: custom.map((event) => event.name),
        assistantMessages: messages.length,
      },
      null,
      2,
    ),
  );
} finally {
  subscription?.unsubscribe();
  if (agent) await agent.detachActiveRun().catch(() => {});
  for (const child of [...children].reverse()) await stop(child);
  await rm(root, { recursive: true, force: true });
}
