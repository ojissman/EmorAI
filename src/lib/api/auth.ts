import { db } from '@/lib/db';
import { hashApiKey, isValidKeyFormat, normalizeScopes } from '@/lib/api-keys';
import { rateLimit } from '@/lib/rate-limit';
import { getSettings } from '@/lib/settings';
import { monthlyUsageForKey, nextMonthStart } from '@/lib/usage';

// ─── Auth result ─────────────────────────────────────────────────────────────
// Protocol-agnostic: each wire protocol (OpenAI / Anthropic) shapes the error
// envelope itself so both stay byte-compatible with their native SDKs.

export type AuthenticatedKey = {
  apiKeyId: string;
  apiKeyName: string;
  scopes: string[];
  rateLimitPerMin: number | null;
  monthlyRequestLimit: number | null;
  monthlyTokenLimit: number | null;
  allowedModels: string[] | null;
};

export type AuthFailure = {
  status: number;
  code: string;
  message: string;
  retryAfterSec?: number;
  // Anthropic-style error type for the /v1/messages envelope
  anthropicType: 'authentication_error' | 'permission_error' | 'not_found_error' | 'rate_limit_error' | 'invalid_request_error';
  // OpenAI-style error type
  openaiType: 'invalid_request_error' | 'authentication_error' | 'rate_limit_error' | 'permission_error';
};

export type V1Auth =
  | { ok: true; key: AuthenticatedKey }
  | { ok: false; error: AuthFailure };

/** Extracts the bearer token from Authorization or the Anthropic x-api-key header. */
export function extractToken(req: Request): string {
  const header = req.headers.get('authorization') ?? '';
  if (header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) return token;
  }
  // Anthropic clients (Claude Code, the Anthropic SDKs) authenticate with
  // x-api-key. Accepted alongside Bearer for every gateway endpoint.
  const xApiKey = req.headers.get('x-api-key');
  if (xApiKey && xApiKey.trim()) return xApiKey.trim();
  return '';
}

/**
 * Authenticates an EmorAI gateway request. Enforces:
 *   1. key format + hash lookup + revocation status
 *   2. per-key rate-limit override (or global setting)
 *   3. monthly request / token limits
 * Provider credentials are never involved in this path, and never leave the
 * server — external apps only ever see EmorAI keys.
 */
