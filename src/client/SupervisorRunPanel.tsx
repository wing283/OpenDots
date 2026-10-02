import { useState } from 'react';

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
  approval?: {
    status?: string;
    decision?: string;
    writers?: Array<{ id?: string; title?: string; goal?: string }>;
  };
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
    approval: record(raw.approval) as SupervisorSnapshot['approval'],
  };
}

function tone(worker: Worker): string {
  const value = `${worker.status} ${worker.action} ${worker.reason}`.toLowerCase();
  if (/fail|error|blocked|need_human|insufficient/.test(value)) return 'bad';
  if (/running|work|evaluat|wait|queued/.test(value)) return 'active';
  if (/complete|success|stopped/.test(value)) return 'done';
  return 'idle';
}

export function dagLayers(workers: Worker[]): Worker[][] {
  const byId = new Map(workers.map((worker) => [worker.id, worker]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();

  const visit = (worker: Worker): number => {
    const known = depth.get(worker.id);
    if (known !== undefined) return known;
    if (visiting.has(worker.id)) return 0;
    visiting.add(worker.id);
    const parents = worker.dependsOn
      .map((id) => byId.get(id))
      .filter((item): item is Worker => Boolean(item));
    const value =
      parents.length === 0 ? 0 : 1 + Math.max(...parents.map((item) => visit(item)));
    visiting.delete(worker.id);
    depth.set(worker.id, value);
    return value;
  };

  for (const worker of workers) visit(worker);
  const maxDepth = Math.max(0, ...depth.values());
  return Array.from({ length: maxDepth + 1 }, (_, level) =>
    workers.filter((worker) => (depth.get(worker.id) ?? 0) === level),
  ).filter((layer) => layer.length > 0);
}

export function SupervisorRunPanel({ state }: { state: unknown }) {
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalError, setApprovalError] = useState('');
  const [evidenceBusy, setEvidenceBusy] = useState(false);
  const [evidenceError, setEvidenceError] = useState('');
  const [savedEvidence, setSavedEvidence] = useState<{
    spaceId: string;
    pageId: string;
  } | null>(null);
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
  const approvalPending = snapshot.approval?.status === 'pending';
  const saveEvidence = async () => {
    if (!snapshot.supervisorRunId || evidenceBusy || evidence <= 0) return;
    setEvidenceBusy(true);
    setEvidenceError('');
    try {
      const { api } = await import('./api');
      const result = await api<{
        space: { id: string };
        page: { id: string; spaceId: string };
      }>('/supervisor/evidence', 'POST', {
        supervisorRunId: snapshot.supervisorRunId,
      });
      setSavedEvidence({
        spaceId: result.space.id,
        pageId: result.page.id,
      });
    } catch (error) {
      setEvidenceError(
        error instanceof Error ? error.message : 'Evidence save failed.',
      );
    } finally {
      setEvidenceBusy(false);
    }
  };

  const resolveApproval = async (decision: 'approve' | 'decline') => {
    if (!snapshot.supervisorRunId || approvalBusy) return;
    setApprovalBusy(true);
    setApprovalError('');
    try {
      const { api } = await import('./api');
      await api('/supervisor/approval', 'POST', {
        supervisorRunId: snapshot.supervisorRunId,
        decision,
      });
    } catch (error) {
      setApprovalError(
        error instanceof Error ? error.message : 'Approval request failed.',
      );
    } finally {
      setApprovalBusy(false);
    }
  };

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
      {evidence > 0 && snapshot.supervisorRunId && (
        <div className="supervisor-evidence-actions">
          <button
            type="button"
            disabled={evidenceBusy}
            onClick={() => void saveEvidence()}
          >
            {evidenceBusy ? 'Saving evidence…' : 'Save evidence'}
          </button>
          {savedEvidence && (
            <button
              type="button"
              onClick={() => {
                location.hash =
                  `/spaces/${savedEvidence.spaceId}/pages/${savedEvidence.pageId}`;
              }}
            >
              Open evidence
            </button>
          )}
          {evidenceError && <span>{evidenceError}</span>}
        </div>
      )}
      {approvalPending && (
        <div className="supervisor-approval" role="alert">
          <div>
            <strong>Writer approval required</strong>
            <span>
              {(snapshot.approval?.writers ?? [])
                .map((writer) => writer.title || writer.id)
                .filter(Boolean)
                .join(', ') || 'A writer step is waiting for approval.'}
            </span>
          </div>
          <div className="supervisor-approval-actions">
            <button
              type="button"
              disabled={approvalBusy}
              onClick={() => void resolveApproval('decline')}
            >
              Decline
            </button>
            <button
              type="button"
              className="primary"
              disabled={approvalBusy}
              onClick={() => void resolveApproval('approve')}
            >
              Approve
            </button>
          </div>
          {approvalError && <p>{approvalError}</p>}
        </div>
      )}
      <div className="supervisor-dag-flow">
        {dagLayers(snapshot.workers).map((layer, layerIndex) => (
          <div className="supervisor-dag-layer" key={layerIndex}>
            <div className="supervisor-dag-layer-label">L{layerIndex}</div>
            {layer.map((worker) => (
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
        ))}
      </div>
    </section>
  );
}
