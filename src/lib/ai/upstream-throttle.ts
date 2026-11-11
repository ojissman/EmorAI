// ─── Process-wide upstream start gate ────────────────────────────────────────
// The upstream Z.ai chat-completions gateway enforces a strict request-rate
// limit (observed ≈ 2 requests / 10 s). EmorAI fires completions from many
// independent code paths — dashboard chat, auto title generation, agent runs,
// conversation summaries, studio documents, admin health validation, registry
// availability probes, and the public /api/v1 + /api gateways. Without
// coordination these bursts collide with each other and the upstream answers
// 429. This module is the single process-wide coordinator: every outbound
// chat completion acquires a start slot here first.
//
// Semantics:
//   • The gate spaces REQUEST STARTS by MIN_GAP_MS (it never holds a slot for
//     the duration of a response — streams run concurrently after they start).
//   • Two priorities. 'interactive' (default) always queues and waits — user
//     traffic must eventually run. 'background' (auto title generation, which
//     has a cheap local fallback) balks instead of queueing behind traffic:
//     its caller degrades gracefully instead of stacking hidden latency.
//   • Within a grant cycle, interactive waiters are dequeued ahead of
//     background ones, but background waiters are never starved: every timer
//     tick grants exactly one waiter, and an empty queue grants whoever is
//     left waiting.
//   • Backoff retries inside the adapter re-acquire the slot per attempt, so
//     retries also respect the global spacing — the platform never hammers
//     the upstream out of self-inflicted contention.

export type UpstreamPriority = 'interactive' | 'background';

// ≤ 10 starts / minute against an observed ~12 / minute limit — a safety
// margin that keeps interactive latency snappy.
const MIN_GAP_MS = 6_000;
// Background callers would rather fall back than wait longer than this.
const BACKGROUND_MAX_WAIT_MS = 8_000;

type Waiter = { priority: UpstreamPriority; resolve: () => void };

class UpstreamGate {
  private lastStartAt = 0;
  private waiters: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  async acquire(priority: UpstreamPriority = 'interactive'): Promise<void> {
    // Balk check for background callers happens at enqueue time: if this
    // request could not start within BACKGROUND_MAX_WAIT_MS even in the best
    // case, refuse immediately so the caller uses its fallback now.
    const now = Date.now();
    const projectedStart = Math.max(now, this.lastStartAt + MIN_GAP_MS) + this.waiters.length * MIN_GAP_MS;
    if (priority === 'background' && projectedStart - now > BACKGROUND_MAX_WAIT_MS) {
      throw new Error('Upstream is busy — skipping this low-priority request.');
    }
    return await new Promise<void>((resolve) => {
      this.waiters.push({ priority, resolve });
      this.schedule();
    });
  }

  /** Grants the next waiter its start slot (one per timer tick). */
  private grantNext(): void {
    // interactive traffic jumps the queue; background fills the gaps
    const idx = this.waiters.findIndex((w) => w.priority === 'interactive');
    const pick = this.waiters.splice(idx === -1 ? 0 : idx, 1)[0];
    if (!pick) return;
    this.lastStartAt = Math.max(Date.now(), this.lastStartAt + MIN_GAP_MS);
    pick.resolve();
    this.schedule();
  }

  /** Chains a single timer that fires when the next start is allowed. */
  private schedule(): void {
    if (this.timer !== null || this.waiters.length === 0) return;
    const waitMs = Math.max(0, this.lastStartAt + MIN_GAP_MS - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.grantNext();
    }, waitMs);
  }
}

const gate = new UpstreamGate();

/**
 * Acquires permission to START one upstream chat completion. Await this
 * immediately before the outbound call, once per (re)attempt.
 * Throws synchronously (rejected promise) only for background callers that
 * would wait too long — interactive callers always eventually get a slot.
 */
export function acquireUpstreamSlot(priority?: UpstreamPriority): Promise<void> {
  return gate.acquire(priority ?? 'interactive');
}
