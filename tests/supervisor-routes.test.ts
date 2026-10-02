import { afterEach, expect, it, vi } from 'vitest';
import { supervisorRoutes } from '../src/server/supervisor-routes.js';
import type { PlatformConfig } from '../src/server/platform-config.js';

const config: PlatformConfig = {
  baseUrl: 'https://example.com',
  runtimeUrl: 'http://127.0.0.1:4310/api/copilotkit',
  voiceName: 'marin',
  slackUsers: [],
  supervisorAguiUrl: 'http://127.0.0.1:8791/',
  supervisorAguiToken: 'test-token',
  supervisorDotId: 'supervisor',
};

afterEach(() => vi.unstubAllGlobals());

it('proxies approval to the configured bridge', async () => {
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
  const app = supervisorRoutes(config);
  const response = await app.request('/supervisor/approval', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ supervisorRunId: 'sv-1', decision: 'approve' }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    approval: { status: 'approved' },
  });
  expect(fetchMock).toHaveBeenCalledOnce();
  const [url] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
  expect(url.toString()).toBe('http://127.0.0.1:8791/approval');
});

it('rejects malformed approval before contacting the bridge', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const app = supervisorRoutes(config);
  const response = await app.request('/supervisor/approval', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ supervisorRunId: '', decision: 'yes' }),
  });
  expect(response.status).toBe(400);
  expect(fetchMock).not.toHaveBeenCalled();
});
