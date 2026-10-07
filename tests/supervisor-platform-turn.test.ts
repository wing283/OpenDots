import { afterEach, expect, it, vi } from 'vitest';
import { Platform } from '../src/server/platform.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

afterEach(() => vi.unstubAllGlobals());

it('journals a headless Supervisor turn for scheduled follow-up context', async () => {
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

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body || '{}'));
        expect(request.threadId).toBe(thread.id);
        expect(request.messages.at(-1)).toMatchObject({
          role: 'user',
          content: 'Scheduled Supervisor work.',
        });
        const events = [
          {
            type: 'RUN_STARTED',
            threadId: thread.id,
            runId: 'bridge-scheduled',
          },
          {
            type: 'STATE_SNAPSHOT',
            snapshot: {
              bridge: 'supervisor-agui',
              bridgeRunId: 'bridge-scheduled',
              supervisorRunId: 'sv-scheduled',
              running: true,
              workers: [],
              eventCounts: {},
            },
          },
          {
            type: 'TEXT_MESSAGE_START',
            messageId: 'assistant-scheduled',
            role: 'assistant',
          },
          {
            type: 'TEXT_MESSAGE_CONTENT',
            messageId: 'assistant-scheduled',
            delta: 'Scheduled Supervisor answer.',
          },
          { type: 'TEXT_MESSAGE_END', messageId: 'assistant-scheduled' },
          {
            type: 'STATE_SNAPSHOT',
            snapshot: {
              bridge: 'supervisor-agui',
              bridgeRunId: 'bridge-scheduled',
              supervisorRunId: 'sv-scheduled',
              running: false,
              workers: [],
              eventCounts: {},
            },
          },
          {
            type: 'RUN_FINISHED',
            threadId: thread.id,
            runId: 'bridge-scheduled',
          },
        ];
        return new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }),
    );

    const text = await platform.turn(
      thread.id,
      'Scheduled Supervisor work.',
      new AbortController().signal,
    );

    expect(text).toBe('Scheduled Supervisor answer.');
    const messages = workspace.supervisorMessages(thread.id);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: 'Scheduled Supervisor work.',
    });
    expect(messages[1]).toMatchObject({
      id: 'supervisor-recovery:sv-scheduled:final',
      role: 'assistant',
      content: 'Scheduled Supervisor answer.',
    });
    expect(await platform.history(thread.id)).toContain(
      'assistant: Scheduled Supervisor answer.',
    );
  } finally {
    workspace.close();
    store.close();
  }
});
