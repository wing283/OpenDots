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

async function runCaptured(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  return { code, stdout, stderr };
}

async function runSoakMode(mode, dotId, appPort, workspacePath = '') {
  const args = [
    'tools/soak-supervisor-integration.mjs',
    '--base',
    `http://127.0.0.1:${appPort}`,
    '--runtime',
    `http://127.0.0.1:${appPort}/api/copilotkit`,
    '--agent-id',
    dotId,
    '--mode',
    mode,
  ];
  if (workspacePath) args.push('--workspace', workspacePath);
  const processResult = await runCaptured(process.execPath, args);
  if (processResult.code !== 0)
    throw new Error(
      `${mode} soak process failed with ${processResult.code}: ${processResult.stderr}`,
    );
  return JSON.parse(processResult.stdout.trim());
}

async function createSupervisorRun(title, prompt) {
  const response = await fetch(
    `http://127.0.0.1:${appPort}/api/conversations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dotId, title }),
    },
  );
  if (!response.ok)
    throw new Error(
      `Conversation creation failed: ${response.status} ${await response.text()}`,
    );
  const conversation = await response.json();
  const runAgent = new ProxiedCopilotRuntimeAgent({
    runtimeUrl: `http://127.0.0.1:${appPort}/api/copilotkit`,
    agentId: `ci-recovery-action-${randomUUID()}`,
    runtimeAgentId: dotId,
  });
  runAgent.threadId = conversation.id;
  runAgent.addMessage({
    id: randomUUID(),
    role: 'user',
    content: prompt,
  });
  return { conversation, runAgent };
}

