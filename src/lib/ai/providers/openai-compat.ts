// ─── OpenAI-compatible adapter (fetch-based, no vendor SDK) ─────────────────
// Serves every OpenAI-wire-compatible upstream: OpenAI itself, DeepSeek,
// Mistral, Groq, Together, xAI, and self-hosted servers (vLLM, Ollama, TGI,
// SGLang). One adapter, configured per provider account with baseUrl + key.
//
// Wire notes:
//   • Requests/reponses follow the OpenAI chat-completions JSON + SSE shapes.
//   • ProviderMessage (our internal shape) IS the OpenAI message shape, so
//     translation is limited to body assembly + response normalization.
//   • Errors are normalized to ProviderError with honest classification.

import type {
  AIProviderAdapter,
  AdapterContext,
  CompleteChatResult,
  ProviderHealth,
  ProviderValidationResult,
  StreamChatOptions,
  StreamEvent,
  UpstreamModel,
} from './types';
import { ProviderError } from '@/lib/ai/zai-adapter';
import type { ProviderErrorCode } from '@/lib/ai/zai-adapter';
import { parseUpstreamSSE } from '@/lib/ai/sse';
import {
  DestinationBlockedError,
  ResponseTooLargeError,
  isAbortLikeError,
  secureFetch,
} from '@/lib/net/secure-fetch';
import { loadNetworkPolicy } from '@/lib/net/url-policy';
import { finalizeProviderMessages } from '@/lib/api/protocol/roles';
import type { TokenUsage } from '@/lib/types';

const DEFAULT_TIMEOUT_MS = 120_000;

function baseUrlOf(ctx: AdapterContext): string {
  const raw = (ctx.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!raw) {
    throw new ProviderError('provider_error', 'OpenAI-compatible account is missing its base URL.', { status: 500 });
  }
  return raw;
}

