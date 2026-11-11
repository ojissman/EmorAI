// ─── Cost accounting + budget enforcement (Phase 10, Priority 4) ──────────────
// Every monetary value is a decimal STRING or a BigInt-scaled integer —
// never a float (see src/lib/money.ts). Honesty rules:
//
//   • Rate resolution order (per usage record):
//       1. latest CostRate with effectiveFrom ≤ now for [modelId + account]
//       2. latest model-wide CostRate for [modelId]
//       3. ModelConfig.pricing JSON fallback
//       4. nothing known → CostLedger row with priced=false and NULL costs
//         (unknown stays unknown — NEVER zero)
//   • CostLedger writes are idempotent on the unique usageRecordId: the
//     first write wins; duplicate-retry accounting cannot double-count.
//   • Monthly spend sums the CURRENT calendar month (UTC) from the ledger;
//     unpriced rows are counted separately and excluded from the sum (their
//     cost is unknown — inventing it would be worse than undercounting), so
//     budget enforcement is a floor, not an exact ceiling.
//   • Currency comes from the rate. Aggregating accounts whose rows carry
//     MIXED currencies is out of scope here: the sum is reported with the
//     first-seen currency and is only meaningful when one currency is in
//     play (single-currency installs — the default).
//   • Alerts: when an enforced budget flips over, a critical AlertEvent is
//     recorded at most once per hour per account (spam guard).

import { db } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import type { ModelPricing } from '@/lib/types';
import { computeCostMicro, microToDecimalString, toScaled, MICRO_SCALE } from '@/lib/money';

// ─── Shared types ────────────────────────────────────────────────────────────

export type EffectiveRate = {
  /** decimal string, currency per 1M input tokens */
  inputPerMTok: string;
  /** decimal string, currency per 1M output tokens */
  outputPerMTok: string;
  currency: string;
  source: 'cost_rate' | 'model_pricing';
};

export type RecordCostInput = {
  /** UsageRecord id — the idempotency key for the CostLedger row */
  id: string;
  apiKeyId?: string | null;
  providerAccountId?: string | null;
  modelId: string;
  servedModel?: string | null;
  promptTokens: number;
  completionTokens: number;
  /** kept for attribution symmetry; CostLedger links via usageRecordId */
  routeId?: string | null;
};

export type RecordCostResult = {
  priced: boolean;
  totalCost?: string;
  currency?: string;
};

export type SpendSummary = {
  /** micro currency units summed from priced rows this month (exact BigInt) */
  totalMicro: bigint;
  pricedCount: number;
  unpricedCount: number;
  currency: string | null;
};

export type AccountBudgetStatus = {
  accountId: string;
  /** settings.budget.enforce && monthlyBudget > 0 */
  enforced: boolean;
  budgetMicro: bigint | null;
  spentMicro: bigint;
  overBudget: boolean;
  pricedCount: number;
  unpricedCount: number;
  currency: string | null;
};

const EMPTY_SUMMARY: SpendSummary = { totalMicro: BigInt(0), pricedCount: 0, unpricedCount: 0, currency: null };

/** First moment of the current calendar month (UTC) — matches usage.ts semantics. */
function monthStartUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Budget-alert spam guard: at most one alert per account per hour. */
const BUDGET_ALERT_DEDUPE_MS = 60 * 60 * 1000;

// ─── Rate resolution ─────────────────────────────────────────────────────────

/** Defensive parse of the ModelConfig.pricing JSON column. */
export function parseModelPricing(raw: unknown): ModelPricing | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as { inputPerMTok?: unknown; outputPerMTok?: unknown; currency?: unknown };
  if (typeof p.inputPerMTok !== 'number' || typeof p.outputPerMTok !== 'number') return null;
  return {
    inputPerMTok: p.inputPerMTok,
    outputPerMTok: p.outputPerMTok,
    currency: typeof p.currency === 'string' && p.currency.length > 0 ? p.currency : 'USD',
  };
}

