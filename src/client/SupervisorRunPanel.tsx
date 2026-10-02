type Worker = {
  id: string;
  title: string;
  status: string;
  action: string;
  phase: string;
  provider: string;
  model: string;
  complexity: string;
  mode: string;
  dependsOn: string[];
  waitingFor: string[];
  downstreamWaitingCount: number;
  reason: string;
  costUsd: number;
  tokens: number;
};

export type SupervisorSnapshot = {
  bridge: 'supervisor-agui';
  bridgeRunId: string;
  supervisorRunId: string;
  supervisorPid: number;
  running: boolean;
  activeCount: number;
  capacity: number;
  workers: Worker[];
  eventCounts: Record<string, number>;
  lastEvent?: { type?: string; at?: string; workerId?: string };
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function list(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function supervisorSnapshot(value: unknown): SupervisorSnapshot | null {
  const raw = record(value);
  if (!raw || raw.bridge !== 'supervisor-agui') return null;
  const workers = Array.isArray(raw.workers)
    ? raw.workers.flatMap((entry) => {
        const worker = record(entry);
        if (!worker) return [];
        return [{
          id: text(worker.id),
          title: text(worker.title) || text(worker.id),
          status: text(worker.status),
          action: text(worker.action),
          phase: text(worker.phase),
          provider: text(worker.provider),
          model: text(worker.model),
          complexity: text(worker.complexity),
          mode: text(worker.mode),
          dependsOn: list(worker.dependsOn),
          waitingFor: list(worker.waitingFor),
          downstreamWaitingCount: number(worker.downstreamWaitingCount),
          reason: text(worker.reason),
          costUsd: number(worker.costUsd),
          tokens: number(worker.tokens),
        }];
      })
    : [];
  const counts = record(raw.eventCounts) ?? {};
  return {
    bridge: 'supervisor-agui',
    bridgeRunId: text(raw.bridgeRunId),
    supervisorRunId: text(raw.supervisorRunId),
    supervisorPid: number(raw.supervisorPid),
    running: Boolean(raw.running),
    activeCount: number(raw.activeCount),
    capacity: number(raw.capacity),
    workers,
    eventCounts: Object.fromEntries(
      Object.entries(counts)
        .filter(([, value]) => typeof value === 'number')
        .map(([key, value]) => [key, Number(value)]),
    ),
    lastEvent: record(raw.lastEvent) as SupervisorSnapshot['lastEvent'],
  };
}

function tone(worker: Worker): string {
  const value = `${worker.status} ${worker.action} ${worker.reason}`.toLowerCase();
  if (/fail|error|blocked|need_human|insufficient/.test(value)) return 'bad';
  if (/running|work|evaluat|wait|queued/.test(value)) return 'active';
  if (/complete|success|stopped/.test(value)) return 'done';
  return 'idle';
}

export function SupervisorRunPanel({ state }: { state: unknown }) {
  const snapshot = supervisorSnapshot(state);
  if (!snapshot) return null;
  const totalTokens = snapshot.workers.reduce((sum, item) => sum + item.tokens, 0);
  const totalCost = snapshot.workers.reduce((sum, item) => sum + item.costUsd, 0);
  const completed = snapshot.workers.filter((item) => tone(item) === 'done').length;
  const critical = Math.max(
    0,
    ...snapshot.workers.map((item) => item.downstreamWaitingCount),
  );
  const cacheHits = snapshot.eventCounts.CACHE_HIT ?? 0;
  const cacheMisses = snapshot.eventCounts.CACHE_MISS ?? 0;
  const evidence = snapshot.eventCounts.EVIDENCE_RECORDED ?? 0;

  return (
    <section className="supervisor-run-panel" aria-label="Supervisor workflow">
      <div className="supervisor-run-heading">
        <div>
          <strong>Supervisor DAG</strong>
          <span>{snapshot.running ? 'Running' : 'Finished'}</span>
        </div>
        <code>{snapshot.supervisorRunId || 'starting…'}</code>
      </div>
      <div className="supervisor-run-metrics">
        <span>{completed}/{snapshot.workers.length} workers</span>
        <span>{totalTokens.toLocaleString()} tokens</span>
        <span>${totalCost.toFixed(4)}</span>
        <span>cache {cacheHits}/{cacheMisses}</span>
        <span>{evidence} evidence</span>
      </div>
      <div className="supervisor-dag-grid">
        {snapshot.workers.map((worker) => (
          <article
            className={`supervisor-node ${tone(worker)} ${
              critical > 0 && worker.downstreamWaitingCount === critical
                ? 'critical'
                : ''
            }`}
            key={worker.id}
          >
            <div className="supervisor-node-title">
              <strong>{worker.title || worker.id}</strong>
              <span>{worker.action || worker.status || 'pending'}</span>
            </div>
            <small>
              {[worker.provider, worker.model, worker.complexity]
                .filter(Boolean)
                .join(' · ') || 'routing pending'}
            </small>
            {worker.dependsOn.length > 0 && (
              <p>deps: {worker.dependsOn.join(' → ')}</p>
            )}
            {worker.waitingFor.length > 0 && (
              <p>waiting: {worker.waitingFor.join(', ')}</p>
            )}
            {worker.downstreamWaitingCount > 0 && (
              <p>downstream: {worker.downstreamWaitingCount}</p>
            )}
            {worker.reason && <p title={worker.reason}>{worker.reason}</p>}
          </article>
        ))}
      </div>
    </section>
  );
}
