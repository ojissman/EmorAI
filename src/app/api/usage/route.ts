import { db } from '@/lib/db';
import { ok } from '@/lib/api/response';
import { serializeUsageRecord } from '@/lib/serialize';

export const runtime = 'nodejs';

/** Aggregated usage analytics for the dashboard + recent records. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const days = Math.min(Math.max(Number(url.searchParams.get('days') ?? '30'), 1), 365);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const records = await db.usageRecord.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 500,
    include: { apiKey: { select: { name: true } } },
  });

  // Aggregate in memory (single-owner install; datasets are small).
  let promptTokens = 0;
  let completionTokens = 0;
  let requests = 0;
  let failed = 0;
  const byModel = new Map<string, { modelId: string; requests: number; totalTokens: number }>();
  const byDay = new Map<string, { date: string; requests: number; totalTokens: number }>();

  for (const r of records) {
    requests += 1;
    promptTokens += r.promptTokens;
    completionTokens += r.completionTokens;
    if (!r.success) failed += 1;
    const bm = byModel.get(r.modelId) ?? { modelId: r.modelId, requests: 0, totalTokens: 0 };
    bm.requests += 1;
    bm.totalTokens += r.totalTokens;
    byModel.set(r.modelId, bm);
    const day = r.createdAt.toISOString().slice(0, 10);
    const bd = byDay.get(day) ?? { date: day, requests: 0, totalTokens: 0 };
    bd.requests += 1;
    bd.totalTokens += r.totalTokens;
    byDay.set(day, bd);
  }

  return ok({
    windowDays: days,
    totals: {
      requests,
      failed,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
    byModel: [...byModel.values()].sort((a, b) => b.requests - a.requests),
    byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    records: records.slice(0, 120).map(serializeUsageRecord),
  });
}