/**
 * All effective rates for a public model in ONE query: account-scoped rates
 * (latest effectiveFrom ≤ now per account) plus the model-wide rate, falling
 * back to the ModelConfig.pricing JSON. Router scoring and cost recording
 * share this precedence exactly.
 */
export async function effectiveRatesForModel(
  modelId: string,
  modelPricing: ModelPricing | null
): Promise<{ accountRates: Map<string, EffectiveRate>; modelWide: EffectiveRate | null }> {
  const accountRates = new Map<string, EffectiveRate>();
  let modelWide: EffectiveRate | null = null;
  try {
    const rows = await db.costRate.findMany({
      where: { modelId, effectiveFrom: { lte: new Date() } },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    });
    for (const r of rows) {
      if (r.providerAccountId) {
        if (!accountRates.has(r.providerAccountId)) {
          accountRates.set(r.providerAccountId, {
            inputPerMTok: r.inputPerMTok,
            outputPerMTok: r.outputPerMTok,
            currency: r.currency,
            source: 'cost_rate',
          });
        }
      } else if (!modelWide) {
        modelWide = {
          inputPerMTok: r.inputPerMTok,
          outputPerMTok: r.outputPerMTok,
          currency: r.currency,
          source: 'cost_rate',
        };
      }
    }
  } catch {
    // rate lookup failure must never break the caller: pricing falls back to
    // model metadata / unknown
  }
  if (!modelWide && modelPricing) {
    modelWide = {
      inputPerMTok: String(modelPricing.inputPerMTok),
      outputPerMTok: String(modelPricing.outputPerMTok),
      currency: modelPricing.currency,
      source: 'model_pricing',
    };
  }
  return { accountRates, modelWide };
}

// ─── Spend aggregation (ONE query per call, grouped client-side) ─────────────

/**
 * Monthly ledger sums for a set of accounts — a single CostLedger query.
 * Strings from the ledger are re-parsed through money.ts (exact BigInt math).
 */
async function spendSummariesFor(accountIds: string[]): Promise<Map<string, SpendSummary>> {
  const out = new Map<string, SpendSummary>();
  if (accountIds.length === 0) return out;
  const rows = await db.costLedger.findMany({
    where: { providerAccountId: { in: accountIds }, createdAt: { gte: monthStartUtc() } },
    select: { providerAccountId: true, totalCost: true, priced: true, currency: true },
  });
  for (const r of rows) {
    const accId = r.providerAccountId ?? '';
    let s = out.get(accId);
    if (!s) {
      s = { totalMicro: BigInt(0), pricedCount: 0, unpricedCount: 0, currency: null };
      out.set(accId, s);
    }
    if (r.priced) s.pricedCount++;
    else s.unpricedCount++;
    if (!s.currency && r.currency) s.currency = r.currency;
    // unpriced rows contribute NOTHING to the sum (their cost is unknown);
    // mixing currencies makes the sum meaningless — documented, out of scope
    if (!r.priced || r.totalCost == null) continue;
    const micro = toScaled(r.totalCost, MICRO_SCALE);
    if (micro !== null) s.totalMicro += micro;
  }
  return out;
}

/** Current-month spend for one account (exact micro BigInt + counts). */
export async function monthlySpendMicroForAccount(accountId: string): Promise<SpendSummary> {
  try {
    return (await spendSummariesFor([accountId])).get(accountId) ?? EMPTY_SUMMARY;
  } catch {
    return EMPTY_SUMMARY; // spend reads must never break callers
  }
}

// ─── Budget status ────────────────────────────────────────────────────────────

/**
 * Budget status for one account. `enforced` requires BOTH the global
 * settings.budget.enforce flag AND account.monthlyBudget > 0. overBudget is
 * computed honestly even when not enforced (informational).
 */
export async function budgetStatusForAccount(account: {
  id: string;
  monthlyBudget: number | null;
}): Promise<AccountBudgetStatus> {
  let enforce = true;
  try {
    enforce = (await getSettings()).budget.enforce;
  } catch {
    // settings unreadable → documented default (budget.enforce = true)
  }
  return budgetStatusFor(account, enforce, await monthlySpendMicroForAccount(account.id));
}

