import { db } from '@/lib/db';
import { authenticateV1, scopeFailure } from '@/lib/api/auth';
import { openAiAuthFailure } from '@/lib/api/protocol/openai';

export const runtime = 'nodejs';

/** Usage report scoped to the presenting API key. */
export async function GET(req: Request) {
  const auth = await authenticateV1(req);
  if (!auth.ok) return openAiAuthFailure(auth.error);
  const usageScope = scopeFailure(auth.key, 'usage');
  if (usageScope) return openAiAuthFailure(usageScope);

  const url = new URL(req.url);
  const days = Math.min(Math.max(Number(url.searchParams.get('days') ?? '30'), 1), 365);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const records = await db.usageRecord.findMany({
    where: { apiKeyId: auth.key.apiKeyId, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 300,
  });

  let promptTokens = 0;
  let completionTokens = 0;
  let requests = 0;
  let failed = 0;
  const byModel = new Map<string, { modelId: string; requests: number; totalTokens: number }>();

  for (const r of records) {
    requests += 1;
    promptTokens += r.promptTokens;
    completionTokens += r.completionTokens;
    if (!r.success) failed += 1;
    const bm = byModel.get(r.modelId) ?? { modelId: r.modelId, requests: 0, totalTokens: 0 };
    bm.requests += 1;
    bm.totalTokens += r.totalTokens;
    byModel.set(r.modelId, bm);
  }

  return Response.json({
    object: 'usage_report',
    api_key: { name: auth.key.apiKeyName },
    window_days: days,
    totals: {
      requests,
      failed,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
    by_model: [...byModel.values()]
      .sort((a, b) => b.requests - a.requests)
      .map((bm) => ({ model_id: bm.modelId, requests: bm.requests, total_tokens: bm.totalTokens })),
    recent: records.slice(0, 50).map((r) => ({
      id: r.id,
      model_id: r.modelId,
      served_model: r.servedModel,
      prompt_tokens: r.promptTokens,
      completion_tokens: r.completionTokens,
      total_tokens: r.totalTokens,
      success: r.success,
      created: r.createdAt.toISOString(),
    })),
  });
}
