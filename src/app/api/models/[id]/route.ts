import { z } from 'zod';
import { db } from '@/lib/db';
import { updateModelConfig, deleteModelConfig } from '@/lib/model-registry';
import { ok, fail } from '@/lib/api/response';
import { requireAdmin } from '@/lib/api/admin-auth';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

const capabilitiesSchema = z.object({
  chat: z.boolean(),
  reasoning: z.boolean(),
  vision: z.boolean(),
  files: z.boolean(),
  webSearch: z.boolean(),
  tools: z.boolean(),
  json: z.boolean(),
});

const pricingSchema = z.object({
  inputPerMTok: z.number().min(0).max(1_000_000),
  outputPerMTok: z.number().min(0).max(1_000_000),
  currency: z.string().min(3).max(8).default('USD'),
});

const patchSchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  description: z.string().max(400).optional(),
  enabled: z.boolean().optional(),
  freeTier: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  capabilities: capabilitiesSchema.optional(),
  contextWindow: z.number().int().min(1024).max(2_000_000).nullish(),
  maxOutputTokens: z.number().int().min(64).max(262_144).nullish(),
  aliases: z.array(z.string().min(1).max(160)).max(32).optional(),
  streamSupported: z.boolean().optional(),
  // model-specific pricing (currency per 1M tokens); null clears it (unknown cost)
  pricing: pricingSchema.nullish(),
});

export async function PATCH(req: Request, { params }: Params) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'bad_json', 'Request body must be valid JSON.');
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return fail(400, 'invalid_request', 'Invalid model update.', { details: parsed.error.flatten() });
  try {
    const model = await updateModelConfig(id, parsed.data);
    if (!model) return fail(404, 'not_found', 'Model not found.');
    // historical pricing trail: every pricing change snapshots a CostRate
    // row (model-wide, admin source) — billing resolves the latest one
    if (parsed.data.pricing) {
      await db.costRate.create({
        data: {
          modelId: model.modelId,
          inputPerMTok: String(parsed.data.pricing.inputPerMTok),
          outputPerMTok: String(parsed.data.pricing.outputPerMTok),
          currency: parsed.data.pricing.currency,
          source: 'admin',
          effectiveFrom: new Date(),
        },
      }).catch(() => undefined);
    }
    return ok({ model });
  } catch {
    return fail(404, 'not_found', 'Model not found.');
  }
}

export async function DELETE(req: Request, { params }: Params) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const { id } = await params;
  const row = await db.modelConfig.findUnique({ where: { id } });
  if (!row) return fail(404, 'not_found', 'Model not found.');
  await deleteModelConfig(id);
  return ok({ deleted: true });
}
