// ─── In-process concurrency enforcement (Phase 10, Priority 3) ────────────────
// Real bounded-concurrency slots per provider account and per model route.
//
// Deployment note: this is IN-PROCESS enforcement — the documented deployment
// model for EmorAI is a single server process (Next.js node runtime, one
// instance). A multi-process/multi-node deployment would need a shared
// semaphore (e.g. Redis); that is deliberately out of scope here.
//
// Semantics:
//   • Keys: `account:<id>` (account.maxConcurrency) and `route:<id>`
//     (route.maxConcurrency). A limit of 0 means UNLIMITED — that slot is not
//     tracked at all. (DB convention: route.maxConcurrency 0 = "account
//     default", which resolves to no route-specific bound.)
//   • acquireSlots() acquires ALL required slots atomically (both or neither)
//     so account/route pairs can never deadlock against each other.
//   • Waiting queue is FIFO: waiters are granted in enqueue order among those
//     whose full key set has capacity (the queue head never stalls unrelated
//     accounts). Worst-case wait is bounded by `concurrency.queueWaitMs`.
//   • `concurrency.mode === 'reject'`: when any slot is full, acquisition
//     throws ConcurrencyExhaustedError IMMEDIATELY (no queueing) carrying the
//     queue-depth info.
//   • GUARANTEED RELEASE: every lease must be released exactly once by the
//     caller (the router wraps every adapter attempt in try/finally — which
//     also runs on consumer abort, because the for-await throw/return
//     propagates into the finally). release() itself is idempotent.
//   • Settings are read via getSettings() with a short cache (≤5s) and must
//     never throw — on any failure the documented defaults apply
//     (queue / 30s wait).
//
// Pure semaphore logic — no DB import at module scope; the settings source is
// injected lazily so unit tests stay server-free.

export type SlotLease = {
  /** Releases every acquired slot. Idempotent — extra calls are no-ops. */
  release(): void;
  /** Epoch ms when the slots were granted. */
  acquiredAt: number;
};

export type SlotSpec = {
  accountId: string;
  /** 0 = unlimited (account slot skipped entirely) */
  accountMax: number;
  routeId?: string;
  /** 0/undefined = no route-specific bound */
  routeMax?: number;
};

export type ConcurrencyConfig = {
  mode: 'queue' | 'reject';
  queueWaitMs: number;
};

/** Default policy documented in AppSettings: queue, wait at most 30 s. */
export const DEFAULT_CONCURRENCY_CONFIG: ConcurrencyConfig = { mode: 'queue', queueWaitMs: 30_000 };

/**
 * Thrown when slots could not be acquired: queue-mode wait expiry, or any
 * full slot in reject mode. The router maps this to a retryable
 * `rate_limited` ProviderError (status 503).
 */
export class ConcurrencyExhaustedError extends Error {
  name = 'ConcurrencyExhaustedError';
  /** Slot keys that could not be acquired (`account:<id>` / `route:<id>`). */
  keys: string[];
  /** How long this acquisition waited in the queue (0 in reject mode). */
  waitedMs: number;
  /** Best-effort queue depth for the same keys at throw time. */
  queueDepth: number;
  mode: 'queue' | 'reject';

  constructor(keys: string[], waitedMs: number, queueDepth: number, mode: 'queue' | 'reject', message: string) {
    super(message);
    this.keys = keys;
    this.waitedMs = waitedMs;
    this.queueDepth = queueDepth;
    this.mode = mode;
  }
}

// ─── Registry state (module-scoped, single process) ──────────────────────────

type SlotState = { limit: number; inFlight: number };

const slots = new Map<string, SlotState>();

type Waiter = {
  keys: Array<{ key: string; limit: number }>;
  resolve: (lease: SlotLease) => void;
  reject: (err: ConcurrencyExhaustedError) => void;
  enqueuedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
};

/** FIFO waiting queue (strict insertion order). */
const waiters: Waiter[] = [];

// ─── Settings source ─────────────────────────────────────────────────────────