async function waitThreadState(threadId, predicate, label) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await fetch(
      `http://127.0.0.1:${appPort}/api/supervisor/thread-status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId }),
      },
    );
    if (response.ok) {
      const body = await response.json();
      if (predicate(body)) return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for Supervisor thread state: ${label}`);
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
    MOCK_SUPERVISOR_WORKSPACE: root,
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

  const restoredResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/supervisor/thread-status`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: conversation.id }),
    },
  );
  if (!restoredResponse.ok)
    throw new Error(
      `Supervisor thread restore failed: ${restoredResponse.status} ${await restoredResponse.text()}`,
    );
  const restoredThread = await restoredResponse.json();
  if (restoredThread.snapshot?.supervisorRunId !== 'ci-supervisor-run')
    throw new Error(
      `Restored Supervisor run id mismatch: ${JSON.stringify(restoredThread)}`,
    );
  if (restoredThread.snapshot?.running !== false)
    throw new Error(
      `Restored Supervisor terminal snapshot was not stopped: ${JSON.stringify(restoredThread)}`,
    );

  const recoveryConversationResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/conversations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dotId,
        title: 'CI Supervisor active recovery',
      }),
    },
  );
  if (!recoveryConversationResponse.ok)
    throw new Error(
      `Recovery conversation creation failed: ${recoveryConversationResponse.status} ${await recoveryConversationResponse.text()}`,
    );
  const recoveryConversation = await recoveryConversationResponse.json();
  const recoveryAgent = new ProxiedCopilotRuntimeAgent({
    runtimeUrl: `http://127.0.0.1:${appPort}/api/copilotkit`,
    agentId: `ci-recovery-${randomUUID()}`,
    runtimeAgentId: dotId,
  });
  recoveryAgent.threadId = recoveryConversation.id;
  recoveryAgent.addMessage({
    id: randomUUID(),
    role: 'user',
    content: 'CI Supervisor recovery hold',
  });
  const recoveryRun = recoveryAgent.runAgent();

  let activeRestore = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await fetch(
      `http://127.0.0.1:${appPort}/api/supervisor/thread-status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId: recoveryConversation.id }),
      },
    );
    if (response.ok) {
      const body = await response.json();
      if (body.snapshot?.running === true) {
        activeRestore = body;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!activeRestore)
    throw new Error('Active Supervisor recovery snapshot was not observed.');
  if (
    activeRestore.bindingStatus !== 'active' ||
    activeRestore.correlationState !== 'matched' ||
    activeRestore.snapshot?.supervisorRunId !== 'ci-recovery-active-run'
  )
    throw new Error(
      `Active recovery mismatch: ${JSON.stringify(activeRestore)}`,
    );

  const releaseResponse = await fetch(
    `http://127.0.0.1:${mockPort}/ci/release-recovery`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: recoveryConversation.id }),
    },
  );
  if (!releaseResponse.ok)
    throw new Error(
      `Recovery release failed: ${releaseResponse.status} ${await releaseResponse.text()}`,
    );
  const recoveryResult = await recoveryRun;
  if (
    !recoveryResult.newMessages?.some((message) =>
      String(message.content || '').includes('ci-recovery-ok'),
    )
  )
    throw new Error(
      `Recovery completion message missing: ${JSON.stringify(recoveryResult.newMessages)}`,
    );

  const terminalRecoveryResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/supervisor/thread-status`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: recoveryConversation.id }),
    },
  );
  if (!terminalRecoveryResponse.ok)
    throw new Error(
      `Terminal recovery lookup failed: ${terminalRecoveryResponse.status} ${await terminalRecoveryResponse.text()}`,
    );
  const terminalRecovery = await terminalRecoveryResponse.json();
  if (
    terminalRecovery.snapshot?.running !== false ||
    terminalRecovery.bindingStatus !== 'finished' ||
    terminalRecovery.finalMessage?.id !==
      'supervisor-recovery:ci-recovery-active-run:final' ||
    terminalRecovery.finalMessage?.role !== 'assistant' ||
    terminalRecovery.finalMessage?.content !== 'ci-recovery-ok'
  )
    throw new Error(
      `Terminal recovery mismatch: ${JSON.stringify(terminalRecovery)}`,
    );
  await recoveryAgent.detachActiveRun().catch(() => {});

  const writerPrompt = [
    'Create exactly one worker. It must be mode=writer and complexity=light.',
    'Modify exactly OPENDOTS_SOAK_WRITER_MARKER.txt in the current working directory.',
    'The complete file content must be exactly: OPENDOTS_WRITER_APPROVED',
    'Do not modify any other file.',
  ].join('\n');

  await rm(join(root, 'OPENDOTS_SOAK_WRITER_MARKER.txt'), { force: true });
  const reloadApproval = await createSupervisorRun(
    'CI writer approval after reload',
    writerPrompt,
  );
  let reloadApprovalError = null;
  const reloadApprovalSub = reloadApproval.runAgent.subscribe({
    onRunErrorEvent: ({ event }) => {
      reloadApprovalError = {
        code: event.code || '',
        message: event.message || '',
      };
    },
  });
  const reloadApprovalRun = reloadApproval.runAgent.runAgent();
  const pendingApproval = await waitThreadState(
    reloadApproval.conversation.id,
    (body) =>
      body.snapshot?.running === true &&
      body.snapshot?.approval?.status === 'pending',
    'writer approval pending',
  );
  const approveAfterReload = await fetch(
    `http://127.0.0.1:${appPort}/api/supervisor/approval`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        threadId: reloadApproval.conversation.id,
        supervisorRunId: pendingApproval.snapshot.supervisorRunId,
        decision: 'approve',
      }),
    },
  );
  if (!approveAfterReload.ok)
    throw new Error(
      `Approval after reload failed: ${approveAfterReload.status} ${await approveAfterReload.text()}`,
    );
  await reloadApprovalRun;
  reloadApprovalSub.unsubscribe();
  if (reloadApprovalError)
    throw new Error(
      `Approval-after-reload run failed: ${JSON.stringify(reloadApprovalError)}`,
    );
  const approvedAfterReload = await waitThreadState(
    reloadApproval.conversation.id,
    (body) =>
      body.snapshot?.running === false &&
      body.snapshot?.approval?.status === 'approved',
    'writer approved terminal state',
  );
  if (
    approvedAfterReload.finalMessage?.content !== 'ci-writer-approved' ||
    approvedAfterReload.snapshot?.supervisorRunId !==
      pendingApproval.snapshot?.supervisorRunId
  )
    throw new Error(
      `Approval-after-reload recovery mismatch: ${JSON.stringify(approvedAfterReload)}`,
    );
  await reloadApproval.runAgent.detachActiveRun().catch(() => {});
  await rm(join(root, 'OPENDOTS_SOAK_WRITER_MARKER.txt'), { force: true });

  const reloadDecline = await createSupervisorRun(
    'CI writer decline after reload',
    writerPrompt,
  );
  let reloadDeclineError = null;
  const reloadDeclineSub = reloadDecline.runAgent.subscribe({
    onRunErrorEvent: ({ event }) => {
      reloadDeclineError = {
        code: event.code || '',
        message: event.message || '',
      };
    },
  });
  const reloadDeclineRun = reloadDecline.runAgent.runAgent();
  const pendingDecline = await waitThreadState(
    reloadDecline.conversation.id,
    (body) =>
      body.snapshot?.running === true &&
      body.snapshot?.approval?.status === 'pending',
    'writer decline pending',
  );
  const declineAfterReload = await fetch(
    `http://127.0.0.1:${appPort}/api/supervisor/approval`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        threadId: reloadDecline.conversation.id,
        supervisorRunId: pendingDecline.snapshot.supervisorRunId,
        decision: 'decline',
      }),
    },
  );
  if (!declineAfterReload.ok)
    throw new Error(
      `Decline after reload failed: ${declineAfterReload.status} ${await declineAfterReload.text()}`,
    );
  await reloadDeclineRun;
  reloadDeclineSub.unsubscribe();
  if (reloadDeclineError?.code !== 'SUPERVISOR_APPROVAL_DECLINED')
    throw new Error(
      `Decline-after-reload error mismatch: ${JSON.stringify(reloadDeclineError)}`,
    );
  const declinedAfterReload = await waitThreadState(
    reloadDecline.conversation.id,
    (body) =>
      body.snapshot?.running === false &&
      body.snapshot?.approval?.status === 'declined',
    'writer declined terminal state',
  );
  if (
    declinedAfterReload.bindingStatus !== 'declined' ||
    declinedAfterReload.snapshot?.supervisorRunId !==
      pendingDecline.snapshot?.supervisorRunId
  )
    throw new Error(
      `Decline-after-reload recovery mismatch: ${JSON.stringify(declinedAfterReload)}`,
    );
  await reloadDecline.runAgent.detachActiveRun().catch(() => {});

  const cancelPrompt = [
    'Create four independent heavy read_only engineering-analysis workers.',
    'Each worker must perform a distinct multi-step trade study of a hypothetical 24 V robot servo: thermal, power integrity, control latency, and CAN-FD robustness.',
    'Do not modify files or perform external actions.',
    'Provide detailed evidence-backed reasoning in every worker.',
  ].join('\n');
  const reloadCancel = await createSupervisorRun(
    'CI cancel after reload',
    cancelPrompt,
  );
  let reloadCancelError = null;
  const reloadCancelSub = reloadCancel.runAgent.subscribe({
    onRunErrorEvent: ({ event }) => {
      reloadCancelError = {
        code: event.code || '',
        message: event.message || '',
      };
    },
  });
  const reloadCancelRun = reloadCancel.runAgent.runAgent();
  const activeCancel = await waitThreadState(
    reloadCancel.conversation.id,
    (body) =>
      body.snapshot?.running === true &&
      Boolean(body.snapshot?.supervisorRunId),
    'cancel active state',
  );
  const cancelAfterReload = await fetch(
    `http://127.0.0.1:${appPort}/api/supervisor/cancel`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        threadId: reloadCancel.conversation.id,
        supervisorRunId: activeCancel.snapshot.supervisorRunId,
        supervisorPid: activeCancel.snapshot.supervisorPid,
      }),
    },
  );
  if (!cancelAfterReload.ok)
    throw new Error(
      `Cancel after reload failed: ${cancelAfterReload.status} ${await cancelAfterReload.text()}`,
    );
  await reloadCancelRun;
  reloadCancelSub.unsubscribe();
  if (reloadCancelError?.code !== 'SUPERVISOR_CANCELLED')
    throw new Error(
      `Cancel-after-reload error mismatch: ${JSON.stringify(reloadCancelError)}`,
    );
  const cancelledAfterReload = await waitThreadState(
    reloadCancel.conversation.id,
    (body) =>
      body.snapshot?.running === false && body.snapshot?.cancelled === true,
    'cancelled terminal state',
  );
  if (
    cancelledAfterReload.bindingStatus !== 'cancelled' ||
    cancelledAfterReload.snapshot?.supervisorRunId !==
      activeCancel.snapshot?.supervisorRunId
  )
    throw new Error(
      `Cancel-after-reload recovery mismatch: ${JSON.stringify(cancelledAfterReload)}`,
    );
  await reloadCancel.runAgent.detachActiveRun().catch(() => {});

  const planCacheSoak = await runSoakMode(
    'plan-cache-small',
    dotId,
    appPort,
  );
  if (planCacheSoak.planCacheSmallVerdict?.pass !== true)
    throw new Error(
      `Plan-cache soak verdict failed: ${JSON.stringify(planCacheSoak.planCacheSmallVerdict)}`,
    );

  const dagCacheSoak = await runSoakMode('dag-cache', dotId, appPort);
  if (dagCacheSoak.dagCacheVerdict?.pass !== true)
    throw new Error(
      `DAG cache soak verdict failed: ${JSON.stringify(dagCacheSoak.dagCacheVerdict)}`,
    );

  const writerSoak = await runSoakMode(
    'writer-approval',
    dotId,
    appPort,
    root,
  );
  if (writerSoak.writerApprovalVerdict?.pass !== true)
    throw new Error(
      `Writer approval soak verdict failed: ${JSON.stringify(writerSoak.writerApprovalVerdict)}`,
    );

  const writerDeclineSoak = await runSoakMode(
    'writer-decline',
    dotId,
    appPort,
    root,
  );
  if (writerDeclineSoak.writerDeclineVerdict?.pass !== true)
    throw new Error(
      `Writer decline soak verdict failed: ${JSON.stringify(writerDeclineSoak.writerDeclineVerdict)}`,
    );

  const declinedRestoreResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/supervisor/thread-status`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        threadId: writerDeclineSoak.writerDecline.threadId,
      }),
    },
  );
  if (!declinedRestoreResponse.ok)
    throw new Error(
      `Declined thread restore failed: ${declinedRestoreResponse.status} ${await declinedRestoreResponse.text()}`,
    );
  const declinedRestore = await declinedRestoreResponse.json();
  if (
    declinedRestore.bindingStatus !== 'declined' ||
    declinedRestore.snapshot?.approval?.status !== 'declined' ||
    declinedRestore.snapshot?.running !== false
  )
    throw new Error(
      `Declined thread restore mismatch: ${JSON.stringify(declinedRestore)}`,
    );

  const cancelSoak = await runSoakMode('cancel', dotId, appPort);
  if (cancelSoak.cancelVerdict?.pass !== true)
    throw new Error(
      `Cancel soak verdict failed: ${JSON.stringify(cancelSoak.cancelVerdict)}`,
    );

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
        restoredThread: {
          bindingStatus: restoredThread.bindingStatus,
          correlationState: restoredThread.correlationState,
          supervisorRunId: restoredThread.snapshot?.supervisorRunId,
          running: restoredThread.snapshot?.running,
        },
        activeRecovery: {
          bindingStatus: activeRestore.bindingStatus,
          correlationState: activeRestore.correlationState,
          supervisorRunId: activeRestore.snapshot?.supervisorRunId,
          running: activeRestore.snapshot?.running,
        },
        terminalRecovery: {
          bindingStatus: terminalRecovery.bindingStatus,
          correlationState: terminalRecovery.correlationState,
          supervisorRunId: terminalRecovery.snapshot?.supervisorRunId,
          running: terminalRecovery.snapshot?.running,
          finalMessageId: terminalRecovery.finalMessage?.id,
        },
        reloadHitlRecovery: {
          approval: {
            runId: approvedAfterReload.snapshot?.supervisorRunId,
            status: approvedAfterReload.snapshot?.approval?.status,
            finalMessageId: approvedAfterReload.finalMessage?.id,
          },
          decline: {
            runId: declinedAfterReload.snapshot?.supervisorRunId,
            status: declinedAfterReload.snapshot?.approval?.status,
            errorCode: reloadDeclineError?.code,
          },
          cancel: {
            runId: cancelledAfterReload.snapshot?.supervisorRunId,
            cancelled: cancelledAfterReload.snapshot?.cancelled,
            errorCode: reloadCancelError?.code,
          },
        },
        planCacheSmallVerdict: planCacheSoak.planCacheSmallVerdict,
        dagCacheVerdict: dagCacheSoak.dagCacheVerdict,
        writerApprovalVerdict: writerSoak.writerApprovalVerdict,
        writerDeclineVerdict: writerDeclineSoak.writerDeclineVerdict,
        declinedRestore: {
          bindingStatus: declinedRestore.bindingStatus,
          correlationState: declinedRestore.correlationState,
          approvalStatus: declinedRestore.snapshot?.approval?.status,
          running: declinedRestore.snapshot?.running,
        },
        cancelVerdict: cancelSoak.cancelVerdict,
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
