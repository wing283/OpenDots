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
    spendGuard?: {
      enabled: boolean;
      maxActualUsd: number;
      source?: string;
      error?: string;
    };
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
  const spendGuard =
    execution.spendGuard && typeof execution.spendGuard === 'object'
      ? (execution.spendGuard as Record<string, unknown>)
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
      spendGuard: {
        enabled: spendGuard.enabled === true,
        maxActualUsd:
          typeof spendGuard.maxActualUsd === 'number'
            ? spendGuard.maxActualUsd
            : 0,
        source:
          typeof spendGuard.source === 'string' ? spendGuard.source : undefined,
        error:
          typeof spendGuard.error === 'string' ? spendGuard.error : undefined,
      },
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
  const spendGuard = health.execution?.spendGuard;
  const spendLabel =
    spendGuard?.enabled && spendGuard.maxActualUsd > 0
      ? ` · cap ${spendGuard.maxActualUsd.toFixed(2)}/run`
      : '';
  const detail = health.runReady
    ? `${health.execution?.activeCount ?? 0}/${health.execution?.capacity ?? 0} workflows active${spendLabel}`
    : missing.length
      ? `Missing: ${missing.join(', ')}`
      : spendGuard?.error
        ? `Spend guard: ${spendGuard.error}`
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
