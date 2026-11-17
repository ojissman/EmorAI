// ─── Boot-time workspace self-heal ───────────────────────────────────────────
//
// WHY THIS EXISTS
// The z.ai platform recycles idle workspaces. A recycle keeps the project
// source and git history but RESETS runtime state: .env is regenerated to
// the scaffold default (DATABASE_URL only — no EMORAI_MASTER_KEY, no admin
// password) and db/custom.db is reset to an empty schema (every API key,
// provider account, model route and conversation gone). To a client like
// ZCode, whose emr_ key was deleted with the database, the gateway then
// answers 401 "API key not recognized" — and dashboard chat fails too
// because no providers/routes exist. This has now happened three times.
//
// THE FIX
// The git-tracked encrypted bundle (secrets/emorai-secrets.tar.gz.enc — see
// scripts/secrets.sh) always carries the last-known-good .env + database.
// This module runs ONCE PER SERVER PROCESS, before any request is served
// (called from src/instrumentation.ts register()):
//
//   1. Detect a wiped workspace (no provider accounts / no API keys /
//      missing master key in the environment).
//   2. Restore the affected files from the encrypted bundle — workspace
//      copy first, `git show HEAD:secrets/…` as fallback when the platform
//      swept the workspace copy too.
//   3. Inject the restored environment variables into process.env so
//      modules that read them lazily (crypto.ts, admin auth) see the real
//      values even though Next already booted on the scaffold .env.
//   4. Record an AlertEvent so the recovery is visible in the ops tab.
//
// Passphrase sources (first wins): EMORAI_SECRET_PASSPHRASE env var, then
// the git-tracked secrets/recovery.passphrase file. Without a passphrase
// the heal is skipped with clear guidance — the server still serves.
//
// SECURITY POSTURE (read before changing)
// The bundle contains .env (admin password, master key) and the database.
// Committing secrets/recovery.passphrase therefore makes the bundle
// decryptable by anyone who can read this repository. That tradeoff is
// deliberate: continuity of a personal gateway over confidentiality of
// sandbox-local secrets. The real upstream provider is platform-managed
// (ambient credentials — nothing stored), and emr_ keys persist only as
// SHA-256 hashes, so nothing in the bundle grants upstream access. To lock
// recovery back down: delete secrets/recovery.passphrase; the app then
// falls back to manual restore via scripts/secrets.sh decrypt.

import { PrismaClient } from '@prisma/client';
import {
  BUNDLE_PATH,
  BUNDLE_ITER,
  execFileAsync,
  readRecoveryPassphrase,
  bundleAgeMinutes,
} from '@/lib/secrets-bundle';
import { promises as fs } from 'fs';
import path from 'path';

const ROOT = process.cwd();
const ENV_FILE = path.join(ROOT, '.env');

export type SelfHealResult =
  | { status: 'healthy'; envOk: boolean; dbOk: boolean }
  | { status: 'restored'; envRestored: boolean; dbRestored: boolean; bundleAgeMin: number | null; alertWritten: boolean }
  | { status: 'skipped' | 'failed'; reason: string };

// ─── Detection ───────────────────────────────────────────────────────────────

/**
 * Wipe fingerprints, read through a THROWAWAY PrismaClient — never the db.ts
 * singleton, which must not open a connection until the file is restored.
 *   • dbWiped: zero provider accounts OR zero API keys. A functioning
 *     install always has the platform-managed provider and at least one
 *     key; a wiped DB has neither (query errors — missing/foreign file —
 *     also count as wiped).
 *   • envBroken: EMORAI_MASTER_KEY absent — the scaffold .env carries only
 *     DATABASE_URL, so credential crypto and admin login would be down.
 */
async function detectState(): Promise<{ envBroken: boolean; dbWiped: boolean; dbQueryOk: boolean }> {
  const envBroken = !process.env.EMORAI_MASTER_KEY || process.env.EMORAI_MASTER_KEY.length < 16;
  let dbWiped = true;
  let dbQueryOk = false;
  const probe = new PrismaClient();
  try {
    const providers = await probe.providerAccount.count();
    const keys = await probe.apiKey.count();
    dbWiped = providers === 0 || keys === 0;
    dbQueryOk = true;
  } catch {
    dbWiped = true; // missing file / not-a-database / empty schema — all wiped
  } finally {
    await probe.$disconnect().catch(() => undefined);
  }
  return { envBroken, dbWiped, dbQueryOk };
}