function budgetStatusFor(
  account: { id: string; monthlyBudget: number | null },
  enforce: boolean,
  spend: SpendSummary
): AccountBudgetStatus {
  const hasBudget = account.monthlyBudget != null && account.monthlyBudget > 0;
  // float column → decimal string → exact BigInt micro (no float math)
  const budgetMicro = hasBudget ? toScaled(String(account.monthlyBudget), MICRO_SCALE) : null;
  return {
    accountId: account.id,
    enforced: enforce && hasBudget,
    budgetMicro,
    spentMicro: spend.totalMicro,
    overBudget: budgetMicro !== null && spend.totalMicro > budgetMicro,
    pricedCount: spend.pricedCount,
    unpricedCount: spend.unpricedCount,
    currency: spend.currency,
  };
}

/**
 * Budget statuses for MANY accounts with ONE ledger query (router planning
 * needs a per-request Map — never N queries per route).
 */
export async function budgetStatusMapFor(
  accounts: Array<{ id: string; monthlyBudget: number | null }>,
  enforce: boolean
): Promise<Map<string, AccountBudgetStatus>> {
  const map = new Map<string, AccountBudgetStatus>();
  const budgeted = accounts.filter((a) => a.monthlyBudget != null && a.monthlyBudget > 0);
  if (budgeted.length === 0) return map;
  let spends = new Map<string, SpendSummary>();
  try {
    spends = await spendSummariesFor(budgeted.map((a) => a.id));
  } catch {
    // spend lookup failure → empty summaries (statuses still returned; the
    // router treats a failed spend read as spend=0 rather than erroring)
  }
  for (const a of budgeted) {
    map.set(a.id, budgetStatusFor(a, enforce, spends.get(a.id) ?? EMPTY_SUMMARY));
  }
  return map;
}

// ─── Budget alerting (critical AlertEvent, once per hour per account) ────────

export type BudgetAlertEntry = {
  accountId: string;
  accountName: string;
  spentMicro: bigint;
  budgetMicro: bigint;
  currency: string | null;
};

/**
 * Records a critical budget AlertEvent for each entry, SKIPPING accounts that
 * already have a budget alert within the last hour (spam guard — Prisma/SQLite
 * cannot filter on JSON columns, so the guard is one findMany + client-side
 * filter). Never throws.
 */
export async function alertBudgetExceededBatch(entries: BudgetAlertEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const alerted = new Set<string>();
  try {
    const recent = await db.alertEvent.findMany({
      where: { category: 'budget', createdAt: { gte: new Date(Date.now() - BUDGET_ALERT_DEDUPE_MS) } },
      select: { meta: true },
    });
    for (const r of recent) {
      const meta = (r.meta ?? {}) as { accountId?: unknown };
      if (typeof meta.accountId === 'string') alerted.add(meta.accountId);
    }
  } catch {
    // guard query failed → still alert (better one extra alert than silence)
  }
  for (const e of entries) {
    if (alerted.has(e.accountId)) continue;
    const spent = microToDecimalString(e.spentMicro);
    const budget = microToDecimalString(e.budgetMicro);
    const currency = e.currency ? ` ${e.currency}` : '';
    try {
      await db.alertEvent.create({
        data: {
          level: 'critical',
          category: 'budget',
          message: `Provider account "${e.accountName}" is over its monthly budget: spent ${spent} of ${budget}${currency} this month — its routes are ineligible until the budget resets or is raised.`,
          meta: {
            accountId: e.accountId,
            accountName: e.accountName,
            spent,
            budget,
            currency: e.currency,
          },
        },
      });
    } catch {
      // alerting must never break the request path
    }
  }
}

// ─── Cost recording (post-execution accounting) ───────────────────────────────

function isUniqueViolation(e: unknown): boolean {
  return typeof (e as { code?: unknown })?.code === 'string' && (e as { code: string }).code === 'P2002';
}

