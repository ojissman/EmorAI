import { z } from 'zod';
import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { ok, fail } from '@/lib/api/response';
import { planExecution } from '@/lib/ai/router';
import { DEFAULT_CAPABILITIES } from '@/lib/types';

export const runtime = 'nodejs';

/** Lists routes (with accounts) + the live eligibility preview from the router. */
export async function GET() {
  const routes = await db.modelRoute.findMany({
    orderBy: [{ publicModelId: 'asc' }, { priority: 'asc' }, { createdAt: 'asc' }],
    include: { providerAccount: { select: { id: true, name: true, providerType: true, enabled: true, lastStatus: true } } },
  });
  return ok({ routes });
}

const capabilitiesSchema = z.object({
  chat: z.boolean(),
  reasoning: z.boolean(),
  vision: z.boolean(),
  files: z.boolean(),
  webSearch: z.boolean(),
  tools: z.boolean(),
  json: z.boolean(),
});

const createSchema = z.object({
  publicModelId: z.string().min(1).max(120),
  providerAccountId: z.string().min(1),
  upstreamModelId: z.string().min(1).max(160),
  priority: z.number().int().min(0).max(1000).default(0),
  enabled: z.boolean().default(true),
  capabilities: capabilitiesSchema.nullish(),
  maxConcurrency: z.number().int().min(0).max(256).default(0),
  timeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
  weight: z.number().min(0.1).max(10).default(1.0),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'bad_json', 'Request body must be valid JSON.');
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return fail(400, 'invalid_request', 'Invalid route definition.', { details: parsed.error.flatten() });
  }
  const data = parsed.data;

  const model = await db.modelConfig.findUnique({ where: { modelId: data.publicModelId } });
  if (!model) {
    return fail(404, 'unknown_model', `Public model "${data.publicModelId}" is not in the registry.`);
  }
  if (model.category !== 'emorai') {
    return fail(400, 'not_routable', `Model "${data.publicModelId}" is a provider-category model served directly; routes are for EmorAI family models.`);
  }
  const account = await db.providerAccount.findUnique({ where: { id: data.providerAccountId } });
  if (!account) return fail(404, 'unknown_account', 'Provider account not found.');

  const duplicate = await db.modelRoute.findFirst({
    where: { publicModelId: data.publicModelId, providerAccountId: data.providerAccountId, upstreamModelId: data.upstreamModelId },
  });
  if (duplicate) {
    return fail(409, 'duplicate_route', 'This exact route (model + account + upstream) already exists.');
  }

  const route = await db.modelRoute.create({
    data: {
      publicModelId: data.publicModelId,
      providerAccountId: data.providerAccountId,
      upstreamModelId: data.upstreamModelId,
      priority: data.priority,
      enabled: data.enabled,
      capabilities: data.capabilities ?? Prisma.DbNull,
      maxConcurrency: data.maxConcurrency,
      timeoutMs: data.timeoutMs,
      weight: data.weight,
    },
  });
  // live eligibility preview for the admin (uses the same router logic)
  const preview = await planExecution(data.publicModelId);
  return ok({ route, preview }, { status: 201 });
}