// ─── Bundle sources & passphrase ────────────────────────────────────────────

/** Reads the bundle bytes: workspace file first, git HEAD as fallback. */
async function readBundle(): Promise<{ bytes: Buffer; source: 'workspace' | 'git' } | null> {
  try {
    const st = await fs.stat(BUNDLE_PATH);
    if (st.isFile() && st.size > 0) return { bytes: await fs.readFile(BUNDLE_PATH), source: 'workspace' };
  } catch {
    /* not present — fall through to git */
  }
  try {
    const { stdout } = await execFileAsync('git', ['show', 'HEAD:secrets/emorai-secrets.tar.gz.enc'], { cwd: ROOT });
    if (stdout.length > 0) return { bytes: stdout, source: 'git' };
  } catch {
    /* no git history either */
  }
  return null;
}

/** Passphrase resolution is shared with the snapshot job (secrets-bundle). */

// ─── Restore mechanics ───────────────────────────────────────────────────────

/** Parses a .env into KEY=VALUE pairs (no interpolation — flat file). */
function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/**
 * Decrypts the bundle and extracts it into a temp dir.
 * The passphrase travels via child env, never argv.
 */
async function decryptBundle(bytes: Buffer, passphrase: string): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(ROOT, '.self-heal-'));
  try {
    const bundlePath = path.join(tmp, 'bundle.enc');
    const tarPath = path.join(tmp, 'bundle.tar.gz');
    await fs.writeFile(bundlePath, bytes, { mode: 0o600 });
    await execFileAsync('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', String(BUNDLE_ITER), '-in', bundlePath, '-out', tarPath, '-pass', 'env:EMORAI_SECRET_PASSPHRASE'], {
      env: { ...process.env, EMORAI_SECRET_PASSPHRASE: passphrase },
    });
    await fs.rm(bundlePath, { force: true });
    const extractDir = path.join(tmp, 'x');
    await fs.mkdir(extractDir, { recursive: true });
    await execFileAsync('tar', ['-C', extractDir, '-xzf', tarPath]);
    await fs.rm(tarPath, { force: true });
    return extractDir;
  } catch (e) {
    // never leak the temp staging dir on a failed decrypt/extract
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
}

/**
 * Copies the restored env file into place and injects its values into
 * process.env (only keys that are missing in the live environment — the
 * platform scaffold leaves everything but DATABASE_URL absent).
 */
