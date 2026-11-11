// ─── Ops metrics (admin) ─────────────────────────────────────────────────────
// Live operational snapshot: in-process concurrency enforcement state,
// routing decisions over the last 24 hours, and per-account health. Cheap DB
// aggregates only (groupBy + one providerAccount scan). Admin session + CSRF
// guarded via requireAdmin.

import { db } from '@/lib/db';
import { ok } from '@/lib/api/response';
import { requireAdmin } from '@/lib/api/admin-auth';
import { concurrencySnapshot } from '@/lib/ai/concurrency';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [byStatus, accounts] = await Promise.all([
    db.routingDecision.groupBy({
      by: ['finalStatus'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    db.providerAccount.findMany({
      select: { id: true, name: true, lastStatus: true, requestCount: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  const counts: Record<string, number> = {};
  let total = 0;
  for (const group of byStatus) {
    counts[group.finalStatus] = group._count._all;
    total += group._count._all;
  }

  return ok({
    concurrency: concurrencySnapshot(),
    routing: {
      // decisions in the last 24 hours, by final status
      last24h: {
        total,
        routed: counts.routed ?? 0,
        failed: counts.failed ?? 0,
        direct: counts.direct ?? 0,
      },
    },
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      lastStatus: a.lastStatus,
      requestCount: a.requestCount,
    })),
  });
}
