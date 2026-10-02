import { HttpAgent, type AbstractAgent } from '@ag-ui/client';
import { DotAgent } from './dot-agent.js';
import type { PlatformConfig } from './platform-config.js';
import { Store } from './store.js';
import { WorkspaceStore } from './workspace.js';

function loopback(hostname: string): boolean {
  return ['127.0.0.1', '::1', 'localhost'].includes(hostname);
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
    return new HttpAgent({
      agentId: dotId,
      url: config.supervisorAguiUrl,
      headers: config.supervisorAguiToken
        ? { Authorization: `Bearer ${config.supervisorAguiToken}` }
        : {},
    });
  }
  return new DotAgent(store, workspace, config, dotId, channel);
}
