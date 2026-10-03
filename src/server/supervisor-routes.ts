import { Hono } from 'hono';
import { z } from 'zod';
import type { PlatformConfig } from './platform-config.js';
import type { WorkspaceStore } from './workspace.js';

const threadRef = z
  .object({
    threadId: z.string().trim().min(1).max(512),
  })
  .strict();

const runRef = z
  .object({
    supervisorRunId: z.string().trim().min(1).max(128),
  })
  .strict();

const cancelRef = z
  .object({
    supervisorRunId: z.string().trim().min(1).max(128),
    supervisorPid: z.number().int().positive().optional(),
  })
  .strict();

const approval = z
  .object({
    supervisorRunId: z.string().trim().min(1).max(128),
    decision: z.enum(['approve', 'decline']),
  })
  .strict();

const evidenceEnvelope = z.object({
  ok: z.literal(true),
  evidence: z.object({
    runId: z.string(),
    totalCount: z.number().int().nonnegative(),
    truncated: z.boolean().optional(),
    items: z.array(
      z.object({
        id: z.string(),
        category: z.string(),
        source: z.string(),
        trust: z.string(),
        capturedAt: z.string(),
        sha256: z.string(),
        payloadPreview: z.string(),
      }),
    ),
  }),
});

function bridgeHeaders(config: PlatformConfig) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(config.supervisorAguiToken
      ? { Authorization: `Bearer ${config.supervisorAguiToken}` }
      : {}),
  };
}

async function bridgePost(
  config: PlatformConfig,
  path: string,
  body: unknown,
  signal: AbortSignal,
) {
  return fetch(new URL(path, config.supervisorAguiUrl), {
    method: 'POST',
    signal,
    headers: bridgeHeaders(config),
    body: JSON.stringify(body),
  });
}

async function bridgeGet(
  config: PlatformConfig,
  path: string,
  signal: AbortSignal,
) {
  return fetch(new URL(path, config.supervisorAguiUrl), {
    method: 'GET',
    signal,
    headers: bridgeHeaders(config),
  });
}

function evidenceMarkdown(
  runId: string,
  evidence: z.infer<typeof evidenceEnvelope>['evidence'],
) {
  const lines = [
    '# Supervisor Evidence',
    '',
    `Run: \`${runId}\``,
    `Evidence items: ${evidence.totalCount}${evidence.truncated ? ' (projection truncated)' : ''}`,
    '',
  ];
  for (const item of evidence.items) {
    lines.push(
      `## ${item.id} — ${item.category || 'evidence'}`,
      '',
      `- source: ${item.source || 'unknown'}`,
      `- trust: ${item.trust || 'unknown'}`,
      `- captured: ${item.capturedAt || 'unknown'}`,
      `- sha256: \`${item.sha256}\``,
      '',
      ...item.payloadPreview.split('\n').map((line) => `    ${line}`),
      '',
    );
  }
  return lines.join('\n').slice(0, 100000);
}

function ensureEvidenceSpace(
  config: PlatformConfig,
  workspace: WorkspaceStore,
) {
  let space = workspace
    .spaces()
    .find((item) => item.name === 'Supervisor Evidence');
  if (!space)
    space = workspace.createSpace(
      'Supervisor Evidence',
      'Read-only projections of Supervisor Evidence Store runs.',
    );
  const dot = config.supervisorDotId
    ? workspace.dot(config.supervisorDotId)
    : undefined;
  if (dot && !dot.spaceIds.includes(space.id))
    workspace.updateDot(dot.id, {
      name: dot.name,
      instructions: dot.instructions,
      researchAllowed: dot.researchAllowed,
      memoryAllowed: dot.memoryAllowed,
      spaceId: dot.spaceId,
      spaceIds: [...new Set([...dot.spaceIds, space.id])],
      learningContainerId: dot.learningContainerId ?? null,
      skillDeliveryEnabled: dot.skillDeliveryEnabled ?? false,
    });
  return space;
}

