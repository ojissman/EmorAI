/// <reference types="bun-types" />
// Pure unit tests for the in-process concurrency semaphore — no server, no
// DB (the settings source is replaced via the test resolver).
// Bun test runner: `bun test tests/unit/concurrency.test.ts`
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  acquireSlots,
  concurrencySnapshot,
  ConcurrencyExhaustedError,
  __setConcurrencyConfigResolverForTests,
  __resetConcurrencyStateForTests,
} from '@/lib/ai/concurrency';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(() => {
  __resetConcurrencyStateForTests();
  // queue mode with a generous wait so FIFO behavior is observable
  __setConcurrencyConfigResolverForTests(() => ({ mode: 'queue', queueWaitMs: 5000 }));
});

afterEach(() => {
  __resetConcurrencyStateForTests();
  __setConcurrencyConfigResolverForTests(null);
});

describe('slot acquisition basics', () => {
  test('limit 0 = unlimited → null lease, nothing tracked', async () => {
    const lease = await acquireSlots({ accountId: 'free', accountMax: 0, routeId: 'r', routeMax: 0 });
    expect(lease).toBeNull();
    expect(concurrencySnapshot().totals.keys).toBe(0);
  });

  test('acquire and release update the snapshot', async () => {
    const lease = await acquireSlots({ accountId: 'a1', accountMax: 2 });
    expect(lease).not.toBeNull();
    let snap = concurrencySnapshot();
    expect(snap.keys['account:a1']).toMatchObject({ inFlight: 1, queued: 0, limit: 2, exhausted: false });

    lease!.release();
    snap = concurrencySnapshot();
    expect(snap.keys['account:a1'].inFlight).toBe(0);
    expect(snap.keys['account:a1'].exhausted).toBe(false);
  });

  test('release is idempotent — double release never over-frees', async () => {
    const lease = await acquireSlots({ accountId: 'a2', accountMax: 1 });
    lease!.release();
    lease!.release();
    lease!.release();
    expect(concurrencySnapshot().keys['account:a2'].inFlight).toBe(0);

    const again = await acquireSlots({ accountId: 'a2', accountMax: 1 });
    expect(again).not.toBeNull();
    again!.release();
  });

  test('parallel acquisitions respect the limit exactly (no over-grant)', async () => {
    const leases = await Promise.all([
      acquireSlots({ accountId: 'cap3', accountMax: 3 }),
      acquireSlots({ accountId: 'cap3', accountMax: 3 }),
      acquireSlots({ accountId: 'cap3', accountMax: 3 }),
    ]);
    expect(leases.filter((l) => l !== null)).toHaveLength(3);

    const queued = acquireSlots({ accountId: 'cap3', accountMax: 3 });
    await delay(20);
    expect(concurrencySnapshot().keys['account:cap3']).toMatchObject({ inFlight: 3, queued: 1, exhausted: true });

    for (const l of leases) l!.release();
    const fourth = await queued;
    expect(fourth).not.toBeNull();
    fourth!.release();
  });
});

describe('FIFO waiting queue (queue mode)', () => {
  test('waiters are granted in enqueue order — no leap-frogging', async () => {
    const first = await acquireSlots({ accountId: 'fifo', accountMax: 1 });
    const b = acquireSlots({ accountId: 'fifo', accountMax: 1 });
    const c = acquireSlots({ accountId: 'fifo', accountMax: 1 });
    await delay(20); // let both enqueue

    const snap = concurrencySnapshot();
    expect(snap.keys['account:fifo']).toMatchObject({ inFlight: 1, queued: 2, limit: 1, exhausted: true });

    first!.release();
    const bLease = await b;
    expect(bLease).not.toBeNull();
    // c must STILL be queued while b (enqueued before it) holds the slot
    const mid = concurrencySnapshot();
    expect(mid.keys['account:fifo']).toMatchObject({ inFlight: 1, queued: 1 });
    bLease!.release();

    const cLease = await c;
    expect(cLease).not.toBeNull();
    cLease!.release();
    expect(concurrencySnapshot().keys['account:fifo'].inFlight).toBe(0);
  });

  test('queue wait expiry throws ConcurrencyExhaustedError with slot + waited ms', async () => {
    __setConcurrencyConfigResolverForTests(() => ({ mode: 'queue', queueWaitMs: 60 }));
    const first = await acquireSlots({ accountId: 'slow', accountMax: 1 });

    let err: ConcurrencyExhaustedError | null = null;
    try {
      await acquireSlots({ accountId: 'slow', accountMax: 1 });
    } catch (e) {
      err = e as ConcurrencyExhaustedError;
    }
    expect(err).toBeInstanceOf(ConcurrencyExhaustedError);
    expect(err!.mode).toBe('queue');
    expect(err!.keys).toEqual(['account:slow']);
    expect(err!.waitedMs).toBeGreaterThanOrEqual(45);
    expect(typeof err!.queueDepth).toBe('number');
    // the timed-out waiter is gone from the queue
    expect(concurrencySnapshot().keys['account:slow']).toMatchObject({ inFlight: 1, queued: 0 });

    first!.release();
    const after = await acquireSlots({ accountId: 'slow', accountMax: 1 });
    expect(after).not.toBeNull();
    after!.release();
  });

  test('the queue head does not stall unrelated accounts', async () => {
    // waiter for a FULL account must not block a waiter for a FREE account
    const holdA = await acquireSlots({ accountId: 'accA', accountMax: 1 });
    const blocked = acquireSlots({ accountId: 'accA', accountMax: 1 }); // queues (head)
    await delay(10);
    const freeB = await acquireSlots({ accountId: 'accB', accountMax: 1 }); // must NOT wait behind the head
    expect(freeB).not.toBeNull();
    freeB!.release();

    holdA!.release();
    const unblocked = await blocked;
    expect(unblocked).not.toBeNull();
    unblocked!.release();
  });
});