let testConfigResolver: (() => ConcurrencyConfig | Promise<ConcurrencyConfig>) | null = null;
let configCache: { at: number; cfg: ConcurrencyConfig } | null = null;
const CONFIG_CACHE_MS = 5_000; // settings changes apply within ≤5 s

/** Test-only: replaces the settings source so unit tests touch no DB. */
export function __setConcurrencyConfigResolverForTests(
  fn: (() => ConcurrencyConfig | Promise<ConcurrencyConfig>) | null
): void {
  testConfigResolver = fn;
  configCache = null;
}

/** Test-only: clears all slots/waiters between test cases. */
export function __resetConcurrencyStateForTests(): void {
  for (const w of waiters) if (w.timer) clearTimeout(w.timer);
  waiters.length = 0;
  slots.clear();
  configCache = null;
}

function sanitizeConfig(raw: unknown): ConcurrencyConfig {
  const c = raw as Partial<ConcurrencyConfig> | null;
  const mode = c?.mode === 'reject' ? 'reject' : 'queue';
  const wait = Number.isInteger(c?.queueWaitMs) && (c?.queueWaitMs as number) > 0 ? (c!.queueWaitMs as number) : 30_000;
  return { mode, queueWaitMs: wait };
}

async function loadConfig(): Promise<ConcurrencyConfig> {
  if (testConfigResolver) {
    try {
      return sanitizeConfig(await testConfigResolver());
    } catch {
      return DEFAULT_CONCURRENCY_CONFIG;
    }
  }
  if (configCache && Date.now() - configCache.at < CONFIG_CACHE_MS) return configCache.cfg;
  try {
    // Dynamic import keeps this module importable in DB-free unit tests.
    const { getSettings } = await import('@/lib/settings');
    const settings = await getSettings();
    const cfg = sanitizeConfig(settings.concurrency);
    configCache = { at: Date.now(), cfg };
    return cfg;
  } catch {
    // Settings must never break enforcement: documented defaults apply.
    return DEFAULT_CONCURRENCY_CONFIG;
  }
}

// ─── Core semaphore logic (synchronous ⇒ atomic per call) ───────────────────

function ensureSlot(key: string, limit: number): SlotState {
  let st = slots.get(key);
  if (!st) {
    st = { limit, inFlight: 0 };
    slots.set(key, st);
  } else {
    st.limit = limit; // latest admin-configured limit wins (no preemption)
  }
  return st;
}

/** Grants ALL keys or NONE (atomic — JS is single-threaded within a task). */
function tryGrant(keys: Array<{ key: string; limit: number }>): boolean {
  for (const k of keys) {
    const st = slots.get(k.key);
    if (!st || st.inFlight >= st.limit) return false;
  }
  for (const k of keys) ensureSlot(k.key, k.limit).inFlight++;
  return true;
}

function makeLease(keys: Array<{ key: string; limit: number }>): SlotLease {
  let released = false;
  const acquiredAt = Date.now();
  return {
    acquiredAt,
    release() {
      if (released) return; // idempotent — double release never over-frees
      released = true;
      for (const k of keys) {
        const st = slots.get(k.key);
        if (st) st.inFlight = Math.max(0, st.inFlight - 1);
      }
      pump();
    },
  };
}

/**
 * Wakes the queue after a release: grants waiters in FIFO order among those
 * whose full key set currently fits. The queue head does NOT block unrelated
 * waiters (head-of-line stalls would couple accounts that share nothing).
 */
function pump(): void {
  for (let i = 0; i < waiters.length; ) {
    const w = waiters[i];
    if (tryGrant(w.keys)) {
      waiters.splice(i, 1);
      if (w.timer) clearTimeout(w.timer);
      w.resolve(makeLease(w.keys));
    } else {
      i++;
    }
  }
}

