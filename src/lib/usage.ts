import { db } from '@/lib/db';
import type { TokenUsage } from '@/lib/types';

export type RecordUsageInput = {
  source: 'dashboard' | 'api';
  apiKeyId?: string | null;
  conversationId?: string | null;
  modelId: string;
  servedModel?: string | null;
  usage?: TokenUsage | null;
  latencyMs?: number | null;
  success?: boolean;
  errorText?: string | null;
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
export function estimateUsage(messages: { content: unknown }[], completionText: string): TokenUsage {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content as { text?: string }[]) chars += part.text?.length ?? 0;
    }
  }
  const promptTokens = Math.ceil(chars / 4);
  const completionTokens = Math.ceil(completionText.length / 4);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}
