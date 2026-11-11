import { z } from 'zod';
import { db } from '@/lib/db';
import { ok, fail } from '@/lib/api/response';
import { maskSecret, encryptSecret, credentialEncryptionAvailable } from '@/lib/crypto';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const account = await db.providerAccount.findUnique({ where: { id }, include: { routes: true } });
  if (!account) return fail(404, 'not_found', 'Provider account not found.');
  return ok({
    account: {
      ...account,
      apiKeyEnc: undefined, // ciphertext never leaves the server
      credentialHint: account.apiKeyEnc ? maskSecret(account.apiKeyEnc) : null,
      encryptionAvailable: credentialEncryptionAvailable(),
    },
  });
}

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  baseUrl: z.string().url().max(400).nullish(),
  // rotating the credential: new raw key → encrypted at rest
  apiKey: z.string().min(8).max(400).optional(),
  clearApiKey: z.boolean().optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  maxConcurrency: z.number().int().min(0).max(256).optional(),
  monthlyBudget: z.number().min(0).max(1e9).nullish(),
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
    return fail(400, 'invalid_request', 'Invalid account patch.', { details: parsed.error.flatten() });
  }
  const data = parsed.data;
  const account = await db.providerAccount.findUnique({ where: { id } });
  if (!account) return fail(404, 'not_found', 'Provider account not found.');

  if (account.providerType === 'zai' && (data.apiKey || data.clearApiKey)) {
    return fail(400, 'platform_only', 'Z.ai credentials are platform-managed; they cannot be edited here.');
  }
  if (data.apiKey && !credentialEncryptionAvailable()) {
    return fail(500, 'encryption_unavailable', 'Set EMORAI_MASTER_KEY before storing credentials.');
  }

  const updated = await db.providerAccount.update({
    where: { id },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.baseUrl !== undefined ? { baseUrl: data.baseUrl ?? null } : {}),
      ...(data.apiKey ? { apiKeyEnc: encryptSecret(data.apiKey), credentialMode: 'stored' as const } : {}),
      ...(data.clearApiKey ? { apiKeyEnc: null } : {}),
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      ...(data.priority !== undefined ? { priority: data.priority } : {}),
      ...(data.maxConcurrency !== undefined ? { maxConcurrency: data.maxConcurrency } : {}),
      ...(data.monthlyBudget !== undefined ? { monthlyBudget: data.monthlyBudget ?? null } : {}),
    },
  });
  return ok({
    account: {
      id: updated.id,
      name: updated.name,
      providerType: updated.providerType,
      baseUrl: updated.baseUrl,
      credentialMode: updated.credentialMode,
      credentialHint: updated.apiKeyEnc ? maskSecret(updated.apiKeyEnc) : null,
      enabled: updated.enabled,
      priority: updated.priority,
      maxConcurrency: updated.maxConcurrency,
      monthlyBudget: updated.monthlyBudget,
    },
  });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  const routes = await db.modelRoute.count({ where: { providerAccountId: id } });
  if (routes > 0) {
    return fail(409, 'in_use', `${routes} route(s) still reference this account. Delete or re-point them first.`);
  }
  const existing = await db.providerAccount.findUnique({ where: { id } });
  if (!existing) return fail(404, 'not_found', 'Provider account not found.');
  await db.providerAccount.delete({ where: { id } });
  return ok({ deleted: true });
}