async function restoreEnv(extractDir: string): Promise<boolean> {
  const envPath = path.join(extractDir, '.env');
  let content: string;
  try {
    content = await fs.readFile(envPath, 'utf8');
  } catch {
    return false;
  }
  await fs.writeFile(ENV_FILE, content, { mode: 0o600 });
  for (const [k, v] of Object.entries(parseEnv(content))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return true;
}

/**
 * Where the live database file lives — resolved from DATABASE_URL so the
 * heal works in BOTH environments:
 *   • dev sandbox:   file:/home/z/my-project/db/custom.db
 *   • published/standalone deploys: whatever file: path the platform mounts
 * Relative file: paths resolve against the project root (Prisma semantics:
 * relative to prisma/schema.prisma). Non-file URLs fall back to ROOT/db.
 */
function resolveDbFile(): string {
  const url = process.env.DATABASE_URL;
  if (typeof url === 'string' && url.startsWith('file:')) {
    const p = url.slice('file:'.length).split('?')[0];
    if (path.isAbsolute(p)) return p;
    return path.join(ROOT, p);
  }
  return path.join(ROOT, 'db', 'custom.db');
}

/** Restores the database file (WAL siblings removed) and uploads dir. */
async function restoreDb(extractDir: string): Promise<boolean> {
  const dbPath = path.join(extractDir, 'db', 'custom.db');
  try {
    await fs.access(dbPath);
  } catch {
    return false;
  }
  const target = resolveDbFile();
  await fs.rm(`${target}-wal`, { force: true });
  await fs.rm(`${target}-shm`, { force: true });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(dbPath, target);
  await fs.chmod(target, 0o644).catch(() => undefined);
  // uploads is content-merged (a wiped dir gets repopulated; existing files win)
  const uploadsSrc = path.join(extractDir, 'db', 'uploads');
  const uploadsDst = path.join(ROOT, 'db', 'uploads');
  try {
    await fs.access(uploadsSrc);
    await fs.mkdir(uploadsDst, { recursive: true });
    await fs.cp(uploadsSrc, uploadsDst, { recursive: true, force: false, errorOnExist: false });
  } catch {
    /* bundle without uploads — fine */
  }
  return true;
}

/**
 * The one-shot boot heal. NEVER THROWS: a failed heal logs guidance and the
 * server still serves (same posture as the job scheduler).
 */
export async function selfHealIfNeeded(): Promise<SelfHealResult> {
  try {
    const { envBroken, dbWiped, dbQueryOk } = await detectState();
    if (!envBroken && !dbWiped) return { status: 'healthy', envOk: true, dbOk: dbQueryOk };

    console.log(
      `[self-heal] workspace wipe detected (env:${envBroken ? 'broken' : 'ok'} db:${dbWiped ? 'wiped' : 'ok'}) — attempting bundle restore`
    );

    const passphrase = await readRecoveryPassphrase();
    if (!passphrase) {
      console.error(
        '[self-heal] no passphrase available (EMORAI_SECRET_PASSPHRASE env or secrets/recovery.passphrase). ' +
          'Run scripts/secrets.sh decrypt manually, then restart the server.'
      );
      return { status: 'skipped', reason: 'no-passphrase' };
    }

    const bundle = await readBundle();
    if (!bundle) {
      console.error('[self-heal] encrypted bundle not found in workspace or git — cannot restore.');
      return { status: 'failed', reason: 'no-bundle' };
    }

    let extractDir: string | null = null;
    try {
      extractDir = await decryptBundle(bundle.bytes, passphrase);
      const envRestored = envBroken ? await restoreEnv(extractDir) : false;
      const dbRestored = dbWiped ? await restoreDb(extractDir) : false;
      // Guard against a BAD bundle (e.g. one snapshotted from a wiped
      // workspace): if the database is still empty after "restoring", the
      // bundle itself is garbage — say so loudly instead of pretending.
      if (dbRestored) {
        const post = await detectState();
        if (post.dbWiped) {
          console.error(
            '[self-heal] bundle restored but the database is STILL empty — the encrypted bundle itself appears to contain a wiped snapshot. ' +
              'Rebuild it from a healthy state (EMORAI_SECRET_PASSPHRASE=… ./scripts/secrets.sh encrypt) and commit.'
          );
        }
      }
      const bundleAgeMin = await bundleAgeMinutes();
      const alertWritten = await writeRecoveryAlert({ envRestored, dbRestored, source: bundle.source, dbQueryOk });
      console.log(
        `[self-heal] restored (env:${envRestored ? 'yes' : 'n/a'} db:${dbRestored ? 'yes' : 'n/a'} ` +
          `bundle:${bundle.source}${bundleAgeMin != null ? ` age ${bundleAgeMin}m` : ''})`
      );
      return { status: 'restored', envRestored, dbRestored, bundleAgeMin, alertWritten };
    } finally {
      if (extractDir) await fs.rm(path.dirname(extractDir), { recursive: true, force: true }).catch(() => undefined);
    }
  } catch (e) {
    console.error('[self-heal] restore failed:', String((e as { message?: unknown })?.message ?? e));
    console.error('[self-heal] manual recovery: scripts/secrets.sh decrypt && restart server');
    return { status: 'failed', reason: 'restore-error' };
  }
}

/**
 * Writes the ops-tab alert AFTER the database file is back in place, through
 * a fresh client — the pre-restore probe connection points at the replaced
 * inode and must not be reused.
 */
async function writeRecoveryAlert(meta: {
  envRestored: boolean;
  dbRestored: boolean;
  source: 'workspace' | 'git';
  dbQueryOk: boolean;
}): Promise<boolean> {
  if (!meta.dbRestored) return false;
  try {
    const client = new PrismaClient();
    try {
      await client.alertEvent.create({
        data: {
          level: 'warning',
          category: 'self-heal',
          message: `Platform workspace wipe auto-recovered from encrypted bundle (env:${meta.envRestored ? 'restored' : 'intact'}; source:${meta.source}). Keys, providers and conversations are back. Keys created AFTER the last secrets-snapshot may need reissuing.`,
          meta: { ...meta, recoveredAt: new Date().toISOString() },
        },
      });
      return true;
    } finally {
      await client.$disconnect().catch(() => undefined);
    }
  } catch {
    return false; // alerting is record-only; the heal itself already succeeded
  }
}
