import { PageReviewCard } from './PageReviewCard';
import { pageReviewSchema, pageReviewTool } from '../shared/page-review';
import { contextualMessage, type PageContext } from './page-context';
import { api, ApiError } from './api';
import type { Page } from '../server/pages';
import { useEffect, useRef, useState } from 'react';
import {
  CopilotChatToolCallsView,
  useRenderTool,
  useHumanInTheLoop,
  useAgent,
  useCopilotKit,
} from '@copilotkit/react-core/v2';
import {
  FilePlus,
  ArrowUp,
  Clock3,
  Link2,
  Phone,
  PhoneOff,
  Square,
  X,
} from 'lucide-react';
import {
  ComputerToolCard,
  type ComputerToolRenderProps,
} from './ComputerToolCard';
import { ChatTranscript, isInternalVoiceReceipt } from './ChatTranscript';
import type { CallReceipt, Conversation, Dot } from '../shared/types';
import { Mascot } from './Mascot';
import { useVoice } from './useVoice';
import { CallView } from './CallView';
import { SupervisorRunPanel, supervisorSnapshot } from './SupervisorRunPanel';
import { SupervisorHealthStatus } from './SupervisorHealthStatus';
import { recoveredSupervisorMessage } from './supervisor-recovery';
export function Chat({
  thread,
  dot,
  initialPrompt,
  onConsumed,
  voiceReady,
  calls,
  paused,
  onSaved,
  onSchedule,
  onComputer,
  supervisor = false,
}: {
  thread: Conversation;
  dot: Dot;
  initialPrompt?: string;
  onConsumed: () => void;
  voiceReady: boolean;
  calls: CallReceipt[];
  paused: boolean;
  onSaved: () => void;
  onSchedule: () => void;
  onComputer?: () => void;
  supervisor?: boolean;
}) {
  const { agent, isReady } = useAgent({
    agentId: `chat-${thread.id}`,
    runtimeAgentId: dot.id,
    threadId: thread.id,
  });
  const { copilotkit } = useCopilotKit();
  const [pageContext, setPageContext] = useState<PageContext | null>();
  const [contextError, setContextError] = useState('');
  const [contextAttempt, setContextAttempt] = useState(0);
  const contextReady = pageContext !== undefined;
  useEffect(() => {
    let active = true;
    setPageContext(undefined);
    setContextError('');
    void api<PageContext | null>(
      `/conversations/${thread.id}/page-context`,
      'GET',
      undefined,
      AbortSignal.timeout(10000),
    )
      .then((page) => {
        if (active) setPageContext(page);
      })
      .catch(() => {
        if (active)
          setContextError(
            'Conversation context could not load. Retry before sending your message.',
          );
      });
    return () => {
      active = false;
    };
  }, [thread.id, contextAttempt]);
  const [draft, setDraft] = useState('');
  const [source, setSource] = useState('');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState(false);
  const [supervisorRecoveryReady, setSupervisorRecoveryReady] =
    useState(!supervisor);
  const voice = useVoice(thread.id, onSaved, agent.messages.at(-1)?.id);
  const sent = useRef(false);
  const cancelled = useRef(false);
  const declined = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const subscription = copilotkit.subscribe({
      onError: ({ error }) => setError(error.message),
    });
    const events = agent.subscribe({
      onRunErrorEvent: ({ event }) => {
        if (event.code === 'SUPERVISOR_CANCELLED') {
          cancelled.current = true;
          setError('');
          return;
        }
        if (event.code === 'SUPERVISOR_APPROVAL_DECLINED') {
          declined.current = true;
          setError('');
          return;
        }
        setError(event.message);
      },
    });
    return () => {
      subscription.unsubscribe();
      events.unsubscribe();
    };
  }, [agent, copilotkit]);
  useEffect(() => {
    if (!isReady) return;
    let active = true;
    void copilotkit
      .connectAgent({ agent })
      .then(() => {
        if (active) setLoaded(true);
      })
      .catch((e) => {
        if (active)
          setError(
            e instanceof Error ? e.message : 'Conversation could not connect.',
          );
      });
    return () => {
      active = false;
    };
  }, [agent, copilotkit, isReady]);
  const send = async (text: string) => {
    if (
      !text.trim() ||
      running ||
      !loaded ||
      !contextReady ||
      paused ||
      (supervisor && !supervisorRecoveryReady)
    )
      return;
    setError('');
    cancelled.current = false;
    declined.current = false;
    setRunning(true);
    const userMessage = {
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: contextualMessage(text, pageContext),
    };
    try {
      if (supervisor)
        await api('/supervisor/messages', 'POST', {
          threadId: thread.id,
          ...userMessage,
        });
      agent.addMessage(userMessage);
      setDraft('');
      setSource('');
      setSourceOpen(false);

      const result = await copilotkit.runAgent({ agent });
      const assistantMessages = result.newMessages.filter(
        (message) =>
          message.role === 'assistant' &&
          typeof message.id === 'string' &&
          typeof message.content === 'string' &&
          message.content.trim(),
      );
      if (!assistantMessages.length) {
        if (cancelled.current || declined.current) {
          onSaved();
          return;
        }
        throw new Error(
          'The current turn returned no response. Check the runtime connection and retry.',
        );
      }
      if (supervisor)
        for (const message of assistantMessages)
          await api('/supervisor/messages', 'POST', {
            threadId: thread.id,
            id: message.id,
            role: 'assistant',
            content: message.content,
          });
      onSaved();
    } catch (e) {
      if (!cancelled.current)
        setError(
          e instanceof Error
            ? e.message
            : 'The turn failed. Your conversation remains saved.',
        );
    } finally {
      setRunning(false);
    }
  };
  const stopResponse = async () => {
    if (!supervisor) {
      copilotkit.stopAgent({ agent });
      return;
    }
    const snapshot = supervisorSnapshot(agent.state);
    if (!snapshot?.running || !snapshot.supervisorRunId) {
      setError(
        'Supervisor run is not yet cancellable. Keep the stream open until its run id appears.',
      );
      return;
    }
    try {
      await api('/supervisor/cancel', 'POST', {
        threadId: thread.id,
        supervisorRunId: snapshot.supervisorRunId,
        ...(snapshot.supervisorPid > 0
          ? { supervisorPid: snapshot.supervisorPid }
          : {}),
      });
      cancelled.current = true;
      setError('');
      copilotkit.stopAgent({ agent });
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Supervisor cancellation failed.',
      );
    }
  };

  useEffect(() => {
    if (!supervisor) {
      setSupervisorRecoveryReady(true);
      return;
    }
    if (!loaded) {
      setSupervisorRecoveryReady(false);
      return;
    }

    let active = true;
    let timer: number | undefined;
    setSupervisorRecoveryReady(false);

    const scheduleRefresh = () => {
      if (!active) return;
      timer = window.setTimeout(() => void refreshSupervisorThread(), 1000);
    };

    const scheduleRecovery = () => {
      if (!active) return;
      timer = window.setTimeout(() => void recoverSupervisorThread(), 1000);
    };

    const restoreSupervisorMessages = async () => {
      const result = await api<{
        messages: Array<{
          id: string;
          role: 'user' | 'assistant';
          content: string;
        }>;
      }>(
        '/supervisor/messages/list',
        'POST',
        { threadId: thread.id },
        AbortSignal.timeout(3000),
      );
      if (!active) return;
      const existing = new Set(agent.messages.map((message) => message.id));
      for (const message of result.messages ?? []) {
        if (!existing.has(message.id)) {
          agent.addMessage({
            id: message.id,
            role: message.role,
            content: message.content,
          });
          existing.add(message.id);
        }
      }
    };

    const refreshSupervisorThread = async () => {
      try {
        const result = await api<{
          snapshot?: unknown;
          finalMessage?: unknown;
        }>(
          '/supervisor/thread-status',
          'POST',
          { threadId: thread.id },
          AbortSignal.timeout(3000),
        );
        if (!active) return;

        const restored = supervisorSnapshot(result.snapshot);
        if (!restored) return;

        agent.setState(restored);
        setRunning(restored.running);
        if (!restored.running) {
          const recovered = recoveredSupervisorMessage(
            result.finalMessage,
            agent.messages.map((message) => message.id),
          );
          if (recovered) {
            await api('/supervisor/messages', 'POST', {
              threadId: thread.id,
              ...recovered,
            });
            agent.addMessage(recovered);
          }
        }
        setError('');
        setSupervisorRecoveryReady(true);
        if (restored.running) scheduleRefresh();
      } catch (error) {
        if (!active) return;
        if (error instanceof ApiError && error.status === 404) {
          // No prior binding is the normal case for a fresh Supervisor thread.
          setError('');
          setSupervisorRecoveryReady(true);
          return;
        }
        setSupervisorRecoveryReady(false);
        setError(
          error instanceof Error
            ? `Supervisor state restore failed: ${error.message}`
            : 'Supervisor state restore failed.',
        );
        scheduleRefresh();
      }
    };

    const recoverSupervisorThread = async () => {
      try {
        await restoreSupervisorMessages();
        await refreshSupervisorThread();
      } catch (error) {
        if (!active) return;
        setSupervisorRecoveryReady(false);
        setError(
          error instanceof Error
            ? `Supervisor history restore failed: ${error.message}`
            : 'Supervisor history restore failed.',
        );
        scheduleRecovery();
      }
    };

    void recoverSupervisorThread();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [agent, loaded, supervisor, thread.id]);

  useEffect(() => {
    if (
      loaded &&
      contextReady &&
      !paused &&
      (!supervisor || supervisorRecoveryReady) &&
      initialPrompt &&
      !sent.current
    ) {
      sent.current = true;
      onConsumed();
      void send(initialPrompt);
    }
  }, [
    loaded,
    contextReady,
    paused,
    supervisor,
    supervisorRecoveryReady,
    initialPrompt,
  ]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [agent.messages.length, running]);
  useEffect(() => {
    if (paused && voice.status !== 'idle') void voice.end();
  }, [paused]);
  useHumanInTheLoop(
    {
      name: pageReviewTool.name,
      description: pageReviewTool.description,
      parameters: pageReviewSchema,
      render: (props) => (
        <PageReviewCard {...props} threadId={thread.id} onSaved={onSaved} />
      ),
    },
    [thread.id, onSaved],
  );
  const computerCalls = agent.messages.flatMap((message) =>
    message.role === 'assistant' ? (message.toolCalls ?? []) : [],
  );
  const latestBrowserCall = computerCalls.findLast((call) =>
    [
      'navigate',
      'snapshot',
      'read',
      'screenshot',
      'click',
      'type',
      'key',
      'scroll',
    ].some((action) => call.function.name === `computer_${action}`),
  );
  useRenderTool(
    {
      name: '*',
      render: (props: ComputerToolRenderProps) =>
        props.name.startsWith('computer_') ? (
          <ComputerToolCard
            {...props}
            dotId={dot.id}
            dotName={dot.name}
            running={running}
            showScreen={props.toolCallId === latestBrowserCall?.id}
            onExpand={onComputer}
          />
        ) : null,
    },
    [dot.id, dot.name, running, latestBrowserCall?.id, onComputer],
  );
  const visible = agent.messages.filter(
    (message) =>
      !isInternalVoiceReceipt(message) &&
      ['user', 'assistant'].includes(message.role) &&
      ((typeof message.content === 'string' && message.content.trim()) ||
        (message.role === 'assistant' &&
          message.toolCalls?.some(
            (call) =>
              call.function.name.startsWith('computer_') ||
              call.function.name === pageReviewTool.name,
          ))),
  );
  return (
    <div className="live-chat">
      <header className="chat-persona">
        <Mascot
          identity={dot.id}
          name={dot.name}
          small
          state={running ? 'working' : paused ? 'paused' : 'idle'}
        />
        <div>
          <strong>{dot.name}</strong>
          <span>
            {paused
              ? 'Paused'
              : running
                ? 'Thinking…'
                : supervisor && !supervisorRecoveryReady
                  ? 'Restoring Supervisor…'
                  : loaded && contextReady
                    ? 'Here with you'
                    : 'Connecting to your conversation…'}
          </span>
        </div>
        <div className="chat-persona-actions">
          <button
            className="icon-button"
            aria-label="Save conversation as page"
            disabled={running}
            onClick={async () => {
              const title = window.prompt('Page title', thread.title);
              if (!title) return;
              try {
                const page = await api<Page>(
                  `/conversations/${thread.id}/page`,
                  'POST',
                  { title },
                );
                location.hash = `/spaces/${page.spaceId}/pages/${page.id}`;
              } catch (e) {
                setError(
                  e instanceof Error
                    ? e.message
                    : 'Could not save conversation.',
                );
              }
            }}
          >
            <FilePlus size={18} />
          </button>
          <button
            className="icon-button"
            aria-label="Schedule a task in this conversation"
            onClick={onSchedule}
          >
            <Clock3 size={18} />
          </button>
          <button
            className={`icon-button ${voice.status === 'active' ? 'on-call' : ''}`}
            aria-label={
              voice.status === 'idle' ? 'Start voice call' : 'End voice call'
            }
            title={
              voiceReady
                ? 'Talk with your Dot'
                : 'Voice setup requires VOICE_API_KEY and VOICE_MODEL'
            }
            disabled={!voiceReady || paused || !loaded || !contextReady}
            onClick={() =>
              voice.status === 'idle' ? void voice.start() : void voice.end()
            }
          >
            {voice.status === 'idle' ? (
              <Phone size={18} />
            ) : (
              <PhoneOff size={18} />
            )}
          </button>
        </div>
      </header>
      <SupervisorHealthStatus enabled={supervisor} />
      <SupervisorRunPanel state={agent.state} threadId={thread.id} />
      {pageContext && (
        <div className="page-chat-context">
          Working on{' '}
          <a href={`/#/spaces/${pageContext.spaceId}/pages/${pageContext.id}`}>
            {pageContext.title}
          </a>
        </div>
      )}
      <div className="chat-transcript">
        {!visible.length && (
          <div className="chat-welcome">
            <span className="eyebrow">A LITTLE SPACE TO THINK</span>
            <h1>What’s on your mind?</h1>
            <p>{dot.instructions}</p>
            <p className="muted">
              Your conversation stays with this Dot, across text and calls.
            </p>
          </div>
        )}
        <ChatTranscript
          messages={visible}
          calls={calls}
          renderTools={(message) => (
            <CopilotChatToolCallsView
              message={message}
              messages={agent.messages}
            />
          )}
        />
        {running && (
          <div className="thinking">
            <span />
            <span />
            <span />
            <span>{dot.name} is thinking</span>
          </div>
        )}
        <div ref={bottom} />
      </div>
      {contextError && (
        <div className="chat-error" role="alert">
          {contextError}
          <button onClick={() => setContextAttempt((value) => value + 1)}>
            Retry context
          </button>
        </div>
      )}
      {(error || voice.error) && (
        <div className="chat-error" role="alert">
          {error || voice.error}
          {error && (
            <button
              onClick={() => {
                setError('');
                void copilotkit
                  .connectAgent({ agent })
                  .then(() => setLoaded(true))
                  .catch((e) => setError(e.message));
              }}
            >
              Reconnect
            </button>
          )}
        </div>
      )}
      <CallView
        key={voice.status === 'idle' ? 'idle' : 'call'}
        dot={dot}
        voice={voice}
      />
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(`${source ? `From ${source}:\n\n` : ''}${draft}`);
        }}
      >
        {sourceOpen && (
          <div className="source-input">
            <Link2 size={15} />
            <input
              aria-label="Source page URL"
              type="url"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="https://example.com/page"
            />
            <button
              type="button"
              className="icon-button"
              aria-label="Remove source"
              onClick={() => {
                setSourceOpen(false);
                setSource('');
              }}
            >
              <X size={14} />
            </button>
          </div>
        )}
        <div className="chat-compose-row">
          <button
            type="button"
            className="icon-button"
            aria-label="Add source page link"
            onClick={() => setSourceOpen(!sourceOpen)}
          >
            <Link2 size={19} />
          </button>
          <textarea
            aria-label="Message your Dot"
            placeholder={`Message ${dot.name}…`}
            rows={1}
            value={draft}
            maxLength={4000}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {running ? (
            <button
              type="button"
              className="send-button"
              aria-label="Stop response"
              onClick={() => void stopResponse()}
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              className="send-button"
              aria-label="Send message"
              disabled={
                !draft.trim() ||
                !loaded ||
                !contextReady ||
                paused ||
                (supervisor && !supervisorRecoveryReady)
              }
            >
              <ArrowUp size={19} />
            </button>
          )}
        </div>
        <div className="chat-compose-note">
          {voiceReady
            ? 'Text and voice, one conversation.'
            : 'Text is ready. Voice needs separate server configuration.'}
        </div>
      </form>
    </div>
  );
}
