import { db } from '@/lib/db';
import { ok, fail } from '@/lib/api/response';
import { getAdapterByType, adapterContextForAccount } from '@/lib/ai/providers';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/** Validates an account's credentials with a real (non-billable) provider call. */
export async function POST(_req: Request, { params }: Params) {
  const { id } = await params;
  const account = await db.providerAccount.findUnique({ where: { id } });
  if (!account) return fail(404, 'not_found', 'Provider account not found.');
  const adapter = getAdapterByType(account.providerType);
  if (!adapter) return fail(400, 'unknown_provider', `No adapter for "${account.providerType}".`);

  let ctx;
  try {
    ctx = adapterContextForAccount(account);
  } catch (e) {
    await db.providerAccount.update({
      where: { id },
      data: { lastCheckedAt: new Date(), lastStatus: 'error', lastError: String((e as Error).message ?? e).slice(0, 300) },
    });
    return fail(500, 'credential_unreadable', String((e as Error).message ?? e).slice(0, 300));
  }

  const result = await adapter.validateCredentials(ctx);
  const health = result.ok ? await adapter.checkHealth(ctx) : { ok: false, latencyMs: 0, message: result.detail };
  await db.providerAccount.update({
    where: { id },
    data: {
      lastCheckedAt: new Date(),
      lastStatus: result.ok ? 'ok' : 'error',
      lastError: result.ok ? null : (result.detail ?? result.message).slice(0, 300),
    },
  });
  return ok({ validation: result, health });
}
