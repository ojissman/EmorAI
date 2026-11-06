import { db } from '@/lib/db';
import { hashApiKey, isValidKeyFormat } from '@/lib/api-keys';
import { rateLimit } from '@/lib/rate-limit';
import { getSettings } from '@/lib/settings';
import { fail } from '@/lib/api/response';

export type V1Auth =
  | { ok: true; apiKeyId: string; apiKeyName: string }
  | { ok: false; response: ReturnType<typeof fail> };

/**
 * Authenticates an EmorAI developer API request via `Authorization: Bearer emr_…`.
 * Enforces format validation, hash lookup, revocation status, and per-key
 * rate limiting. Provider credentials are never involved in this path.
 */
export async function authenticateV1(req: Request): Promise<V1Auth> {
  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    return {
      ok: false,
      response: fail(401, 'missing_api_key', 'Include your EmorAI API key as: Authorization: Bearer emr_xxx'),
    };
  }
  if (!isValidKeyFormat(token)) {
    return {
      ok: false,
      response: fail(401, 'invalid_api_key', 'The presented API key is malformed. EmorAI keys look like emr_<48 hex chars>.'),
    };
  }
  const keyHash = hashApiKey(token);
  const key = await db.apiKey.findUnique({ where: { keyHash } });
  if (!key) {
    return { ok: false, response: fail(401, 'invalid_api_key', 'API key not recognized. It may have been deleted from the dashboard.') };
  }
  if (key.revokedAt) {
    return { ok: false, response: fail(401, 'key_revoked', `API key "${key.name}" has been revoked. Generate a new key in the EmorAI dashboard.`) };
  }

  const settings = await getSettings();
  const rl = rateLimit(`v1:${key.id}`, settings.apiRateLimitPerMin, 60_000);
  if (!rl.ok) {
    return {
      ok: false,
      response: fail(429, 'rate_limited', `Rate limit exceeded (${settings.apiRateLimitPerMin} requests/minute for this key). Retry after ${rl.retryAfterSec}s.`, {
        retry_after_sec: rl.retryAfterSec,
      }),
    };
  }

  // Bump lastUsedAt without blocking the response path.
  void db.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);

  return { ok: true, apiKeyId: key.id, apiKeyName: key.name };
}
