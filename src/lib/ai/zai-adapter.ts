import ZAI from 'z-ai-web-dev-sdk';
import { parseUpstreamSSE, sseDone, sseEvent } from '@/lib/ai/sse';
import type { ProviderMessage, TokenUsage, WebSource } from '@/lib/types';

// ─── Provider errors ─────────────────────────────────────────────────────────

export type ProviderErrorCode =
  | 'rate_limited'
  | 'provider_auth'
  | 'model_unavailable'
  | 'bad_request'
  | 'content_filtered'
  | 'provider_error'
  | 'aborted';

export class ProviderError extends Error {
  code: ProviderErrorCode;
  status: number;
  retryable: boolean;

  constructor(code: ProviderErrorCode, message: string, opts?: { status?: number; retryable?: boolean }) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = opts?.status ?? 502;
    this.retryable = opts?.retryable ?? false;
  }
}

function classifyProviderFailure(raw: string): ProviderError {
  const lower = raw.toLowerCase();
  if (lower.includes('429') || lower.includes('too many requests') || lower.includes('rate limit')) {
    return new ProviderError(
      'rate_limited',
      'The AI provider is rate limiting requests right now. Wait a few seconds and try again — nothing was charged.',
      { status: 429, retryable: true }
    );
  }
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api key')) {
    return new ProviderError(
      'provider_auth',
      'Provider credentials are missing or invalid. Configure Z.ai credentials server-side (.z-ai-config or environment) and restart.',
      { status: 502 }
    );
  }
  if (lower.includes('1211') || lower.includes('model not found') || lower.includes('does not exist') || lower.includes('not available') || lower.includes('403') || lower.includes('permission denied')) {
    return new ProviderError(
      'model_unavailable',
      'The selected model is not available on your provider plan. Pick another model in Settings → Models, or test this model to see what the gateway actually serves.',
      { status: 502 }
    );
  }
  if (lower.includes('content filter') || lower.includes('1302')) {
    return new ProviderError('content_filtered', 'The provider declined this request due to content filtering.', { status: 422 });
  }
  if (lower.includes('400') || lower.includes('invalid')) {
    return new ProviderError('bad_request', `Provider rejected the request: ${raw.slice(0, 300)}`, { status: 400 });
  }
  return new ProviderError('provider_error', `Provider request failed: ${raw.slice(0, 300)}`, { status: 502, retryable: true });
}

// ─── Adapter types ───────────────────────────────────────────────────────────

export type StreamChatOptions = {
  messages: ProviderMessage[];
  modelId?: string;
  provider?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

export type StreamEvent =
  | { type: 'served-model'; model: string }
  | { type: 'delta'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: string };

export type CompleteChatResult = {
  content: string;
  servedModel: string | null;
  usage: TokenUsage | null;
  finishReason: string | null;
};

const RETRY_DELAYS_MS = [1200, 2600];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function providerSupported(provider?: string): boolean {
  // The registry routes by provider; Z.ai is the v1 provider. Additional
  // adapters plug in here as new providers are added.
  return !provider || provider === 'zai';
}

function buildBody(opts: StreamChatOptions, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    messages: opts.messages,
    stream,
    thinking: { type: 'disabled' },
  };
  if (opts.modelId) body.model = opts.modelId;
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
  if (typeof opts.maxTokens === 'number') body.max_tokens = opts.maxTokens;
  return body;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new ProviderError('aborted', 'Request aborted', { status: 499 });
  }
}

// ─── Streaming chat ──────────────────────────────────────────────────────────

/**
 * Streams a chat completion from the Z.ai gateway. Yields normalized events:
 * served-model, delta, reasoning, usage, finish. Retries rate limits with
 * backoff while no tokens have been received yet.
 */
export async function* streamChat(opts: StreamChatOptions): AsyncGenerator<StreamEvent> {
  if (!providerSupported(opts.provider)) {
    throw new ProviderError('model_unavailable', `Provider "${opts.provider}" is not configured on this installation yet.`, { status: 502 });
  }
  throwIfAborted(opts.signal);

  const zai = await ZAI.create();
  let attempt = 0;
  let upstream: ReadableStream<Uint8Array> | undefined;
  const hasVisionParts = opts.messages.some((m) => Array.isArray(m.content));

  // Connect with backoff for rate limits; never retry mid-stream.
  for (;;) {
    try {
      const body = buildBody(opts, true);
      const res = hasVisionParts
        ? await zai.chat.completions.createVision(body as never)
        : await zai.chat.completions.create(body as never);
      upstream = res as ReadableStream<Uint8Array>;
      break;
    } catch (e) {
      const err = classifyProviderFailure(String((e as Error)?.message ?? e));
      if (err.retryable && attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        attempt += 1;
        throwIfAborted(opts.signal);
        continue;
      }
      throw err;
    }
  }

  if (!upstream) {
    throw new ProviderError('provider_error', 'Provider returned no stream.', { status: 502 });
  }

  let servedModel: string | null = null;
  let announcedModel = false;
  let finishReason: string | null = null;

  for await (const { data } of parseUpstreamSSE(upstream)) {
    throwIfAborted(opts.signal);
    if (typeof data.model === 'string' && data.model) {
      servedModel = data.model;
      if (!announcedModel) {
        announcedModel = true;
        yield { type: 'served-model', model: data.model };
      }
    }
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (choice) {
      const delta = choice.delta as Record<string, unknown> | undefined;
      if (delta) {
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          yield { type: 'reasoning', content: reasoning };
        }
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          yield { type: 'delta', content: delta.content };
        }
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
        finishReason = choice.finish_reason;
        yield { type: 'finish', reason: choice.finish_reason };
      }
    }
    const usage = data.usage as Record<string, unknown> | undefined;
    if (usage) {
      yield {
        type: 'usage',
        usage: {
          promptTokens: Number(usage.prompt_tokens ?? 0),
          completionTokens: Number(usage.completion_tokens ?? 0),
          totalTokens: Number(usage.total_tokens ?? 0),
        },
      };
    }
  }

  void servedModel;
  void finishReason;
}

