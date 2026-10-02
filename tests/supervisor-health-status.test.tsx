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
    },
  });
});

it('rejects non-object health payloads', () => {
  expect(normalizeSupervisorHealth(null)).toBeNull();
  expect(normalizeSupervisorHealth('bad')).toBeNull();
});
