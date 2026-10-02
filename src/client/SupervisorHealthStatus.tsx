import { useEffect, useState } from 'react';
import { api } from './api';

export type SupervisorHealth = {
  ok: boolean;
  bridgeReady: boolean;
  runReady: boolean;
  version?: string;
  execution?: {
    missingRequiredEnv?: string[];
    activeCount?: number;
    capacity?: number;
    cdpReady?: boolean;
  };
};

export function normalizeSupervisorHealth(
  value: unknown,
): SupervisorHealth | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const execution =
    raw.execution && typeof raw.execution === 'object'
      ? (raw.execution as Record<string, unknown>)
      : {};
  return {
    ok: raw.ok === true,
    bridgeReady: raw.bridgeReady === true,
    runReady: raw.runReady === true,
    version: typeof raw.version === 'string' ? raw.version : undefined,
    execution: {
      missingRequiredEnv: Array.isArray(execution.missingRequiredEnv)
        ? execution.missingRequiredEnv.filter(
            (item): item is string => typeof item === 'string',
          )
        : [],
      activeCount:
        typeof execution.activeCount === 'number' ? execution.activeCount : 0,
      capacity: typeof execution.capacity === 'number' ? execution.capacity : 0,
      cdpReady: execution.cdpReady === true,
    },
  };
}

export function SupervisorHealthStatus({ enabled }: { enabled: boolean }) {
  const [health, setHealth] = useState<SupervisorHealth | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!enabled) {
      setHealth(null);
      setError('');
      return;
    }
    let active = true;
    const load = async () => {
      try {
        const next = normalizeSupervisorHealth(
          await api(
            '/supervisor/health',
            'GET',
            undefined,
            AbortSignal.timeout(3500),
          ),
        );
        if (active) {
          setHealth(next);
          setError(next ? '' : 'Invalid bridge health response.');
        }
      } catch (reason) {
        if (active) {
          setHealth(null);
          setError(
            reason instanceof Error
              ? reason.message
              : 'Supervisor bridge is unreachable.',
          );
        }
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [enabled]);

  if (!enabled) return null;
  if (error)
    return (
      <div className="supervisor-health bad" role="status">
        <strong>Supervisor bridge unavailable</strong>
        <span>{error}</span>
      </div>
    );
  if (!health)
    return (
      <div className="supervisor-health checking" role="status">
        <strong>Supervisor bridge</strong>
        <span>Checking…</span>
      </div>
    );

  const missing = health.execution?.missingRequiredEnv ?? [];
  const detail = health.runReady
    ? `${health.execution?.activeCount ?? 0}/${health.execution?.capacity ?? 0} workflows active`
    : missing.length
      ? `Missing: ${missing.join(', ')}`
      : 'Execution prerequisites are not ready.';

  return (
    <div
      className={`supervisor-health ${health.runReady ? 'ready' : 'blocked'}`}
      role="status"
    >
      <strong>
        {health.runReady
          ? 'Supervisor ready'
          : health.bridgeReady
            ? 'Bridge connected'
            : 'Bridge not ready'}
      </strong>
      <span>{detail}</span>
      {health.version && <code>v{health.version}</code>}
    </div>
  );
}
