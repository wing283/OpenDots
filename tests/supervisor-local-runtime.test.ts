import { afterEach, expect, it } from 'vitest';
import { Platform } from '../src/server/platform.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import type { PlatformConfig } from '../src/server/platform-config.js';

const stores: Array<{ store: Store; workspace: WorkspaceStore }> = [];

function fixture() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  stores.push({ store, workspace });
  const supervisor = workspace.dots()[0]!;
  const config: PlatformConfig = {
    baseUrl: 'https://api.openai.com/v1',
    runtimeUrl: 'http://127.0.0.1:4310/api/copilotkit',
    voiceName: 'marin',
    slackUsers: [],
    supervisorAguiUrl: 'http://127.0.0.1:8791/',
    supervisorDotId: supervisor.id,
  };
  const platform = new Platform(store, workspace, config);
  return { store, workspace, supervisor, platform };
}

afterEach(() => {
  for (const item of stores.splice(0)) {
    item.workspace.close();
    item.store.close();
  }
});

it('creates an SSE runtime for the external Supervisor Dot without Intelligence', async () => {
  const { platform, supervisor } = fixture();
  expect(platform.handler).toBeDefined();
  expect(platform.intelligence).toBeUndefined();
  expect(platform.setup().missing).toEqual([
    'INTELLIGENCE_API_KEY',
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
  ]);
  expect(platform.missingForDot(supervisor.id)).toEqual([]);

  const thread = await platform.createConversation(
    supervisor.id,
    'Local Supervisor',
  );
  expect(thread.dotId).toBe(supervisor.id);
  expect(platform.workspace.requireThread(thread.id).title).toBe(
    'Local Supervisor',
  );
});

it('keeps ordinary Dots setup-gated when only Supervisor is external', async () => {
  const { platform, workspace, supervisor } = fixture();
  const ordinary = workspace.createDot(
    supervisor.spaceId,
    'Ordinary',
    'Use the built-in model.',
    true,
    true,
  );
  expect(platform.missingForDot(ordinary.id)).toContain('INTELLIGENCE_API_KEY');
  await expect(
    platform.createConversation(ordinary.id, 'Should fail'),
  ).rejects.toThrow(/Setup required/);
});
