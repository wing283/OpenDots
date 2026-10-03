import { expect, it } from 'vitest';
import { normalizeSupervisorHealth } from '../src/client/SupervisorHealthStatus';

it('normalizes Supervisor bridge readiness without secret values', () => {
  expect(
    normalizeSupervisorHealth({
      ok: true,
      bridgeReady: true,
      runReady: false,
      version: '0.2',
      execution: {
        missingRequiredEnv: ['KIMI_API_KEY'],
        activeCount: 1,
        capacity: 3,
        cdpReady: true,
        spendGuard: {
          enabled: true,
          maxActualUsd: 0.2,
          source: 'environment',
          error: '',
        },
      },
    }),
  ).toEqual({
    ok: true,
    bridgeReady: true,
    runReady: false,
    version: '0.2',
    execution: {
      missingRequiredEnv: ['KIMI_API_KEY'],
      activeCount: 1,
      capacity: 3,
      cdpReady: true,
      spendGuard: {
        enabled: true,
        maxActualUsd: 0.2,
        source: 'environment',
        error: '',
      },
      threadBindingStore: {
        healthy: true,
        error: undefined,
      },
    },
  });
});

it('normalizes unhealthy Supervisor thread binding storage', () => {
  expect(
    normalizeSupervisorHealth({
      ok: true,
      bridgeReady: true,
      runReady: false,
      execution: {
        threadBindingStore: {
          healthy: false,
          error: 'OpenDots thread binding state is unreadable.',
        },
      },
    }),
  ).toMatchObject({
    runReady: false,
    execution: {
      threadBindingStore: {
        healthy: false,
        error: 'OpenDots thread binding state is unreadable.',
      },
    },
  });
});

it('rejects non-object health payloads', () => {
  expect(normalizeSupervisorHealth(null)).toBeNull();
  expect(normalizeSupervisorHealth('bad')).toBeNull();
});