function headersOf(ctx: AdapterContext): Record<string, string> {
  if (!ctx.apiKey) {
    throw new ProviderError('provider_auth', 'This provider account has no stored API key.', { status: 502 });
  }
  return {
    Authorization: `Bearer ${ctx.apiKey}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Network-policy failures surface as ProviderError with honest codes
 * ('destination_blocked' | 'response_too_large'). These codes widen the shared
 * ProviderErrorCode union at runtime; the union itself lives in zai-adapter.ts,
 * which is owned by a separate workstream and intentionally untouched here.
 * Unknown codes fall through to generic provider-error handling downstream.
 */
function policyFailure(e: unknown): ProviderError | null {
  if (e instanceof DestinationBlockedError) {
    return new ProviderError(
      'destination_blocked' as ProviderErrorCode,
      `Upstream destination rejected by network policy (${e.reason}).`,
      { status: 502 },
    );
  }
  if (e instanceof ResponseTooLargeError) {
    return new ProviderError(
      'response_too_large' as ProviderErrorCode,
      'Upstream response exceeded the configured size cap and was aborted.',
      { status: 502 },
    );
  }
  return null;
}

/** Normalizes upstream HTTP/JSON failures into ProviderError. */
function classifyHttp(status: number, bodyText: string): ProviderError {
  const snippet = bodyText.slice(0, 300);
  if (status === 401 || status === 403) {
    return new ProviderError('provider_auth', `Upstream rejected the stored credentials (HTTP ${status}).`, { status: 502 });
  }
  if (status === 429) {
    return new ProviderError('rate_limited', 'The upstream provider is rate limiting requests.', { status: 429, retryable: true });
  }
  if (status === 404) {
    return new ProviderError('model_unavailable', `The upstream does not have this model (HTTP 404): ${snippet}`, { status: 502 });
  }
  if (status >= 500) {
    return new ProviderError('provider_error', `Upstream server error (HTTP ${status}): ${snippet}`, { status: 502, retryable: true });
  }
  return new ProviderError('bad_request', `Upstream rejected the request (HTTP ${status}): ${snippet}`, { status: 400 });
}

async function fetchJson(ctx: AdapterContext, path: string, init: RequestInit & { timeoutMs?: number }): Promise<unknown> {
  const controller = new AbortController();
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const external = init.signal;
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    // SSRF guard: destination policy (fresh DNS, redirect + size caps) wraps
    // every outbound call; timeout semantics are unchanged (same budget,
    // combined with the adapter's abort controller)
    const policy = await loadNetworkPolicy();
    const res = await secureFetch(
      `${baseUrlOf(ctx)}${path}`,
      {
        ...init,
        signal: controller.signal,
        headers: { ...headersOf(ctx), ...(init.headers ?? {}) },
      },
      { timeoutMs, policy },
    );
    const text = await res.text();
    if (!res.ok) throw classifyHttp(res.status, text);
    try {
      return text.length > 0 ? JSON.parse(text) : {};
    } catch {
      throw new ProviderError('provider_error', 'Upstream returned a non-JSON response.', { status: 502 });
    }
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    const policyErr = policyFailure(e);
    if (policyErr) throw policyErr;
    if (isAbortLikeError(e)) {
      throw new ProviderError('timeout', 'Upstream request timed out.', { status: 504 });
    }
    throw new ProviderError('provider_error', `Upstream request failed: ${String((e as Error)?.message ?? e).slice(0, 300)}`, { status: 502, retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

function buildBody(opts: StreamChatOptions, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    messages: finalizeProviderMessages(opts.messages),
    stream,
  };
  if (opts.modelId) body.model = opts.modelId;
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
  if (typeof opts.maxTokens === 'number') body.max_tokens = opts.maxTokens;
  if (typeof opts.topP === 'number') body.top_p = opts.topP;
  if (opts.stop && opts.stop.length > 0) body.stop = opts.stop.slice(0, 16);
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    if (opts.toolChoice !== undefined) body.tool_choice = opts.toolChoice;
  }
  // keep stream_options off — usage arrives in the terminal chunk by default
  return body;
}

function normalizeUsage(u: Record<string, unknown> | undefined): TokenUsage | null {
  if (!u) return null;
  return {
    promptTokens: Number(u.prompt_tokens ?? 0),
    completionTokens: Number(u.completion_tokens ?? 0),
    totalTokens: Number(u.total_tokens ?? 0),
  };
}

export const openAiCompatAdapter: AIProviderAdapter = {
  providerType: 'openai',

  async validateCredentials(ctx: AdapterContext): Promise<ProviderValidationResult> {
    try {
      await fetchJson(ctx, '/models', { method: 'GET', timeoutMs: 20_000 });
      return { ok: true, message: 'Credentials accepted — model list retrieved.' };
    } catch (e) {
      return { ok: false, message: 'Credential validation failed.', detail: String((e as Error)?.message ?? e).slice(0, 300) };
    }
  },

  async listModels(ctx: AdapterContext): Promise<UpstreamModel[]> {
    const data = (await fetchJson(ctx, '/models', { method: 'GET', timeoutMs: 30_000 })) as {
      data?: Array<{ id?: string; owned_by?: string; context_length?: number }>;
    };
    const rows = Array.isArray(data?.data) ? data.data : [];
    return rows
      .filter((m) => typeof m.id === 'string' && m.id.length > 0)
      .map((m) => ({
        modelId: String(m.id),
        ownedBy: m.owned_by ?? null,
        contextWindow: typeof m.context_length === 'number' ? m.context_length : null,
        raw: m as Record<string, unknown>,
      }));
  },

  async *streamChat(ctx: AdapterContext, opts: StreamChatOptions): AsyncGenerator<StreamEvent> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    let upstream: ReadableStream<Uint8Array> | null = null;
    try {
      const policy = await loadNetworkPolicy();
      const res = await secureFetch(
        `${baseUrlOf(ctx)}/chat/completions`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: headersOf(ctx),
          body: JSON.stringify(buildBody(opts, true)),
        },
        { timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, policy },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw classifyHttp(res.status, text);
      }
      if (!res.body) throw new ProviderError('provider_error', 'Upstream returned no stream.', { status: 502 });
      upstream = res.body;
      for await (const { data } of parseUpstreamSSE(upstream)) {
        if (typeof data.model === 'string' && data.model) {
          yield { type: 'served-model', model: data.model };
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
            const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
            if (Array.isArray(toolCalls)) {
              for (const tc of toolCalls) {
                const fn = tc.function as Record<string, unknown> | undefined;
                yield {
                  type: 'tool-call-delta',
                  call: {
                    index: typeof tc.index === 'number' ? tc.index : 0,
                    id: typeof tc.id === 'string' && tc.id ? tc.id : undefined,
                    name: typeof fn?.name === 'string' && fn.name ? fn.name : undefined,
                    argumentsDelta: typeof fn?.arguments === 'string' ? fn.arguments : undefined,
                  },
                };
              }
            }
          }
          if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
            yield { type: 'finish', reason: choice.finish_reason };
          }
        }
        const usage = normalizeUsage(data.usage as Record<string, unknown> | undefined);
        if (usage) yield { type: 'usage', usage };
      }
    } catch (e) {
      // network-policy failures surface as honest ProviderErrors; everything
      // else keeps the generator's existing (raw) propagation semantics
      const policyErr = policyFailure(e);
      if (policyErr) throw policyErr;
      throw e;
    } finally {
      clearTimeout(timer);
      try {
        await upstream?.cancel();
      } catch {
        // stream already closed
      }
    }
  },

  async completeChat(ctx: AdapterContext, opts: StreamChatOptions): Promise<CompleteChatResult> {
    const res = (await fetchJson(ctx, '/chat/completions', {
      method: 'POST',
      body: JSON.stringify(buildBody(opts, false)),
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: opts.signal,
    })) as {
      model?: string;
      choices?: Array<{
        message?: {
          content?: string;
          reasoning_content?: string;
          tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
        };
        finish_reason?: string;
      }>;
      usage?: Record<string, unknown>;
    };
    const choice = res.choices?.[0];
    const toolCalls = (choice?.message?.tool_calls ?? [])
      .filter((tc) => tc.function?.name)
      .map((tc, i) => ({
        id: tc.id && tc.id.length > 0 ? tc.id : `call_${Date.now().toString(36)}_${i}`,
        type: 'function' as const,
        function: {
          name: String(tc.function?.name),
          arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : '{}',
        },
      }));
    return {
      content: choice?.message?.content ?? '',
      servedModel: res.model ?? null,
      usage: normalizeUsage(res.usage),
      finishReason: choice?.finish_reason ?? null,
      toolCalls,
      reasoning: choice?.message?.reasoning_content ?? null,
    };
  },

  async checkHealth(ctx: AdapterContext): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      await fetchJson(ctx, '/models', { method: 'GET', timeoutMs: 15_000 });
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
      case 'discovery':
        return true;
      case 'vision':
        // OpenAI-compatible servers *may* accept image_url parts — support is
        // per-model and unverified by EmorAI; capability gating happens at the
        // route/model level with verified metadata.
        return false;
      case 'webSearch':
        return false; // provider-specific tool, Z.ai only
    }
  },
};

/** Same wire protocol; distinct providerType so self-hosted deployments and
 *  external SaaS accounts are tracked separately (licensing + attribution). */
export const selfHostedAdapter: AIProviderAdapter = {
  ...openAiCompatAdapter,
  providerType: 'self-hosted',
};
