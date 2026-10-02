import { HttpAgent } from '@ag-ui/client';
import { expect, it } from 'vitest';
import {
  createWorkspaceAgent,
  validateSupervisorAgentConfig,
} from '../src/server/agent-factory.js';
import { DotAgent } from '../src/server/dot-agent.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import type { Store } from '../src/server/store.js';
import type { WorkspaceStore } from '../src/server/workspace.js';

const base: PlatformConfig = {
  baseUrl: 'https://example.com',
  runtimeUrl: 'http://127.0.0.1:4310/api/copilotkit',
  voiceName: 'marin',
  slackUsers: [],
};

it('requires Supervisor URL and Dot id together', () => {
  expect(() =>
    validateSupervisorAgentConfig(
      { ...base, supervisorAguiUrl: 'http://127.0.0.1:8791/' },
      ['supervisor'],
    ),
  ).toThrow(/configured together/);
});
it('requires a token when the Supervisor bridge is not loopback', () => {
  expect(() =>
    validateSupervisorAgentConfig(
      {
        ...base,
        supervisorAguiUrl: 'https://supervisor.example.com/',
        supervisorDotId: 'supervisor',
      },
      ['supervisor'],
    ),
  ).toThrow(/SUPERVISOR_AGUI_TOKEN/);
});

it('creates an authenticated HttpAgent only for the configured Supervisor Dot', () => {
  const config = {
    ...base,
    supervisorAguiUrl: 'https://supervisor.example.com/',
    supervisorAguiToken: 'secret',
    supervisorDotId: 'supervisor',
  };
  validateSupervisorAgentConfig(config, ['supervisor', 'research']);
  const agent = createWorkspaceAgent(
    {} as Store,
    {} as WorkspaceStore,
    config,
    'supervisor',
  );
  expect(agent).toBeInstanceOf(HttpAgent);
  const http = agent as HttpAgent;
  expect(http.agentId).toBe('supervisor');
  expect(http.url).toBe('https://supervisor.example.com/');
  expect(http.headers).toEqual({ Authorization: 'Bearer secret' });
});

it('keeps ordinary Dots on the built-in DotAgent', () => {
  const agent = createWorkspaceAgent(
    {} as Store,
    {} as WorkspaceStore,
    {
      ...base,
      supervisorAguiUrl: 'http://127.0.0.1:8791/',
      supervisorDotId: 'supervisor',
    },
    'research',
  );
  expect(agent).toBeInstanceOf(DotAgent);
});