/**
 * Prices one usage record and writes its CostLedger row — idempotent on the
 * unique usageRecordId (duplicate retries return the FIRST write's result;
 * accounting is never double-counted or rewritten).
 *
 * After recording, when the account's enforced budget is (newly) over, a
 * budget AlertEvent is raised (once-per-hour guard).
 *
 * Errors from the ledger write propagate to the caller's catch — a failed
 * accounting row must NOT be reported as priced:false (that would claim
 * "unpriced" when nothing was recorded at all).
 */
export async function recordCostForUsage(usage: RecordCostInput): Promise<RecordCostResult> {
  // resolve pricing metadata for the model (rate precedence shared with the
  // router's cost scoring — one CostRate query + model fallback)
  let modelPricing: ModelPricing | null = null;
  try {
    const row = await db.modelConfig.findUnique({ where: { modelId: usage.modelId }, select: { pricing: true } });
    modelPricing = parseModelPricing(row?.pricing);
  } catch {
    modelPricing = null; // registry read failure → rate table only
  }
  const { accountRates, modelWide } = await effectiveRatesForModel(usage.modelId, modelPricing);
  const rate = usage.providerAccountId
    ? accountRates.get(usage.providerAccountId) ?? modelWide
    : modelWide;

  // exact BigInt pricing; unparseable rate → priced=false with NULL costs
  let inputMicro: bigint | null = null;
  let outputMicro: bigint | null = null;
  let currency: string | null = null;
  if (rate) {
    const inM = computeCostMicro(usage.promptTokens, rate.inputPerMTok);
    const outM = computeCostMicro(usage.completionTokens, rate.outputPerMTok);
    if (inM !== null && outM !== null) {
      inputMicro = inM;
      outputMicro = outM;
      currency = rate.currency;
    }
  }
  const priced = inputMicro !== null && outputMicro !== null;
  const totalMicro = priced ? (inputMicro as bigint) + (outputMicro as bigint) : null;

  const data = {
    usageRecordId: usage.id,
    providerAccountId: usage.providerAccountId ?? null,
    apiKeyId: usage.apiKeyId ?? null,
    modelId: usage.modelId,
    upstreamModelId: usage.servedModel ?? null,
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    inputCost: priced ? microToDecimalString(inputMicro as bigint) : null,
    outputCost: priced ? microToDecimalString(outputMicro as bigint) : null,
    totalCost: priced ? microToDecimalString(totalMicro as bigint) : null,
    currency: currency ?? 'USD',
    priced,
  };

  let row;
  try {
    row = await db.costLedger.create({ data });
  } catch (e) {
    if (isUniqueViolation(e)) {
      // duplicate-retry: the first accounting of this usage stands
      const existing = await db.costLedger.findUnique({ where: { usageRecordId: usage.id } });
      if (existing) {
        await postRecordBudgetAlert(usage);
        return {
          priced: existing.priced,
          totalCost: existing.totalCost ?? undefined,
          currency: existing.currency,
        };
      }
    }
    throw e;
  }

  await postRecordBudgetAlert(usage);
  return { priced, totalCost: row.totalCost ?? undefined, currency: row.currency };
}

/** Post-accounting budget check + alert (internal, never throws). */
async function postRecordBudgetAlert(usage: RecordCostInput): Promise<void> {
  if (!usage.providerAccountId) return;
  try {
    const account = await db.providerAccount.findUnique({
      where: { id: usage.providerAccountId },
      select: { id: true, name: true, monthlyBudget: true },
    });
    if (!account || account.monthlyBudget == null || account.monthlyBudget <= 0) return;
    const status = await budgetStatusForAccount(account);
    if (status.enforced && status.overBudget && status.budgetMicro !== null) {
      await alertBudgetExceededBatch([
        {
          accountId: account.id,
          accountName: account.name,
          spentMicro: status.spentMicro,
          budgetMicro: status.budgetMicro,
          currency: status.currency,
        },
      ]);
    }
  } catch {
    // post-accounting alerting must never break accounting
  }
}
