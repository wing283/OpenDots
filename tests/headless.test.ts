import { expect, it } from 'vitest';
import {
  currentTurnText,
  runSupervisorThreadTurn,
} from '../src/server/headless.js';
it('rejects a swallowed SDK failure rather than reusing a previous answer', () => {
  expect(() => currentTurnText([], new Error('Provider failed'))).toThrow(
    'Provider failed',
  );
  expect(() => currentTurnText([])).toThrow('current compute turn');
  expect(
    currentTurnText([
      { id: 'new', role: 'assistant', content: 'Current answer' },
    ]),
  ).toBe('Current answer');
});


it('runs a headless Supervisor AG-UI turn and returns its durable run id', async () => {
  const fetchMock = async (_url: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body || '{}'));
    expect(request.threadId).toBe('thread-headless');
    expect(request.messages.at(-1)).toMatchObject({
      id: 'user-headless',
      role: 'user',
      content: 'Run headless work.',
    });
    const events = [
      {
        type: 'RUN_STARTED',
        threadId: 'thread-headless',
        runId: 'bridge-headless',
      },
      {
        type: 'STATE_SNAPSHOT',
        snapshot: {
          bridge: 'supervisor-agui',
          bridgeRunId: 'bridge-headless',
          supervisorRunId: 'sv-headless',
          running: true,
          workers: [],
          eventCounts: {},
        },
      },
      {
        type: 'TEXT_MESSAGE_START',
        messageId: 'assistant-headless',
        role: 'assistant',
      },
      {
        type: 'TEXT_MESSAGE_CONTENT',
        messageId: 'assistant-headless',
        delta: 'Headless Supervisor answer.',
      },
      { type: 'TEXT_MESSAGE_END', messageId: 'assistant-headless' },
      {
        type: 'STATE_SNAPSHOT',
        snapshot: {
          bridge: 'supervisor-agui',
          bridgeRunId: 'bridge-headless',
          supervisorRunId: 'sv-headless',
          running: false,
          workers: [],
          eventCounts: {},
        },
      },
      {
        type: 'RUN_FINISHED',
        threadId: 'thread-headless',
        runId: 'bridge-headless',
      },
    ];
    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };

  const result = await runSupervisorThreadTurn(
    'http://127.0.0.1:8791/',
    undefined,
    'supervisor',
    'thread-headless',
    [
      {
        id: 'user-headless',
        role: 'user',
        content: 'Run headless work.',
      },
    ],
    new AbortController().signal,
    fetchMock,
  );

  expect(result).toEqual({
    text: 'Headless Supervisor answer.',
    supervisorRunId: 'sv-headless',
  });
});
