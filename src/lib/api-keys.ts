import { createHash, randomBytes, timingSafeEqual } from 'crypto';

export const API_KEY_PREFIX = 'emr_';

// ─── Permission scopes ───────────────────────────────────────────────────────
// Enforced on every gateway request. A key must hold the scope matching the
// capability it is asking for (chat, tools, vision, media, models, usage).

export const API_KEY_SCOPES = ['chat', 'tools', 'vision', 'media', 'models', 'usage'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const ALL_SCOPES: ApiKeyScope[] = [...API_KEY_SCOPES];

export function normalizeScopes(raw: unknown): ApiKeyScope[] {
  if (!Array.isArray(raw)) return ALL_SCOPES;
  const seen = new Set<ApiKeyScope>();
  for (const item of raw) {
    if (typeof item === 'string' && (API_KEY_SCOPES as readonly string[]).includes(item)) {
      seen.add(item as ApiKeyScope);
    }
  }
  return seen.size > 0 ? [...seen] : ALL_SCOPES;
}

export function hasScope(scopes: string[], required: ApiKeyScope): boolean {
  return scopes.includes(required);
}

export type GeneratedKey = {
  plaintext: string;
  keyHash: string;
  prefix: string;
};

/**
 * Generates a cryptographically secure EmorAI API key.
 * Plaintext is shown to the administrator exactly once; only the SHA-256
 * hash and a short display prefix are ever persisted.
 */
export function generateApiKey(): GeneratedKey {
  const body = randomBytes(24).toString('hex'); // 48 hex chars
  const plaintext = `${API_KEY_PREFIX}${body}`;
  return {
    plaintext,
    keyHash: hashApiKey(plaintext),
    prefix: `${API_KEY_PREFIX}${body.slice(0, 6)}…`,
  };
}

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** Constant-time comparison of a presented key against the stored hash. */
export function verifyApiKeyHash(plaintext: string, storedHash: string): boolean {
  const presented = Buffer.from(hashApiKey(plaintext), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  if (presented.length !== stored.length) return false;
  return timingSafeEqual(presented, stored);
}

export function isValidKeyFormat(key: string): boolean {
  return /^emr_[0-9a-f]{48}$/.test(key);
}
