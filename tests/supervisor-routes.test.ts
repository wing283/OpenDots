import { afterEach, expect, it, vi } from 'vitest';
import { supervisorRoutes } from '../src/server/supervisor-routes.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { WorkspaceStore } from '../src/server/workspace.js';

function setup() {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const dot = workspace.dots()[0];
  if (!dot) throw new Error('Fixture Dot was not created.');
  const config: PlatformConfig = {
    baseUrl: 'https://example.com',
    runtimeUrl: 'http://127.0.0.1:4310/api/copilotkit',
    voiceName: 'marin',
    slackUsers: [],
    supervisorAguiUrl: 'http://127.0.0.1:8791/',
    supervisorAguiToken: 'test-token',
    supervisorDotId: dot.id,
  };
  return { workspace, config, dot };
}

afterEach(() => vi.unstubAllGlobals());

it('proxies approval only after thread/run scope validation', async () => {
  const { workspace, config, dot } = setup();
  try {
    workspace.bindThread('thread-approval', dot.id, 'Approval');
    const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname.endsWith('/thread-status')) {
        expect(JSON.parse(String(init?.body))).toEqual({
          threadId: 'thread-approval',
        });
        return Response.json({
          ok: true,
          snapshot: {
            bridge: 'supervisor-agui',
            supervisorRunId: 'sv-1',
            running: true,
          },
        });
      }
      expect(url.toString()).toBe('http://127.0.0.1:8791/approval');
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        supervisorRunId: 'sv-1',
        decision: 'approve',
      });
      return Response.json({ ok: true, approval: { status: 'approved' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = supervisorRoutes(config, workspace);
    const response = await app.request('/supervisor/approval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threadId: 'thread-approval',
        supervisorRunId: 'sv-1',
        decision: 'approve',
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      approval: { status: 'approved' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    workspace.close();
  }
});

it('proxies writer decline only for the bound conversation run', async () => {
  const { workspace, config, dot } = setup();
  try {
    workspace.bindThread('thread-decline', dot.id, 'Decline');
    const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname.endsWith('/thread-status'))
        return Response.json({
          ok: true,
          snapshot: {
            bridge: 'supervisor-agui',
            supervisorRunId: 'sv-decline',
            running: true,
          },
        });
      expect(url.toString()).toBe('http://127.0.0.1:8791/approval');
      expect(JSON.parse(String(init?.body))).toEqual({
        supervisorRunId: 'sv-decline',
        decision: 'decline',
      });
      return Response.json({
        ok: true,
        approval: { status: 'declined', decision: 'decline' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = supervisorRoutes(config, workspace);
    const response = await app.request('/supervisor/approval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threadId: 'thread-decline',
        supervisorRunId: 'sv-decline',
        decision: 'decline',
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      approval: { status: 'declined', decision: 'decline' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    workspace.close();
  }
});

it('rejects malformed approval before contacting the bridge', async () => {
  const { workspace, config } = setup();
  try {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const app = supervisorRoutes(config, workspace);
    const response = await app.request('/supervisor/approval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supervisorRunId: '', decision: 'yes' }),
    });
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    workspace.close();
  }
});

it('projects evidence only for the run bound to the Supervisor thread', async () => {
  const { workspace, config, dot } = setup();
  try {
    workspace.bindThread('thread-evidence', dot.id, 'Evidence');
    const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname.endsWith('/thread-status'))
        return Response.json({
          ok: true,
          snapshot: {
            bridge: 'supervisor-agui',
            supervisorRunId: 'sv-1',
            running: false,
          },
        });
      expect(url.toString()).toBe('http://127.0.0.1:8791/evidence');
      expect(JSON.parse(String(init?.body))).toEqual({
        supervisorRunId: 'sv-1',
      });
      return Response.json({
        ok: true,
        evidence: {
          runId: 'sv-1',
          totalCount: 2,
          truncated: false,
          items: [
            {
              id: 'EV-0001',
              category: 'dag_execution',
              source: 'dag_scheduler',
              trust: 'mechanical',
              capturedAt: '2026-10-02T12:00:00Z',
              sha256: 'abc',
              payloadPreview: '{"dag_completed":true}',
            },
          ],
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = supervisorRoutes(config, workspace);

    for (let i = 0; i < 2; i += 1) {
      const response = await app.request('/supervisor/evidence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId: 'thread-evidence',
          supervisorRunId: 'sv-1',
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        space: { name: 'Supervisor Evidence' },
        page: { title: 'Supervisor Run sv-1' },
        evidence: { totalCount: 2, truncated: false },
      });
    }

    const spaces = workspace
      .spaces()
      .filter((space) => space.name === 'Supervisor Evidence');
    expect(spaces).toHaveLength(1);
    const pages = workspace.pages.list(spaces[0].id);
    expect(pages).toHaveLength(1);
    expect(pages[0].revision).toBe(2);
    expect(pages[0].content).toContain('EV-0001');
    expect(pages[0].content).toContain('trust: mechanical');
    expect(workspace.dot(dot.id)?.spaceIds).toContain(spaces[0].id);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  } finally {
    workspace.close();
  }
});

it('proxies durable Supervisor thread status', async () => {
  const { workspace, config, dot } = setup();
  try {
    workspace.bindThread('thread-restore', dot.id, 'Restore');
    const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => {
      expect(url.toString()).toBe('http://127.0.0.1:8791/thread-status');
      expect(JSON.parse(String(init?.body))).toEqual({
        threadId: 'thread-restore',
      });
      return Response.json({
        ok: true,
        threadId: 'thread-restore',
        bindingStatus: 'active',
        correlationState: 'matched',
        snapshot: {
          bridge: 'supervisor-agui',
          supervisorRunId: 'sv-restore',
          running: true,
          workers: [],
          eventCounts: {},
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = supervisorRoutes(config, workspace);
    const response = await app.request('/supervisor/thread-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: 'thread-restore' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      bindingStatus: 'active',
      snapshot: {
        supervisorRunId: 'sv-restore',
        running: true,
      },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  } finally {
    workspace.close();
  }
});

it('rejects thread status for a conversation owned by another Dot', async () => {
  const { workspace, config, dot } = setup();
  try {
    const other = workspace.createDot(
      dot.spaceId,
      'Other',
      'Not the Supervisor Dot.',
      true,
      true,
    );
    workspace.bindThread('thread-other-dot', other.id, 'Other thread');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const app = supervisorRoutes(config, workspace);
    const response = await app.request('/supervisor/thread-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: 'thread-other-dot' }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: 'Supervisor thread does not belong to this Dot.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    workspace.close();
  }
});

it('rejects malformed Supervisor thread status requests locally', async () => {
  const { workspace, config } = setup();
  try {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const app = supervisorRoutes(config, workspace);
    const response = await app.request('/supervisor/thread-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: '' }),
    });
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    workspace.close();
  }
});

it('proxies cancel only after thread/run scope validation', async () => {
  const { workspace, config, dot } = setup();
  try {
    workspace.bindThread('thread-cancel', dot.id, 'Cancel');
    const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname.endsWith('/thread-status'))
        return Response.json({
          ok: true,
          snapshot: {
            bridge: 'supervisor-agui',
            supervisorRunId: 'sv-1',
            running: true,
          },
        });
      expect(url.toString()).toBe('http://127.0.0.1:8791/cancel');
      expect(JSON.parse(String(init?.body))).toEqual({
        supervisorRunId: 'sv-1',
        supervisorPid: 123,
      });
      return Response.json({
        ok: true,
        supervisorRunId: 'sv-1',
        supervisorPid: 123,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = supervisorRoutes(config, workspace);
    const response = await app.request('/supervisor/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threadId: 'thread-cancel',
        supervisorRunId: 'sv-1',
        supervisorPid: 123,
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      supervisorRunId: 'sv-1',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    workspace.close();
  }
});

it('rejects malformed cancel before contacting the bridge', async () => {
  const { workspace, config } = setup();
  try {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const app = supervisorRoutes(config, workspace);
    const response = await app.request('/supervisor/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supervisorRunId: '' }),
    });
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    workspace.close();
  }
});

it('rejects actions when the requested run is not bound to the thread', async () => {
  const { workspace, config, dot } = setup();
  try {
    workspace.bindThread('thread-mismatch', dot.id, 'Mismatch');
    const fetchMock = vi.fn(async (url: URL) => {
      expect(url.pathname).toBe('/thread-status');
      return Response.json({
        ok: true,
        snapshot: {
          bridge: 'supervisor-agui',
          supervisorRunId: 'sv-actual',
          running: true,
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = supervisorRoutes(config, workspace);
    const response = await app.request('/supervisor/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threadId: 'thread-mismatch',
        supervisorRunId: 'sv-other',
        supervisorPid: 999,
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: 'Supervisor run does not belong to this conversation.',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  } finally {
    workspace.close();
  }
});

it('proxies Supervisor bridge health with bearer auth', async () => {
  const { workspace, config } = setup();
  try {
    const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => {
      expect(url.toString()).toBe('http://127.0.0.1:8791/health');
      expect(init?.method).toBe('GET');
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer test-token',
      });
      return Response.json({
        ok: true,
        bridgeReady: true,
        runReady: false,
        version: '0.2',
        execution: {
          missingRequiredEnv: ['KIMI_API_KEY'],
          activeCount: 0,
          capacity: 3,
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = supervisorRoutes(config, workspace);
    const response = await app.request('/supervisor/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      bridgeReady: true,
      runReady: false,
      version: '0.2',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  } finally {
    workspace.close();
  }
});
