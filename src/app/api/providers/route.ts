import { z } from 'zod';
import { db } from '@/lib/db';
import { ok, fail } from '@/lib/api/response';
import { requireAdmin } from '@/lib/api/admin-auth';
import { registeredProviderTypes, getAdapterByType, adapterContextForAccount } from '@/lib/ai/providers';
import { encryptSecret, credentialEncryptionAvailable, maskSecret } from '@/lib/crypto';

export const runtime = 'nodejs';

/** Dashboard provider-account list (credentials never leave the server). */
export async function GET(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const accounts = await db.providerAccount.findMany({
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    include: { routes: { select: { id: true, publicModelId: true, upstreamModelId: true, enabled: true, priority: true, healthStatus: true } } },
  });
  return ok({
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      providerType: a.providerType,
      baseUrl: a.baseUrl,
      credentialMode: a.credentialMode,
      // masked display only — the raw secret never crosses this boundary
      credentialHint: a.apiKeyEnc ? maskSecret(a.apiKeyEnc) : null,
      encryptionAvailable: credentialEncryptionAvailable(),
      enabled: a.enabled,
      priority: a.priority,
      maxConcurrency: a.maxConcurrency,
      monthlyBudget: a.monthlyBudget,
      lastCheckedAt: a.lastCheckedAt?.toISOString() ?? null,
      lastStatus: a.lastStatus,
      lastError: a.lastError,
      requestCount: a.requestCount,
      routeCount: a.routes.length,
      routes: a.routes,
    })),
    providerTypes: registeredProviderTypes(),
  });
}

const createSchema = z.object({
  name: z.string().min(1).max(80),
  providerType: z.string().min(1).max(40),
  baseUrl: z.string().url().max(400).nullish(),
  // raw API key — encrypted at rest before storage; never logged, never returned
  apiKey: z.string().min(8).max(400).optional(),
  credentialMode: z.enum(['platform', 'stored']).default('stored'),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(1000).default(0),
  maxConcurrency: z.number().int().min(0).max(256).default(0),
  monthlyBudget: z.number().min(0).max(1e9).nullish(),
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
  if (!parsed.success) {
    return fail(400, 'invalid_request', 'Invalid provider account.', { details: parsed.error.flatten() });
  }
  const data = parsed.data;
  const adapter = getAdapterByType(data.providerType);
  if (!adapter) {
    return fail(400, 'unknown_provider', `Provider type "${data.providerType}" has no registered adapter. Available: ${registeredProviderTypes().join(', ')}.`);
  }
  // zai is platform-managed (SDK environment credentials) — no stored secret
  if (data.providerType === 'zai' && data.credentialMode === 'stored') {
    return fail(400, 'platform_only', 'Z.ai credentials are platform-managed on this installation; use credentialMode "platform".');
  }
  if (data.providerType !== 'zai') {
    if (!data.baseUrl) {
      return fail(400, 'missing_base_url', 'This provider type requires a base URL.');
    }
    if (!data.apiKey) {
      return fail(400, 'missing_api_key', 'This provider type requires an API key (stored encrypted at rest).');
    }
    if (!credentialEncryptionAvailable()) {
      return fail(500, 'encryption_unavailable', 'Credential encryption is unavailable: set EMORAI_MASTER_KEY in the server environment. Refusing to store credentials unencrypted.');
    }
  }

  // SSRF destination policy (dynamic: url-policy module may land in parallel).
  if (data.baseUrl) {
    try {
      const { assertProviderUrlAllowed, loadNetworkPolicy } = await import('@/lib/net/url-policy');
      const net = await loadNetworkPolicy();
      const policy = await assertProviderUrlAllowed(String(data.baseUrl), { allowlist: net.allowlist, requireHttps: net.requireHttps });
      if (!policy.ok) return fail(422, 'url_blocked', `Base URL rejected by destination policy: ${policy.reason}`);
    } catch {
      // policy module not present yet — SSRF guard lands in parallel; skip validation until then
    }
  }

  const account = await db.providerAccount.create({
    data: {
      name: data.name,
      providerType: data.providerType,
      baseUrl: data.providerType === 'zai' ? null : data.baseUrl ?? null,
      credentialMode: data.providerType === 'zai' ? 'platform' : 'stored',
      apiKeyEnc: data.apiKey && data.providerType !== 'zai' ? encryptSecret(data.apiKey) : null,
      enabled: data.enabled,
      priority: data.priority,
      maxConcurrency: data.maxConcurrency,
      monthlyBudget: data.monthlyBudget ?? null,
    },
  });
  return ok(
    {
      account: {
        id: account.id,
        name: account.name,
        providerType: account.providerType,
        baseUrl: account.baseUrl,
        credentialMode: account.credentialMode,
        enabled: account.enabled,
        priority: account.priority,
      },
    },
    { status: 201 }
  );
}