function queueDepthFor(keys: Array<{ key: string }>): number {
  const wanted = new Set(keys.map((k) => k.key));
  let depth = 0;
  for (const w of waiters) if (w.keys.some((k) => wanted.has(k.key))) depth++;
  return depth;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Acquires the account slot (and route slot when bounded). Returns the lease,
 * or null when nothing needs enforcing (all limits 0 = unlimited).
 *
 * Throws ConcurrencyExhaustedError:
 *   • reject mode — any slot full at call time (immediately)
 *   • queue mode — still no capacity after queueWaitMs
 */
export async function acquireSlots(spec: SlotSpec): Promise<SlotLease | null> {
  const keys: Array<{ key: string; limit: number }> = [];
  if (Number.isInteger(spec.accountMax) && spec.accountMax > 0) {
    keys.push({ key: `account:${spec.accountId}`, limit: spec.accountMax });
  }
  if (spec.routeId && Number.isInteger(spec.routeMax) && (spec.routeMax ?? 0) > 0) {
    keys.push({ key: `route:${spec.routeId}`, limit: spec.routeMax as number });
  }
  if (keys.length === 0) return null; // unlimited — nothing to enforce

  // register/sync slot limits so the snapshot reflects current config even
  // before the first grant
  for (const k of keys) ensureSlot(k.key, k.limit);

  const cfg = await loadConfig();
  if (tryGrant(keys)) return makeLease(keys);

  if (cfg.mode === 'reject') {
    const depth = queueDepthFor(keys);
    throw new ConcurrencyExhaustedError(
      keys.map((k) => k.key),
      0,
      depth,
      'reject',
      `concurrency limit reached for ${keys.map((k) => k.key).join(' + ')} (mode: reject, queue depth ${depth})`
    );
  }

  // queue mode: FIFO wait, bounded by queueWaitMs
  return await new Promise<SlotLease>((resolve, reject) => {
    const waiter: Waiter = {
      keys,
      resolve,
      reject,
      enqueuedAt: Date.now(),
      timer: null,
    };
    waiter.timer = setTimeout(() => {
      const idx = waiters.indexOf(waiter);
      if (idx >= 0) waiters.splice(idx, 1);
      reject(
        new ConcurrencyExhaustedError(
          keys.map((k) => k.key),
          Date.now() - waiter.enqueuedAt,
          queueDepthFor(keys),
          'queue',
          `queue wait expired after ${Date.now() - waiter.enqueuedAt}ms waiting for ${keys.map((k) => k.key).join(' + ')}`
        )
      );
    }, cfg.queueWaitMs);
    waiters.push(waiter);
    // capacity may have freed between tryGrant and enqueue — pump immediately
    pump();
  });
}

// ─── Ops snapshot ────────────────────────────────────────────────────────────

export type KeySnapshot = {
  inFlight: number;
  /** waiters currently queued that need this key */
  queued: number;
  limit: number;
  exhausted: boolean;
};

export type ConcurrencySnapshot = {
  keys: Record<string, KeySnapshot>;
  totals: {
    keys: number;
    inFlight: number;
    /** unique waiting acquisitions (NOT the per-key sum — one waiter may need 2 keys) */
    queued: number;
    exhausted: number;
  };
};

/**
 * Live enforcement state for the ops metrics endpoint. Zero-cost: pure reads
 * of the in-process registry.
 */
export function concurrencySnapshot(): ConcurrencySnapshot {
  const keys: Record<string, KeySnapshot> = {};
  let inFlightTotal = 0;
  let exhaustedTotal = 0;
  for (const [key, st] of slots) {
    let queuedForKey = 0;
    for (const w of waiters) if (w.keys.some((k) => k.key === key)) queuedForKey++;
    const exhausted = st.limit > 0 && st.inFlight >= st.limit;
    keys[key] = { inFlight: st.inFlight, queued: queuedForKey, limit: st.limit, exhausted };
    inFlightTotal += st.inFlight;
    if (exhausted) exhaustedTotal++;
  }
  return {
    keys,
    totals: { keys: slots.size, inFlight: inFlightTotal, queued: waiters.length, exhausted: exhaustedTotal },
  };
}