describe('reject mode', () => {
  test('full slot throws immediately (no queueing) with queue-depth info', async () => {
    __setConcurrencyConfigResolverForTests(() => ({ mode: 'reject', queueWaitMs: 1000 }));
    const first = await acquireSlots({ accountId: 'rej', accountMax: 1 });

    let err: ConcurrencyExhaustedError | null = null;
    try {
      await acquireSlots({ accountId: 'rej', accountMax: 1 });
    } catch (e) {
      err = e as ConcurrencyExhaustedError;
    }
    expect(err).toBeInstanceOf(ConcurrencyExhaustedError);
    expect(err!.mode).toBe('reject');
    expect(err!.waitedMs).toBe(0);
    expect(err!.keys).toContain('account:rej');
    expect(typeof err!.queueDepth).toBe('number');
    // rejected request left no waiter behind
    expect(concurrencySnapshot().keys['account:rej'].queued).toBe(0);

    first!.release();
    const second = await acquireSlots({ accountId: 'rej', accountMax: 1 });
    expect(second).not.toBeNull();
    second!.release();
  });
});

describe('account + route slots together', () => {
  test('both enforced atomically; route slot full while account has capacity', async () => {
    const first = await acquireSlots({ accountId: 'rt', accountMax: 5, routeId: 'R', routeMax: 1 });
    const secondP = acquireSlots({ accountId: 'rt', accountMax: 5, routeId: 'R', routeMax: 1 });
    await delay(10);
    const snap = concurrencySnapshot();
    expect(snap.keys['account:rt']).toMatchObject({ inFlight: 1, limit: 5, exhausted: false });
    expect(snap.keys['route:R']).toMatchObject({ inFlight: 1, limit: 1, exhausted: true });

    first!.release();
    const second = await secondP;
    expect(second).not.toBeNull();
    second!.release();
  });

  test('account limit caps concurrent routes on that account', async () => {
    const r1 = await acquireSlots({ accountId: 'mix', accountMax: 2, routeId: 'routeA', routeMax: 1 });
    const r2 = await acquireSlots({ accountId: 'mix', accountMax: 2, routeId: 'routeB', routeMax: 1 });
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    const snap = concurrencySnapshot();
    expect(snap.keys['account:mix']).toMatchObject({ inFlight: 2, limit: 2, exhausted: true });
    expect(snap.keys['route:routeA']).toMatchObject({ inFlight: 1, limit: 1, exhausted: true });
    expect(snap.keys['route:routeB']).toMatchObject({ inFlight: 1, limit: 1, exhausted: true });

    const r3p = acquireSlots({ accountId: 'mix', accountMax: 2, routeId: 'routeC', routeMax: 1 });
    await delay(10);
    expect(concurrencySnapshot().keys['account:mix'].queued).toBe(1);

    r1!.release();
    const r3 = await r3p;
    expect(r3).not.toBeNull();
    expect(concurrencySnapshot().keys['route:routeC'].inFlight).toBe(1);
    r2!.release();
    r3!.release();
  });
});

describe('snapshot totals', () => {
  test('totals count unique waiting acquisitions, not per-key sums', async () => {
    const first = await acquireSlots({ accountId: 'tot', accountMax: 1, routeId: 'TR', routeMax: 1 });
    const w1 = acquireSlots({ accountId: 'tot', accountMax: 1, routeId: 'TR', routeMax: 1 });
    const w2 = acquireSlots({ accountId: 'tot', accountMax: 1, routeId: 'TR', routeMax: 1 });
    await delay(20);

    const snap = concurrencySnapshot();
    expect(snap.keys['account:tot'].queued).toBe(2);
    expect(snap.keys['route:TR'].queued).toBe(2);
    expect(snap.totals.queued).toBe(2); // one waiter needs BOTH keys — counted once
    expect(snap.totals.keys).toBe(2);
    expect(snap.totals.exhausted).toBe(2);

    first!.release();
    (await w1)!.release();
    (await w2)!.release();
    expect(concurrencySnapshot().totals.queued).toBe(0);
  });
});
