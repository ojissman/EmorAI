// ─── Z.ai adapter (platform-managed credentials) ────────────────────────────
// Wraps the existing, production-hardened Z.ai execution layer
// (lib/ai/zai-adapter.ts — retry/backoff, SSE parsing, tool-name round-trip,
// vision, web search) behind the normalized AIProviderAdapter contract.
// The legacy functions keep their exact signatures so every existing
// consumer (/api/chat, /api/v1/*, agent runs, summaries, probes) is untouched.

import type {
  AIProviderAdapter,
  AdapterContext,
  CompleteChatResult,
  ProviderHealth,
  ProviderValidationResult,
  StreamChatOptions,
  StreamEvent,
  UpstreamModel,
  VisionCapableAdapter,
  WebSearchCapableAdapter,
} from './types';
import {
  streamChat as zaiStreamChat,
  completeChat as zaiCompleteChat,
  completeVision as zaiCompleteVision,
  webSearch as zaiWebSearch,
} from '@/lib/ai/zai-adapter';
import type { ProviderMessage } from '@/lib/types';

function ctxOpts(ctx: AdapterContext, opts: StreamChatOptions): StreamChatOptions {
  // zai credentials are platform-managed (SDK environment) — the context
  // carries no secret for this adapter; provider is forced to 'zai'.
  return { ...opts, provider: 'zai' };
}

const ZAI_ADAPTER: VisionCapableAdapter & WebSearchCapableAdapter & AIProviderAdapter = {
  providerType: 'zai',

  async validateCredentials(): Promise<ProviderValidationResult> {
    // The Z.ai SDK reads its own environment configuration; a tiny completion
    // is the only authoritative way to verify it. Reuse the health probe.
    const health = await this.checkHealth({ accountId: '', accountName: '', providerType: 'zai' });
    return {
      ok: health.ok,
      message: health.ok
        ? 'Platform Z.ai credentials are configured and responding.'
        : 'Z.ai credentials are not usable in this environment.',
      detail: health.message,
    };
  },

  async listModels(): Promise<UpstreamModel[]> {
    // The Z.ai web-dev SDK does not expose a public model-listing API; the
    // registry's spaced availability probe (discoverAvailability) is the
    // supported discovery path for this provider. Honest empty result:
    return [];
  },

  async *streamChat(ctx: AdapterContext, opts: StreamChatOptions): AsyncGenerator<StreamEvent> {
    yield* zaiStreamChat(ctxOpts(ctx, opts));
  },

  async completeChat(ctx: AdapterContext, opts: StreamChatOptions): Promise<CompleteChatResult> {
    return zaiCompleteChat(ctxOpts(ctx, opts));
  },

  async checkHealth(): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const res = await zaiCompleteChat({
        messages: [{ role: 'user', content: 'Reply with: OK' }],
        maxTokens: 8,
        timeoutMs: 30_000,
      });
      if (!res.content || res.content.trim().length === 0) throw new Error('empty response');
      return { ok: true, latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - started, message: String((e as Error)?.message ?? e).slice(0, 300) };
    }
  },

  supports(feature) {
    switch (feature) {
      case 'chat':
      case 'streaming':
      case 'tools':
      case 'vision':
      case 'webSearch':
        return true;
      case 'discovery':
        // No public listing API on this SDK — discovery uses probing instead.
        return false;
    }
  },

  async completeVision(_ctx: AdapterContext, opts: {
    messages: ProviderMessage[];
    modelId?: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<CompleteChatResult> {
    return zaiCompleteVision(opts);
  },

  async webSearch(query: string, num = 6) {
    return zaiWebSearch(query, num);
  },
};

export const zaiAdapter = ZAI_ADAPTER;
