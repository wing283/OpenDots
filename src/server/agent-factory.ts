import {
  HttpAgent,
  type AbstractAgent,
  type HttpAgentConfig,
} from '@ag-ui/client';
import { DotAgent } from './dot-agent.js';
import type { PlatformConfig } from './platform-config.js';
import { Store } from './store.js';
import { WorkspaceStore } from './workspace.js';

function loopback(hostname: string): boolean {
  return ['127.0.0.1', '::1', 'localhost'].includes(hostname);
}

export class SupervisorHttpAgent extends HttpAgent {
  constructor(config: HttpAgentConfig) {
    super(config);
  }

  abortRun(): void {
    const state = this.state as Record<string, unknown>;
    const supervisorRunId = String(state.supervisorRunId ?? '');
    const supervisorPid = Number(state.supervisorPid ?? 0);
    const bridgeRunId = String(state.bridgeRunId ?? '');
    if (supervisorRunId || supervisorPid > 0) {
      const cancelUrl = new URL('/cancel', this.url).toString();
      void this.fetch(cancelUrl, {
        method: 'POST',
        headers: {
          ...this.headers,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          bridgeRunId,
          supervisorRunId,
          supervisorPid,
        }),
      }).catch(() => undefined);
    }
    super.abortRun();
  }
}

export function validateSupervisorAgentConfig(
  config: PlatformConfig,
  dotIds: string[],
): void {
  const url = config.supervisorAguiUrl?.trim();
  const dotId = config.supervisorDotId?.trim();
  if (!url && !dotId) return;
  if (!url || !dotId)
    throw new Error(
      'SUPERVISOR_AGUI_URL and SUPERVISOR_DOT_ID must be configured together.',
    );
  let endpoint: URL;
  try {
    endpoint = new URL(url);
  } catch {
    throw new Error('SUPERVISOR_AGUI_URL must be a valid URL.');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol))
    throw new Error('SUPERVISOR_AGUI_URL must use HTTP or HTTPS.');
  if (!dotIds.includes(dotId))
    throw new Error('SUPERVISOR_DOT_ID does not identify an existing Dot.');
  if (!loopback(endpoint.hostname) && !config.supervisorAguiToken)
    throw new Error(
      'SUPERVISOR_AGUI_TOKEN is required for non-loopback Supervisor bridges.',
    );
}

export function createWorkspaceAgent(
  store: Store,
  workspace: WorkspaceStore,
  config: PlatformConfig,
  dotId: string,
  channel = false,
): AbstractAgent {
  if (
    config.supervisorAguiUrl &&
    config.supervisorDotId &&
    dotId === config.supervisorDotId
  ) {
    return new SupervisorHttpAgent({
      agentId: dotId,
      url: config.supervisorAguiUrl,
      headers: config.supervisorAguiToken
        ? { Authorization: `Bearer ${config.supervisorAguiToken}` }
        : {},
    });
  }
  return new DotAgent(store, workspace, config, dotId, channel);
}