export async function authenticateV1(req: Request): Promise<V1Auth> {
  const token = extractToken(req);
  if (!token) {
    return {
      ok: false,
      error: {
        status: 401,
        code: 'missing_api_key',
        message:
          'Include your EmorAI API key as: Authorization: Bearer emr_xxx (OpenAI-compatible) or x-api-key: emr_xxx (Anthropic-compatible).',
        anthropicType: 'authentication_error',
        openaiType: 'authentication_error',
      },
    };
  }
  if (!isValidKeyFormat(token)) {
    return {
      ok: false,
      error: {
        status: 401,
        code: 'invalid_api_key',
        message: 'The presented API key is malformed. EmorAI keys look like emr_<48 hex chars>.',
        anthropicType: 'authentication_error',
        openaiType: 'authentication_error',
      },
    };
  }
  const keyHash = hashApiKey(token);
  const key = await db.apiKey.findUnique({ where: { keyHash } });
  if (!key) {
    return {
      ok: false,
      error: {
        status: 401,
        code: 'invalid_api_key',
        message: 'API key not recognized. It may have been deleted from the dashboard.',
        anthropicType: 'authentication_error',
        openaiType: 'authentication_error',
      },
    };
  }
  if (key.revokedAt) {
    return {
      ok: false,
      error: {
        status: 401,
        code: 'key_revoked',
        message: `API key "${key.name}" has been revoked. Generate a new key in the EmorAI dashboard.`,
        anthropicType: 'authentication_error',
        openaiType: 'authentication_error',
      },
    };
  }

  const scopes = normalizeScopes(key.scopes);
  const allowedModels = Array.isArray(key.allowedModels)
    ? (key.allowedModels as unknown[]).filter((m): m is string => typeof m === 'string')
    : null;

  // ── Monthly usage limits ────────────────────────────────────────────────
  if (key.monthlyRequestLimit !== null || key.monthlyTokenLimit !== null) {
    const monthly = await monthlyUsageForKey(key.id);
    const resetAt = nextMonthStart();
    if (key.monthlyRequestLimit !== null && monthly.requests >= key.monthlyRequestLimit) {
      return {
        ok: false,
        error: {
          status: 429,
          code: 'monthly_request_limit_exceeded',
          message: `Monthly request limit reached for key "${key.name}" (${monthly.requests}/${key.monthlyRequestLimit}). Resets at ${resetAt.toISOString()}.`,
          retryAfterSec: Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000)),
          anthropicType: 'rate_limit_error',
          openaiType: 'rate_limit_error',
        },
      };
    }
    if (key.monthlyTokenLimit !== null && monthly.totalTokens >= key.monthlyTokenLimit) {
      return {
        ok: false,
        error: {
          status: 429,
          code: 'monthly_token_limit_exceeded',
          message: `Monthly token limit reached for key "${key.name}" (${monthly.totalTokens}/${key.monthlyTokenLimit} tokens). Resets at ${resetAt.toISOString()}.`,
          retryAfterSec: Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000)),
          anthropicType: 'rate_limit_error',
          openaiType: 'rate_limit_error',
        },
      };
    }
  }

  // ── Rate limiting (per-key override or global setting) ──────────────────
  const settings = await getSettings();
  const limit = key.rateLimitPerMin ?? settings.apiRateLimitPerMin;
  const rl = rateLimit(`v1:${key.id}`, limit, 60_000);
  if (!rl.ok) {
    return {
      ok: false,
      error: {
        status: 429,
        code: 'rate_limited',
        message: `Rate limit exceeded (${limit} requests/minute for this key). Retry after ${rl.retryAfterSec}s.`,
        retryAfterSec: rl.retryAfterSec,
        anthropicType: 'rate_limit_error',
        openaiType: 'rate_limit_error',
      },
    };
  }

  // Bump lastUsedAt without blocking the response path.
  void db.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);

  return {
    ok: true,
    key: {
      apiKeyId: key.id,
      apiKeyName: key.name,
      scopes,
      rateLimitPerMin: key.rateLimitPerMin,
      monthlyRequestLimit: key.monthlyRequestLimit,
      monthlyTokenLimit: key.monthlyTokenLimit,
      allowedModels,
    },
  };
}

/** Checks a scope on an authenticated key. */
export function requireScope(auth: V1Auth, scope: string): AuthFailure | null {
  if (auth.ok) return null;
  return auth.error;
}

/** Scope check for authenticated keys: returns an AuthFailure or null. */
export function scopeFailure(key: AuthenticatedKey, scope: string): AuthFailure | null {
  if (key.scopes.includes(scope)) return null;
  return {
    status: 403,
    code: 'insufficient_scope',
    message: `This API key is not permitted to use "${scope}". Edit the key's permissions in the EmorAI dashboard.`,
    anthropicType: 'permission_error',
    openaiType: 'permission_error',
  };
}

/** Model allowlist check for authenticated keys: returns an AuthFailure or null. */
export function modelAllowFailure(key: AuthenticatedKey, modelId: string): AuthFailure | null {
  if (!key.allowedModels) return null;
  const allowed = key.allowedModels.some((m) => m.toLowerCase() === modelId.toLowerCase());
  if (allowed) return null;
  return {
    status: 403,
    code: 'model_not_allowed',
    message: `Model "${modelId}" is not on this key's allowed-models list. Allowed: ${key.allowedModels.join(', ')}.`,
    anthropicType: 'permission_error',
    openaiType: 'permission_error',
  };
}
