import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Platform } from '../src/server/platform.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

const config: PlatformConfig = {
  baseUrl: 'https://api.example.com/v1',
  runtimeUrl: 'http://127.0.0.1:4310/api/copilotkit',
  voiceName: 'marin',
  slackUsers: [],
};

it('saves Supervisor connection settings without returning the bearer token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-supervisor-config-'));
  const database = join(dir, 'workspace.sqlite');
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(database, 'owner');
  try {
    const platform = new Platform(store, workspace, { ...config });
    const dot = workspace.dots()[0];
    expect(() =>
      platform.updateSupervisorConnection({
        url: 'https://supervisor.example.com/',
        dotId: dot.id,
      }),
    ).toThrow('SUPERVISOR_AGUI_TOKEN is required');

    expect(
      platform.updateSupervisorConnection({
        url: 'https://supervisor.example.com/',
        dotId: dot.id,
        token: 'bridge-secret',
      }),
    ).toEqual({
      enabled: true,
      url: 'https://supervisor.example.com/',
      dotId: dot.id,
      tokenConfigured: true,
    });
    expect(workspace.supervisorConnection()).toMatchObject({
      enabled: true,
      token: 'bridge-secret',
    });

    workspace.close();
    const reopened = new WorkspaceStore(database, 'owner');
    const restartedConfig = { ...config };
    new Platform(store, reopened, restartedConfig);
    expect(restartedConfig).toMatchObject({
      supervisorAguiUrl: 'https://supervisor.example.com/',
      supervisorAguiToken: 'bridge-secret',
      supervisorDotId: dot.id,
    });

    const disabled = new Platform(store, reopened, restartedConfig);
    expect(
      disabled.updateSupervisorConnection({ url: '', dotId: '' }),
    ).toMatchObject({ enabled: false, tokenConfigured: false });
    expect(reopened.supervisorConnection()).toMatchObject({ enabled: false });
    reopened.close();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
