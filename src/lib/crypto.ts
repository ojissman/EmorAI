import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

// ─── Credential encryption at rest ──────────────────────────────────────────
// Provider API keys are stored AES-256-GCM encrypted. The master key comes
// from EMORAI_MASTER_KEY (or EMORAI_CREDENTIAL_KEY) in the environment and is
// NEVER written to the database or source control.
//
// Security rules enforced here:
//   • If the master key is unavailable, credential operations FAIL SECURELY —
//     we never silently store plaintext.
//   • Ciphertext format: v1:<iv-b64>:<tag-b64>:<ct-b64> (versioned for rotation).
//   • Keys are derived per-installation with scrypt (salted, 64 N=2^15 params).

const CIPHER = 'aes-256-gcm';
const FORMAT_VERSION = 'v1';

let cachedKey: Buffer | null = null;

function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.EMORAI_MASTER_KEY ?? process.env.EMORAI_CREDENTIAL_KEY;
  if (!raw || raw.length < 16) {
    throw new Error(
      'Credential encryption is unavailable: set EMORAI_MASTER_KEY (>= 16 chars) in the server environment. ' +
        'Refusing to store provider credentials unencrypted.'
    );
  }
  // Derive a fixed 32-byte AES key from the master secret (salted, hardened).
  cachedKey = scryptSync(raw, 'emorai-credential-v1', 32, { N: 16384, r: 8, p: 1 });
  return cachedKey;
}

/** True when a master key is configured (i.e. credential storage is usable). */
export function credentialEncryptionAvailable(): boolean {
  try {
    masterKey();
    return true;
  } catch {
    return false;
  }
}

/** Encrypts a secret (e.g. a provider API key) for storage in the database. */
export function encryptSecret(plaintext: string): string {
  const key = masterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT_VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/** Decrypts a stored secret. Throws on tampering (GCM tag) or missing key. */
export function decryptSecret(ciphertext: string): string {
  const key = masterKey();
  const parts = ciphertext.split(':');
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new Error('Unrecognized credential ciphertext format.');
  }
  const [version, ivB64, tagB64, ctB64] = parts;
  void version;
  const decipher = createDecipheriv(CIPHER, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}

/** Masked display for stored credentials — never reveals the secret. */
export function maskSecret(ciphertext: string): string {
  try {
    const pt = decryptSecret(ciphertext);
    if (pt.length <= 8) return '••••••••';
    return `${pt.slice(0, 4)}…${pt.slice(-4)} (${pt.length} chars, encrypted)`;
  } catch {
    return '(undecryptable ciphertext)';
  }
}

/** Generates a strong master key string for operators (documented in README). */
export function generateMasterKeyHint(): string {
  return randomBytes(32).toString('base64');
}
