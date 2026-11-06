import { createHash, randomBytes, timingSafeEqual } from 'crypto';

export const API_KEY_PREFIX = 'emr_';

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
