import { z } from 'zod';
import { db } from '@/lib/db';
import { updateModelConfig, deleteModelConfig } from '@/lib/model-registry';
import { ok, fail } from '@/lib/api/response';

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

const patchSchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  description: z.string().max(400).optional(),
  enabled: z.boolean().optional(),
  freeTier: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  capabilities: capabilitiesSchema.optional(),
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
  if (!parsed.success) return fail(400, 'invalid_request', 'Invalid model update.', { details: parsed.error.flatten() });
  try {
    const model = await updateModelConfig(id, parsed.data);
    if (!model) return fail(404, 'not_found', 'Model not found.');
    return ok({ model });
  } catch {
    return fail(404, 'not_found', 'Model not found.');
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  const row = await db.modelConfig.findUnique({ where: { id } });
  if (!row) return fail(404, 'not_found', 'Model not found.');
  await deleteModelConfig(id);
  return ok({ deleted: true });
}