// ─── Non-streaming chat ──────────────────────────────────────────────────────

export async function completeChat(opts: StreamChatOptions): Promise<CompleteChatResult> {
  if (!providerSupported(opts.provider)) {
    throw new ProviderError('model_unavailable', `Provider "${opts.provider}" is not configured on this installation yet.`, { status: 502 });
  }
  throwIfAborted(opts.signal);

  const zai = await ZAI.create();
  let attempt = 0;
  for (;;) {
    try {
      const res = (await zai.chat.completions.create(buildBody(opts, false) as never)) as {
        model?: string;
        choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const content = res.choices?.[0]?.message?.content ?? '';
      return {
        content,
        servedModel: res.model ?? null,
        usage: res.usage
          ? {
              promptTokens: res.usage.prompt_tokens ?? 0,
              completionTokens: res.usage.completion_tokens ?? 0,
              totalTokens: res.usage.total_tokens ?? 0,
            }
          : null,
        finishReason: res.choices?.[0]?.finish_reason ?? null,
      };
    } catch (e) {
      const err = classifyProviderFailure(String((e as Error)?.message ?? e));
      if (err.retryable && attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        attempt += 1;
        throwIfAborted(opts.signal);
        continue;
      }
      throw err;
    }
  }
}

// ─── Vision ──────────────────────────────────────────────────────────────────

export async function completeVision(opts: {
  messages: ProviderMessage[];
  modelId?: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<CompleteChatResult> {
  throwIfAborted();
  const zai = await ZAI.create();
  const body: Record<string, unknown> = {
    messages: opts.messages,
    thinking: { type: 'disabled' },
  };
  if (opts.modelId) body.model = opts.modelId;
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
  if (typeof opts.maxTokens === 'number') body.max_tokens = opts.maxTokens;
  try {
    const res = (await zai.chat.completions.createVision(body as never)) as {
      model?: string;
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    return {
      content: res.choices?.[0]?.message?.content ?? '',
      servedModel: res.model ?? null,
      usage: res.usage
        ? {
            promptTokens: res.usage.prompt_tokens ?? 0,
            completionTokens: res.usage.completion_tokens ?? 0,
            totalTokens: res.usage.total_tokens ?? 0,
          }
        : null,
      finishReason: res.choices?.[0]?.finish_reason ?? null,
    };
  } catch (e) {
    throw classifyProviderFailure(String((e as Error)?.message ?? e));
  }
}

// ─── Web search tool ─────────────────────────────────────────────────────────

export async function webSearch(query: string, num = 6): Promise<WebSource[]> {
  const zai = await ZAI.create();
  const results = (await zai.functions.invoke('web_search', { query: query.slice(0, 400), num })) as Array<{
    url: string;
    name: string;
    snippet: string;
    host_name: string;
  }>;
  if (!Array.isArray(results)) return [];
  return results.slice(0, num).map((r) => ({
    url: String(r.url ?? ''),
    name: String(r.name ?? ''),
    snippet: String(r.snippet ?? '').slice(0, 400),
    host_name: String(r.host_name ?? ''),
  }));
}

// ─── Conversation title generation ───────────────────────────────────────────

export async function generateTitle(firstUserMessage: string, assistantReply: string): Promise<string> {
  const truncatedUser = firstUserMessage.slice(0, 500);
  const truncatedReply = assistantReply.slice(0, 300);
  const fallback = truncatedUser.replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ').slice(0, 48) || 'New chat';
  try {
    const res = await completeChat({
      messages: [
        {
          role: 'system',
          content:
            'You generate short conversation titles. Reply with ONLY the title: 3 to 6 words, no quotes, no punctuation at the end, same language as the conversation.',
        },
        { role: 'user', content: `User message: ${truncatedUser}\n\nAssistant reply (start): ${truncatedReply}\n\nGenerate the title now.` },
      ],
      temperature: 0.3,
      maxTokens: 32,
    });
    const title = res.content.replace(/["'`\n]/g, '').trim();
    if (title.length >= 3 && title.length <= 64) return title;
    return fallback;
  } catch {
    return fallback;
  }
}

export { sseDone, sseEvent };
