// ─── Encrypted secrets-bundle mechanics (shared) ─────────────────────────────
//
// Single home for the bundle format used by BOTH:
//   • src/lib/self-heal.ts      — boot-time restore after a platform wipe
//   • jobs 'secrets-snapshot'   — periodic refresh so restores stay recent
//
// Format contract (MUST match scripts/secrets.sh exactly):
//   tar -C ROOT -czf bundle.tar.gz .env db/custom.db db/uploads
//   openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
//          -in bundle.tar.gz -out bundle.enc -pass env:EMORAI_SECRET_PASSPHRASE
//
// Passphrase sources (first wins): EMORAI_SECRET_PASSPHRASE env var, then the
// git-tracked secrets/recovery.passphrase file. See self-heal.ts for the
// security posture of committing that file.

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

export const ROOT = process.cwd();
export const BUNDLE_PATH = path.join(ROOT, 'secrets', 'emorai-secrets.tar.gz.enc');
export const RECOVERY_PASSPHRASE_FILE = path.join(ROOT, 'secrets', 'recovery.passphrase');
export const BUNDLE_ITER = 600000;

/** Child-process helper: buffer stdout, stderr into the error when it fails. */
export function execFileAsync(
  cmd: string,
  args: readonly string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'buffer', ...opts }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr) }));
      else resolve({ stdout, stderr: String(stderr) });
    });
  });
}

/** Passphrase: env var first, then the git-tracked recovery file. Null = unavailable. */
export async function readRecoveryPassphrase(): Promise<string | null> {
  const fromEnv = process.env.EMORAI_SECRET_PASSPHRASE;
  if (fromEnv && fromEnv.length >= 8) return fromEnv;
  try {
    const raw = (await fs.readFile(RECOVERY_PASSPHRASE_FILE, 'utf8')).trim();
    if (raw.length >= 8) return raw;
  } catch {
    /* no recovery file — manual restore required */
  }
  return null;
}

/**
 * Packs .env + db/custom.db + db/uploads into a fresh encrypted bundle and
 * atomically replaces secrets/emorai-secrets.tar.gz.enc (staged in a temp
 * dir, renamed into place). The WAL is NOT checkpointed here — callers do
 * that first through their own live Prisma connection.
 */
export async function snapshotBundle(passphrase: string): Promise<{ bytes: number }> {
  const tmp = await fs.mkdtemp(path.join(ROOT, '.secrets-snapshot-'));
  try {
    // tar fails on missing members — the scaffold may lack db/uploads
    await fs.mkdir(path.join(ROOT, 'db', 'uploads'), { recursive: true });
    const tarPath = path.join(tmp, 'bundle.tar.gz');
    await execFileAsync('tar', ['-C', ROOT, '-czf', tarPath, '.env', 'db/custom.db', 'db/uploads']);
    const encPath = path.join(tmp, 'bundle.enc');
    await execFileAsync(
      'openssl',
      ['enc', '-aes-256-cbc', '-pbkdf2', '-iter', String(BUNDLE_ITER), '-salt', '-in', tarPath, '-out', encPath, '-pass', 'env:EMORAI_SECRET_PASSPHRASE'],
      { env: { ...process.env, EMORAI_SECRET_PASSPHRASE: passphrase } },
    );
    await fs.chmod(encPath, 0o644);
    await fs.mkdir(path.dirname(BUNDLE_PATH), { recursive: true });
    await fs.rename(encPath, BUNDLE_PATH);
    const st = await fs.stat(BUNDLE_PATH);
    return { bytes: st.size };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Best-effort bundle age in minutes (logs + alerts). */
export async function bundleAgeMinutes(): Promise<number | null> {
  try {
    const st = await fs.stat(BUNDLE_PATH);
    return Math.max(0, Math.round((Date.now() - st.mtimeMs) / 60_000));
  } catch {
    return null;
  }
}
