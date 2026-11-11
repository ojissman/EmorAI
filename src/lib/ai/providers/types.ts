// ─── Provider adapter contract ───────────────────────────────────────────────
// EmorAI's provider-independent execution architecture. Every upstream AI
// provider implements this one normalized interface; the router selects a
// route → account → adapter and executes through it. Provider-specific
// differences live INSIDE adapters, never in routes or business logic.
//
// Existing normalized wire types (ProviderMessage / StreamEvent /
// CompleteChatResult from lib/types + lib/ai/zai-adapter) are the lingua
// franca between adapters and the API protocol layers — they stay unchanged
// so every existing consumer keeps working.

import type {
  CompleteChatResult,
  StreamChatOptions,
  StreamEvent,
} from '@/lib/ai/zai-adapter';
import type { ProviderMessage } from '@/lib/types';

export type { CompleteChatResult, StreamChatOptions, StreamEvent };

/** An upstream model as reported by a provider's discovery API (where offered). */
export type UpstreamModel = {
  modelId: string;
  displayName?: string;
  contextWindow?: number | null;
  // capabilities the provider itself reports — unknown stays undefined;
  // EmorAI never infers capability from a model name.
  ownedBy?: string | null;
  raw?: Record<string, unknown> | null;
};

export type ProviderValidationResult = {
  ok: boolean;
  message: string;
  // what the provider reports about the credentials (never the secret itself)
  detail?: string;
};

export type ProviderHealth = {
  ok: boolean;
  latencyMs: number;
  message?: string;
};

/** Resolved credentials for one execution against an account. */
export type AdapterContext = {
  // account DB id (for usage attribution)
  accountId: string;
  accountName: string;
  // provider type key, e.g. "zai" | "openai" | "anthropic" | "self-hosted"
  providerType: string;
  // decrypted API key — server-side only, NEVER sent to the client
  apiKey?: string | null;
  baseUrl?: string | null;
};

/**
 * The normalized execution contract. Adapters must implement streaming chat
 * and non-streaming chat; everything else is optional and must be honestly
 * reported via supports() rather than pretending.
 */
export interface AIProviderAdapter {
  providerType: string;

  /** Verifies credentials without executing a billable completion. */
  validateCredentials(ctx: AdapterContext): Promise<ProviderValidationResult>;

  /** Lists upstream models via the provider's discovery API (where offered). */
  listModels(ctx: AdapterContext): Promise<UpstreamModel[]>;

  /** Streaming chat — normalized events identical to the legacy zai contract. */
  streamChat(ctx: AdapterContext, opts: StreamChatOptions): AsyncGenerator<StreamEvent>;

  /** Non-streaming chat. */
  completeChat(ctx: AdapterContext, opts: StreamChatOptions): Promise<CompleteChatResult>;

  /** Lightweight availability/latency probe. */
  checkHealth(ctx: AdapterContext): Promise<ProviderHealth>;

  /** Honest feature support — never claim what the provider cannot do. */
  supports(feature: 'chat' | 'streaming' | 'tools' | 'vision' | 'webSearch' | 'discovery'): boolean;
}

/** Vision / web-search / title helpers stay provider-specific capabilities. */
export type VisionCapableAdapter = AIProviderAdapter & {
  completeVision(ctx: AdapterContext, opts: {
    messages: ProviderMessage[];
    modelId?: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<CompleteChatResult>;
};

export type WebSearchCapableAdapter = AIProviderAdapter & {
  webSearch(query: string, num?: number): Promise<Array<{ url: string; name: string; snippet: string; host_name: string }>>;
};
