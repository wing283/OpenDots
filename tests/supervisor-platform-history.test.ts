import { expect, it } from 'vitest';
import { Platform } from '../src/server/platform.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

it('uses the local Supervisor journal as history without Intelligence', async () => {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  try {
    const dot = workspace.dots()[0];
    const config: PlatformConfig = {
      baseUrl: 'https://api.openai.com/v1',
      runtimeUrl: 'http://127.0.0.1:4310/api/copilotkit',
      voiceName: 'marin',
      slackUsers: [],
      supervisorAguiUrl: 'http://127.0.0.1:8791/',
      supervisorDotId: dot.id,
    };
    const platform = new Platform(store, workspace, config);
    const thread = await platform.createConversation(dot.id, 'Supervisor');
    workspace.appendSupervisorMessage(thread.id, {
      id: 'user-1',
      role: 'user',
      content: 'First Supervisor request.',
    });
    workspace.appendSupervisorMessage(thread.id, {
      id: 'assistant-1',
      role: 'assistant',
      content: 'First Supervisor answer.',
    });

    expect(await platform.history(thread.id)).toBe(
      'user: First Supervisor request.\nassistant: First Supervisor answer.',
    );
  } finally {
    workspace.close();
    store.close();
  }
});
