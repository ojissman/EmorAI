// ─── Ops budgets (admin) ─────────────────────────────────────────────────────
// Monthly budget enforcement snapshot for every budgeted provider account:
// exact micro-unit spend (BigInt decimal math — never floats), priced vs
// unpriced ledger rows, and over-budget flags. ONE ledger query for all
// accounts (budgetStatusMapFor). Admin session + CSRF guarded via requireAdmin.

import { db } from '@/lib/db';
import { ok } from '@/lib/api/response';
import { requireAdmin } from '@/lib/api/admin-auth';
import { budgetStatusMapFor } from '@/lib/billing';
import { microToDecimalString } from '@/lib/money';
import { getSettings } from '@/lib/settings';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  let enforce = true;
  try {
    enforce = (await getSettings()).budget.enforce;
  } catch {
    // settings unreadable → documented default (enforce = true)
  }

  const accounts = await db.providerAccount.findMany({
    where: { monthlyBudget: { gt: 0 } },
    select: { id: true, name: true, monthlyBudget: true },
    orderBy: { name: 'asc' },
  });
  const statuses = await budgetStatusMapFor(accounts, enforce);

  const rows = accounts.map((a) => {
    const status = statuses.get(a.id);
    return {
      accountId: a.id,
      name: a.name,
      // budget as decimal string (micro units → "10.500000" style)
      budget: status?.budgetMicro != null ? microToDecimalString(status.budgetMicro) : null,
      // spend in micro units, as string (JSON cannot carry BigInt)
      spentMicro: status ? status.spentMicro.toString() : '0',
      spent: status ? microToDecimalString(status.spentMicro) : '0.000000',
      overBudget: status?.overBudget ?? false,
      enforced: status?.enforced ?? false,
      pricedCount: status?.pricedCount ?? 0,
      unpricedCount: status?.unpricedCount ?? 0,
      currency: status?.currency ?? null,
    };
  });

  return ok({
    enforce,
    accounts: rows,
    totals: {
      accounts: rows.length,
      overBudget: rows.filter((r) => r.overBudget).length,
      pricedCount: rows.reduce((sum, r) => sum + r.pricedCount, 0),
      unpricedCount: rows.reduce((sum, r) => sum + r.unpricedCount, 0),
    },
    note:
      'Spend sums priced CostLedger rows for the current calendar month. Unpriced rows (no rate configured) are counted but excluded from the sum — budget enforcement is therefore a floor. Mixed-currency accounts are documented as out of scope.',
  });
}
