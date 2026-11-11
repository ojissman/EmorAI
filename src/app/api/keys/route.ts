import { z } from 'zod';
import { db } from '@/lib/db';
import { generateApiKey, API_KEY_SCOPES, normalizeScopes } from '@/lib/api-keys';
import { ok, fail } from '@/lib/api/response';
import { requireAdmin } from '@/lib/api/admin-auth';
import { serializeApiKey } from '@/lib/serialize';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const keys = await db.apiKey.findMany({ orderBy: { createdAt: 'desc' } });
  return ok({ keys: keys.map(serializeApiKey) });
}

const createSchema = z.object({
  name: z.string().min(1).max(60).trim(),
  scopes: z.array(z.enum(API_KEY_SCOPES)).max(API_KEY_SCOPES.length).optional(),
  rateLimitPerMin: z.number().int().min(1).max(10_000).nullish(),
  monthlyRequestLimit: z.number().int().min(1).max(10_000_000).nullish(),
  monthlyTokenLimit: z.number().int().min(1).max(1_000_000_000).nullish(),
  allowedModels: z.array(z.string().min(1).max(160)).max(64).nullish(),
});

export async function POST(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'bad_json', 'Request body must be valid JSON.');
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return fail(400, 'invalid_request', 'Invalid key definition.', { details: parsed.error.flatten() });

  const count = await db.apiKey.count({ where: { revokedAt: null } });
  if (count >= 50) {
    return fail(409, 'too_many_keys', 'Key limit reached (50 active keys). Revoke or delete unused keys first.');
  }

  const generated = generateApiKey();
  const scopes = parsed.data.scopes ? normalizeScopes(parsed.data.scopes) : undefined;
  const row = await db.apiKey.create({
    data: {
      name: parsed.data.name,
      keyHash: generated.keyHash,
      prefix: generated.prefix,
      ...(scopes ? { scopes } : {}),
      ...(parsed.data.rateLimitPerMin !== undefined && parsed.data.rateLimitPerMin !== null
        ? { rateLimitPerMin: parsed.data.rateLimitPerMin }
        : {}),
      ...(parsed.data.monthlyRequestLimit !== undefined && parsed.data.monthlyRequestLimit !== null
        ? { monthlyRequestLimit: parsed.data.monthlyRequestLimit }
        : {}),
      ...(parsed.data.monthlyTokenLimit !== undefined && parsed.data.monthlyTokenLimit !== null
        ? { monthlyTokenLimit: parsed.data.monthlyTokenLimit }
        : {}),
      ...(parsed.data.allowedModels !== undefined && parsed.data.allowedModels !== null
        ? { allowedModels: parsed.data.allowedModels }
        : {}),
    },
  });

  // Plaintext is returned exactly once, only at creation time.
  return ok({ key: serializeApiKey(row), plaintext: generated.plaintext }, { status: 201 });
}
