import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SupervisorRunPanel,
  dagLayers,
  supervisorSnapshot,
} from '../src/client/SupervisorRunPanel';

it('stays invisible for ordinary Dot state', () => {
  expect(renderToStaticMarkup(<SupervisorRunPanel state={{}} />)).toBe('');
  expect(supervisorSnapshot({ bridge: 'other' })).toBeNull();
});

it('renders Supervisor DAG state, costs, cache and dependencies', () => {
  const state = {
    bridge: 'supervisor-agui',
    bridgeRunId: 'bridge-1',
    supervisorRunId: 'sv-42',
    supervisorPid: 123,
    running: true,
    activeCount: 1,
    capacity: 2,
    eventCounts: {
      CACHE_HIT: 2,
      CACHE_MISS: 1,
      PLAN_CACHE_HIT: 1,
      PLAN_CACHE_MISS: 0,
      EVIDENCE_RECORDED: 3,
    },
    workers: [
      {
        id: 'planner',
        title: 'Planner',
        status: 'running',
        action: 'WORK',
        provider: 'kimi',
        model: 'k3',
        complexity: 'heavy',
        dependsOn: [],
        waitingFor: [],
        downstreamWaitingCount: 2,
        costUsd: 0.125,
        tokens: 1200,
      },
      {
        id: 'verify',
        title: 'Verifier',
        status: 'stopped',
        action: 'COMPLETE',
        provider: 'opus',
        model: '5.5',
        complexity: 'heavy',
        dependsOn: ['planner'],
        waitingFor: [],
        downstreamWaitingCount: 0,
        costUsd: 0.25,
        tokens: 800,
      },
    ],
  };
  const html = renderToStaticMarkup(<SupervisorRunPanel state={state} />);
  expect(html).toContain('Supervisor DAG');
  expect(html).toContain('sv-42');
  expect(html).toContain('1/2 workers');
  expect(html).toContain('2,000 tokens');
  expect(html).toContain('$0.3750');
  expect(html).toContain('result cache 2/1');
  expect(html).toContain('plan cache 1/0');
  expect(html).toContain('3 evidence');
  expect(html).toContain('Save evidence');
  expect(html).toContain('Stop run');
  expect(html).toContain('deps: planner');
  expect(html).toContain('critical');
});

it(
  'prefers measured TOKEN_COST_REPORT metrics over worker placeholders',
  () => {
    const state = {
      bridge: 'supervisor-agui',
      bridgeRunId: 'bridge-cost',
      supervisorRunId: 'sv-cost',
      supervisorPid: 321,
      running: false,
      activeCount: 0,
      capacity: 3,
      eventCounts: {
        TOKEN_COST_REPORT: 1,
      },
      runMetrics: {
        actualTokens: 2379,
        actualCostUsd: 0.00580073,
        baselineCostUsd: 0.0100098,
        costSavingsPercent: 42.049,
      },
      workers: [
        {
          id: 'worker',
          title: 'Worker',
          status: 'stopped',
          action: 'COMPLETE',
          phase: 'complete',
          provider: 'deepseek',
          model: 'flash',
          complexity: 'light',
          mode: 'read_only',
          dependsOn: [],
          waitingFor: [],
          downstreamWaitingCount: 0,
          reason: '',
          costUsd: 0,
          tokens: 0,
        },
      ],
    };
    const html = renderToStaticMarkup(<SupervisorRunPanel state={state} />);
    expect(html).toContain('2,379 tokens');
    expect(html).toContain('$0.0058');
    expect(html).toContain('baseline $0.0100');
    expect(html).toContain('saved');
    expect(html).toContain('42.0%');
  },
);

it(
  'renders cancelled Supervisor runs distinctly from normal completion',
  () => {
    const state = {
      bridge: 'supervisor-agui',
      bridgeRunId: 'bridge-cancel',
      supervisorRunId: 'sv-cancel',
      supervisorPid: 0,
      running: false,
      cancelled: true,
      cancelledAt: '2026-10-03T00:00:00Z',
      activeCount: 0,
      capacity: 3,
      eventCounts: {},
      workers: [],
    };
    const html = renderToStaticMarkup(<SupervisorRunPanel state={state} />);
    expect(html).toContain('Cancelled');
    expect(html).not.toContain('>Finished<');
  },
);

it('groups workers into dependency layers', () => {
  const workers = [
    { id: 'a', dependsOn: [] },
    { id: 'b', dependsOn: ['a'] },
    { id: 'c', dependsOn: ['a'] },
    { id: 'd', dependsOn: ['b', 'c'] },
  ].map((worker) => ({
    title: worker.id,
    status: '',
    action: '',
    phase: '',
    provider: '',
    model: '',
    complexity: '',
    mode: '',
    waitingFor: [],
    downstreamWaitingCount: 0,
    reason: '',
    costUsd: 0,
    tokens: 0,
    ...worker,
  }));
  expect(
    dagLayers(workers).map((layer) => layer.map((worker) => worker.id)),
  ).toEqual([['a'], ['b', 'c'], ['d']]);
});
