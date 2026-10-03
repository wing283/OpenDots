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

it('proxies approval to the configured bridge', async () => {
  const { workspace, config } = setup();
  try {
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
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
        supervisorRunId: 'sv-1',
        decision: 'approve',
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      approval: { status: 'approved' },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('http://127.0.0.1:8791/approval');
  } finally {
    workspace.close();
  }
});

it('proxies writer decline to the configured bridge', async () => {
  const { workspace, config } = setup();
  try {
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
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
        supervisorRunId: 'sv-decline',
        decision: 'decline',
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      approval: { status: 'declined', decision: 'decline' },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
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

it('projects evidence into one stable Space page per Supervisor run', async () => {
  const { workspace, config, dot } = setup();
  try {
    const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => {
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
        body: JSON.stringify({ supervisorRunId: 'sv-1' }),
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

it('proxies run-scoped cancel to the configured bridge', async () => {
  const { workspace, config } = setup();
  try {
    const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => {
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
        supervisorRunId: 'sv-1',
        supervisorPid: 123,
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      supervisorRunId: 'sv-1',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
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
