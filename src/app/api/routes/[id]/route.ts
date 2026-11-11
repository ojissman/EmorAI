import { z } from 'zod';
import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { ok, fail } from '@/lib/api/response';
import { planExecution } from '@/lib/ai/router';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  upstreamModelId: z.string().min(1).max(160).optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  enabled: z.boolean().optional(),
  maxConcurrency: z.number().int().min(0).max(256).optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  weight: z.number().min(0.1).max(10).optional(),
  // explicit capability subset (null = inherit public model's set)
  capabilities: z
    .object({
      chat: z.boolean(),
      reasoning: z.boolean(),
      vision: z.boolean(),
      files: z.boolean(),
      webSearch: z.boolean(),
      tools: z.boolean(),
      json: z.boolean(),
    })
    .nullish(),
  // reset health state after an incident (admin action)
  resetHealth: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'bad_json', 'Request body must be valid JSON.');
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return fail(400, 'invalid_request', 'Invalid route patch.', { details: parsed.error.flatten() });
  }
  const data = parsed.data;
  const route = await db.modelRoute.findUnique({ where: { id } });
  if (!route) return fail(404, 'not_found', 'Route not found.');

  const { capabilities, resetHealth, ...rest } = data;
  const updated = await db.modelRoute.update({
    where: { id },
    data: {
      ...rest,
      ...(capabilities !== undefined ? { capabilities: capabilities ?? Prisma.DbNull } : {}),
      ...(resetHealth ? { healthStatus: 'unknown', lastError: null } : {}),
    },
  });
  const preview = await planExecution(updated.publicModelId);
  return ok({ route: updated, preview });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  const route = await db.modelRoute.findUnique({ where: { id } });
  if (!route) return fail(404, 'not_found', 'Route not found.');
  const remaining = await db.modelRoute.count({ where: { publicModelId: route.publicModelId } });
  if (remaining <= 1) {
    return fail(
      409,
      'last_route',
      `This is the only route for "${route.publicModelId}". Deleting it would leave the model unroutable — add another route first or retire the model instead.`
    );
  }
  await db.modelRoute.delete({ where: { id } });
  return ok({ deleted: true });
}
