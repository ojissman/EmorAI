import { db } from '@/lib/db';
import type { TokenUsage } from '@/lib/types';

export type RecordUsageInput = {
  source: 'dashboard' | 'api';
  // wire protocol served to the caller: openai | anthropic | dashboard | internal
  protocol?: string | null;
  // endpoint path, e.g. /api/v1/chat/completions
  endpoint?: string | null;
  // HTTP status code returned to the caller
  statusCode?: number | null;
  // EmorAI request id (echoed as request-id header on gateway responses)
  requestId?: string | null;
  apiKeyId?: string | null;
  conversationId?: string | null;
  modelId: string;
  servedModel?: string | null;
  usage?: TokenUsage | null;
  latencyMs?: number | null;
  success?: boolean;
  errorText?: string | null;
  // routing attribution (present when the request went through the router)
  routeId?: string | null;
  providerAccountId?: string | null;
};

/**
 * Persists a usage record. When the call came through the developer API the
 * owning ApiKey row is bumped (requestCount / lastUsedAt) as well.
 */
export async function recordUsage(input: RecordUsageInput): Promise<void> {
  const usage = input.usage;
  try {
    await db.usageRecord.create({
      data: {
        source: input.source,
        protocol: input.protocol ?? null,
        endpoint: input.endpoint ?? null,
        statusCode: input.statusCode ?? null,
        requestId: input.requestId ?? null,
        apiKeyId: input.apiKeyId ?? null,
        conversationId: input.conversationId ?? null,
        modelId: input.modelId,
        servedModel: input.servedModel ?? null,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        totalTokens: usage?.totalTokens ?? 0,
        latencyMs: input.latencyMs ?? null,
        success: input.success ?? true,
        errorText: input.errorText ? input.errorText.slice(0, 500) : null,
        routeId: input.routeId ?? null,
        providerAccountId: input.providerAccountId ?? null,
      },
    });
    if (input.apiKeyId) {
      await db.apiKey.update({
        where: { id: input.apiKeyId },
        data: { requestCount: { increment: 1 }, lastUsedAt: new Date() },
      });
    }
  } catch (e) {
    // Usage telemetry must never break the primary request.
    console.error('Failed to record usage:', e);
  }
}

/** Rough token estimate when the provider omits usage in streamed output. */
export function estimateUsage(
  messages: { content: unknown }[],
  completionText: string,
  // Accepts both the flat shape ({ arguments }) and the provider tool-call
  // shape ({ function: { arguments } }) — callers pass whichever they hold.
  toolCalls?: ReadonlyArray<{ arguments?: string; function?: { arguments?: string } }>
): TokenUsage {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content as { text?: string }[]) chars += part.text?.length ?? 0;
    }
  }
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) chars += tc.arguments?.length ?? tc.function?.arguments?.length ?? 0;
  }
  const promptTokens = Math.ceil(chars / 4);
  const completionTokens = Math.ceil(completionText.length / 4);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

/** Compact one-line preview of a request body, for validation-error logs. */
export function requestBodyPreview(raw: unknown, maxChars = 480): string {
  try {
    const s = JSON.stringify(raw) ?? '';
    return s.replace(/\s+/g, ' ').slice(0, maxChars);
  } catch {
    return '(unserializable body)';
  }
}

/** Best-effort model name extracted from an unvalidated request body. */
export function modelGuessFromRaw(raw: unknown): string {
  const m = (raw as { model?: unknown } | null | undefined)?.model;
  return typeof m === 'string' && m.length > 0 ? m.slice(0, 160) : 'unknown';
}

/** First moment of the current calendar month (UTC) — for monthly limits. */
export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Next month start (UTC) — when monthly limits reset. */
export function nextMonthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** Monthly aggregates for a key: request count + total tokens this month. */
export async function monthlyUsageForKey(apiKeyId: string): Promise<{ requests: number; totalTokens: number }> {
  const since = monthStart();
  const [requests, tokens] = await Promise.all([
    db.usageRecord.count({ where: { apiKeyId, createdAt: { gte: since } } }),
    db.usageRecord.aggregate({ where: { apiKeyId, createdAt: { gte: since } }, _sum: { totalTokens: true } }),
  ]);
  return { requests, totalTokens: tokens._sum.totalTokens ?? 0 };
}
