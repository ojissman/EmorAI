import { z } from 'zod';
import { db } from '@/lib/db';
import { API_KEY_SCOPES, normalizeScopes } from '@/lib/api-keys';
import { ok, fail } from '@/lib/api/response';
import { serializeApiKey } from '@/lib/serialize';
import { monthlyUsageForKey } from '@/lib/usage';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  action: z.enum(['revoke', 'restore']).optional(),
  name: z.string().min(1).max(60).trim().optional(),
  scopes: z.array(z.enum(API_KEY_SCOPES)).max(API_KEY_SCOPES.length).optional(),
  rateLimitPerMin: z.number().int().min(1).max(10_000).nullish(),
  monthlyRequestLimit: z.number().int().min(1).max(10_000_000).nullish(),
  monthlyTokenLimit: z.number().int().min(1).max(1_000_000_000).nullish(),
  allowedModels: z.array(z.string().min(1).max(160)).max(64).nullish(),
});

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const row = await db.apiKey.findUnique({ where: { id } });
  if (!row) return fail(404, 'not_found', 'API key not found.');
  const monthly = await monthlyUsageForKey(id);
  return ok({ key: serializeApiKey(row), monthly });
}

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'bad_json', 'Request body must be valid JSON.');
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return fail(400, 'invalid_request', 'Invalid key update.', { details: parsed.error.flatten() });

  try {
    const data: Record<string, unknown> = {};
    if (parsed.data.action === 'revoke') data.revokedAt = new Date();
    if (parsed.data.action === 'restore') data.revokedAt = null;
    if (parsed.data.name) data.name = parsed.data.name;
    if (parsed.data.scopes) data.scopes = normalizeScopes(parsed.data.scopes);
    if (parsed.data.rateLimitPerMin !== undefined) data.rateLimitPerMin = parsed.data.rateLimitPerMin;
    if (parsed.data.monthlyRequestLimit !== undefined) data.monthlyRequestLimit = parsed.data.monthlyRequestLimit;
    if (parsed.data.monthlyTokenLimit !== undefined) data.monthlyTokenLimit = parsed.data.monthlyTokenLimit;
    if (parsed.data.allowedModels !== undefined) data.allowedModels = parsed.data.allowedModels;
    const row = await db.apiKey.update({ where: { id }, data });
    return ok({ key: serializeApiKey(row) });
  } catch {
    return fail(404, 'not_found', 'API key not found.');
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    await db.apiKey.delete({ where: { id } });
    return ok({ deleted: true });
  } catch {
    return fail(404, 'not_found', 'API key not found.');
  }
}
