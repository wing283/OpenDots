import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SupervisorRunPanel,
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
  expect(html).toContain('cache 2/1');
  expect(html).toContain('3 evidence');
  expect(html).toContain('deps: planner');
  expect(html).toContain('critical');
});
