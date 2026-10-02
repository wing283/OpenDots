import { Hono } from 'hono';
import { z } from 'zod';
import type { PlatformConfig } from './platform-config.js';

const approval = z
  .object({
    supervisorRunId: z.string().trim().min(1).max(128),
    decision: z.enum(['approve', 'decline']),
  })
  .strict();

export function supervisorRoutes(config: PlatformConfig) {
  const app = new Hono();
  app.post('/supervisor/approval', async (c) => {
    if (!config.supervisorAguiUrl || !config.supervisorDotId)
      return c.json({ error: 'Supervisor integration is not configured.' }, 404);

    const parsed = approval.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Invalid Supervisor approval request.' }, 400);

    const target = new URL('/approval', config.supervisorAguiUrl);
    const response = await fetch(target, {
      method: 'POST',
      signal: c.req.raw.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(config.supervisorAguiToken
          ? { Authorization: `Bearer ${config.supervisorAguiToken}` }
          : {}),
      },
      body: JSON.stringify(parsed.data),
    });
    const body = (await response.json().catch(() => ({
      error: 'Supervisor bridge returned an unreadable response.',
    }))) as Record<string, unknown>;
    return c.json(body, response.status as 200 | 400 | 404 | 409 | 500);
  });
  return app;
}