export function supervisorRoutes(
  config: PlatformConfig,
  workspace: WorkspaceStore,
) {
  const app = new Hono();

  app.get('/supervisor/health', async (c) => {
    if (!config.supervisorAguiUrl || !config.supervisorDotId)
      return c.json(
        { error: 'Supervisor integration is not configured.' },
        404,
      );
    try {
      const response = await bridgeGet(
        config,
        '/health',
        AbortSignal.timeout(3000),
      );
      const body = (await response.json().catch(() => ({
        error: 'Supervisor bridge returned an unreadable response.',
      }))) as Record<string, unknown>;
      return c.json(body, response.status as 200 | 401 | 500 | 503);
    } catch (error) {
      return c.json(
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : 'Supervisor bridge is unreachable.',
        },
        503,
      );
    }
  });

  app.post('/supervisor/thread-status', async (c) => {
    if (!config.supervisorAguiUrl || !config.supervisorDotId)
      return c.json(
        { error: 'Supervisor integration is not configured.' },
        404,
      );

    const parsed = threadRef.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Invalid Supervisor thread request.' }, 400);

    try {
      workspace.requireThread(parsed.data.threadId, config.supervisorDotId);
    } catch {
      return c.json(
        { error: 'Supervisor thread does not belong to this Dot.' },
        404,
      );
    }

    const response = await bridgePost(
      config,
      '/thread-status',
      parsed.data,
      c.req.raw.signal,
    );
    const body = (await response.json().catch(() => ({
      error: 'Supervisor bridge returned an unreadable response.',
    }))) as Record<string, unknown>;
    return c.json(body, response.status as 200 | 400 | 404 | 409 | 500);
  });

  app.post('/supervisor/cancel', async (c) => {
    if (!config.supervisorAguiUrl || !config.supervisorDotId)
      return c.json(
        { error: 'Supervisor integration is not configured.' },
        404,
      );

    const parsed = cancelRef.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Invalid Supervisor cancel request.' }, 400);

    const response = await bridgePost(
      config,
      '/cancel',
      parsed.data,
      c.req.raw.signal,
    );
    const body = (await response.json().catch(() => ({
      error: 'Supervisor bridge returned an unreadable response.',
    }))) as Record<string, unknown>;
    return c.json(body, response.status as 200 | 400 | 404 | 409 | 500);
  });

  app.post('/supervisor/approval', async (c) => {
    if (!config.supervisorAguiUrl || !config.supervisorDotId)
      return c.json(
        { error: 'Supervisor integration is not configured.' },
        404,
      );

    const parsed = approval.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Invalid Supervisor approval request.' }, 400);

    const response = await bridgePost(
      config,
      '/approval',
      parsed.data,
      c.req.raw.signal,
    );
    const body = (await response.json().catch(() => ({
      error: 'Supervisor bridge returned an unreadable response.',
    }))) as Record<string, unknown>;
    return c.json(body, response.status as 200 | 400 | 404 | 409 | 500);
  });

  app.post('/supervisor/evidence', async (c) => {
    if (!config.supervisorAguiUrl || !config.supervisorDotId)
      return c.json(
        { error: 'Supervisor integration is not configured.' },
        404,
      );
    const parsed = runRef.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Invalid Supervisor evidence request.' }, 400);

    const response = await bridgePost(
      config,
      '/evidence',
      parsed.data,
      c.req.raw.signal,
    );
    const raw = await response.json().catch(() => null);
    if (!response.ok)
      return c.json(
        (raw as Record<string, unknown>) ?? {
          error: 'Supervisor evidence request failed.',
        },
        response.status as 400 | 404 | 409 | 500,
      );
    const projection = evidenceEnvelope.safeParse(raw);
    if (!projection.success)
      return c.json(
        { error: 'Supervisor evidence response was invalid.' },
        502,
      );

    const space = ensureEvidenceSpace(config, workspace);
    const title = `Supervisor Run ${parsed.data.supervisorRunId}`;
    const content = evidenceMarkdown(
      parsed.data.supervisorRunId,
      projection.data.evidence,
    );
    const existing = workspace.pages
      .list(space.id)
      .find((page) => page.title === title);
    const page = existing
      ? workspace.pages.update(space.id, existing.id, {
          content,
          expectedRevision: existing.revision,
        })
      : workspace.pages.create(space.id, { title, content, parentId: null });

    return c.json({
      ok: true,
      space,
      page,
      evidence: {
        totalCount: projection.data.evidence.totalCount,
        truncated: !!projection.data.evidence.truncated,
      },
    });
  });

  return app;
}
