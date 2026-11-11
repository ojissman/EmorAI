// ─── Anthropic-compatible adapter (fetch-based) ─────────────────────────────
// Executes against Anthropic's Messages API (or any Anthropic-wire-compatible
// upstream). Translates EmorAI's internal ProviderMessage shape (OpenAI-style)
// into Anthropic's system + content-blocks format, and normalizes Anthropic
// SSE events back into the unified StreamEvent contract so every consumer
// (OpenAI-compat AND Anthropic-compat gateways) sees one event stream.

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
import { parseUpstreamSSE } from '@/lib/ai/sse';
import type { ProviderContentPart, ProviderMessage, ProviderTool, ProviderToolCall, TokenUsage } from '@/lib/types';

const DEFAULT_TIMEOUT_MS = 120_000;
const ANTHROPIC_VERSION = '2023-06-01';

function baseUrlOf(ctx: AdapterContext): string {
  const raw = (ctx.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!raw) throw new ProviderError('provider_error', 'Anthropic-compatible account is missing its base URL.', { status: 500 });
  return raw;
}

function headersOf(ctx: AdapterContext): Record<string, string> {
  if (!ctx.apiKey) {
    throw new ProviderError('provider_auth', 'This provider account has no stored API key.', { status: 502 });
  }
  return {
    'x-api-key': ctx.apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'Content-Type': 'application/json',
  };
}

function classifyHttp(status: number, bodyText: string): ProviderError {
  const snippet = bodyText.slice(0, 300);
  if (status === 401 || status === 403) return new ProviderError('provider_auth', `Upstream rejected the stored credentials (HTTP ${status}).`, { status: 502 });
  if (status === 429) return new ProviderError('rate_limited', 'The upstream provider is rate limiting requests.', { status: 429, retryable: true });
  if (status === 404) return new ProviderError('model_unavailable', `The upstream does not have this model: ${snippet}`, { status: 502 });
  if (status >= 500) return new ProviderError('provider_error', `Upstream server error (HTTP ${status}): ${snippet}`, { status: 502, retryable: true });
  return new ProviderError('bad_request', `Upstream rejected the request (HTTP ${status}): ${snippet}`, { status: 400 });
}

// ── Provider (OpenAI-style) → Anthropic body ────────────────────────────────

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

function toAnthropicBody(opts: StreamChatOptions, stream: boolean): Record<string, unknown> {
  // Hoist the single leading system message; strip any mid-stream system content.
  const msgs = [...opts.messages];
  let system: string | undefined;
  if (msgs.length > 0 && msgs[0].role === 'system') {
    system = typeof msgs[0].content === 'string' ? msgs[0].content : '';
    msgs.shift();
  }

  const body: Record<string, unknown> = { stream };
  if (system && system.trim().length > 0) body.system = system.slice(0, 100_000);
  if (opts.modelId) body.model = opts.modelId;
  if (typeof opts.maxTokens === 'number') body.max_tokens = opts.maxTokens;
  else body.max_tokens = 4096; // Anthropic requires the field
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
  if (typeof opts.topP === 'number') body.top_p = opts.topP;
  if (opts.stop && opts.stop.length > 0) body.stop_sequences = opts.stop.slice(0, 16);

  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools.map((t: ProviderTool) => ({
      name: t.function.name,
      description: t.function.description ?? '',
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }));
    if (opts.toolChoice !== undefined) {
      const tc = opts.toolChoice as { type?: string; function?: { name?: string } } | string;
      if (tc === 'auto' || tc === 'none' || tc === 'required') body.tool_choice = { type: tc };
      else if (typeof tc === 'object' && tc?.type === 'function' && tc.function?.name) {
        body.tool_choice = { type: 'auto' }; // closest supported semantics
      } else if (typeof tc === 'string') {
        body.tool_choice = { type: 'tool', name: tc };
      }
    }
  }

  const out: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] | string }> = [];
  for (const m of msgs as ProviderMessage[]) {
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: String(m.content ?? '') }],
      });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks: AnthropicBlock[] = [];
      const text = typeof m.content === 'string' ? m.content : textOfParts(m.content);
      if (text.length > 0) blocks.push({ type: 'text', text });
      for (const tc of m.tool_calls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: safeJson(tc.function.arguments),
        });
      }
      out.push({ role: 'assistant', content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }] });
      continue;
    }
    // user (system content mid-stream is inlined as quoted text)
    if (m.role === 'system') {
      out.push({ role: 'user', content: [{ type: 'text', text: `[system] ${textOfAny(m.content)}` }] });
      continue;
    }
    if (Array.isArray(m.content)) {
      const blocks: AnthropicBlock[] = [];
      for (const part of m.content as ProviderContentPart[]) {
        if (part.type === 'text' && part.text) blocks.push({ type: 'text', text: part.text });
        if (part.type === 'image_url') {
          const parsed = parseDataUri(part.image_url.url);
          if (parsed) blocks.push({ type: 'image', source: parsed });
        }
      }
      out.push({ role: 'user', content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }] });
    } else {
      out.push({ role: 'user', content: String(m.content ?? '') });
    }
  }
  // Anthropic requires alternating user/assistant starting with user; collapse runs.
  const collapsed: typeof out = [];
  for (const m of out) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.role === m.role && m.role === 'user') {
      const prevBlocks = Array.isArray(prev.content) ? prev.content : [{ type: 'text' as const, text: prev.content }];
      const curBlocks = Array.isArray(m.content) ? m.content : [{ type: 'text' as const, text: m.content }];
      prev.content = [...prevBlocks, ...curBlocks];
    } else if (prev && prev.role === m.role && m.role === 'assistant') {
      const prevBlocks = Array.isArray(prev.content) ? prev.content : [{ type: 'text' as const, text: prev.content }];
      const curBlocks = Array.isArray(m.content) ? m.content : [{ type: 'text' as const, text: m.content }];
      prev.content = [...prevBlocks, ...curBlocks];
    } else {
      collapsed.push({ ...m });
    }
  }
  body.messages = collapsed.length > 0 ? collapsed : [{ role: 'user', content: '' }];
  return body;
}

function textOfAny(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return textOfParts(content as ProviderContentPart[]);
  return '';
}

function textOfParts(parts: ProviderContentPart[] | null | undefined): string {
  if (!Array.isArray(parts)) return '';
  return parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n');
}

function parseDataUri(url: string): { type: 'base64'; media_type: string; data: string } | null {
  const m = /^data:([^;]+);base64,([\s\S]+)$/.exec(url);
  if (!m) return null;
  return { type: 'base64', media_type: m[1], data: m[2] };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// ── Anthropic response → normalized events ───────────────────────────────────

export const anthropicCompatAdapter: AIProviderAdapter = {
  providerType: 'anthropic',

  async validateCredentials(ctx: AdapterContext): Promise<ProviderValidationResult> {
    try {
      await this.listModels(ctx);
      return { ok: true, message: 'Credentials accepted — model list retrieved.' };
    } catch (e) {
      return { ok: false, message: 'Credential validation failed.', detail: String((e as Error)?.message ?? e).slice(0, 300) };
    }
  },

  async listModels(ctx: AdapterContext): Promise<UpstreamModel[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(`${baseUrlOf(ctx)}/models`, { method: 'GET', headers: headersOf(ctx), signal: controller.signal });
      const text = await res.text();
      if (!res.ok) throw classifyHttp(res.status, text);
      const data = JSON.parse(text) as { data?: Array<{ id?: string; display_name?: string }> };
      return (data.data ?? [])
        .filter((m) => typeof m.id === 'string' && m.id.length > 0)
        .map((m) => ({ modelId: String(m.id), displayName: m.display_name ?? undefined, raw: m as Record<string, unknown> }));
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError('provider_error', `Model discovery failed: ${String((e as Error)?.message ?? e).slice(0, 300)}`, { status: 502 });
    } finally {
      clearTimeout(timer);
    }
  },

  async *streamChat(ctx: AdapterContext, opts: StreamChatOptions): AsyncGenerator<StreamEvent> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    let upstream: ReadableStream<Uint8Array> | null = null;
    // per-block tool argument accumulators
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    let toolIndex = 0;
    try {
      const res = await fetch(`${baseUrlOf(ctx)}/messages`, {
        method: 'POST',
        headers: headersOf(ctx),
        body: JSON.stringify(toAnthropicBody(opts, true)),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw classifyHttp(res.status, text);
      }
      if (!res.body) throw new ProviderError('provider_error', 'Upstream returned no stream.', { status: 502 });
      upstream = res.body;

      for await (const { data } of parseUpstreamSSE(upstream)) {
        const type = data.type as string | undefined;
        if (type === 'message_start') {
          const model = (data.message as { model?: string } | undefined)?.model;
          if (typeof model === 'string' && model) yield { type: 'served-model', model };
        } else if (type === 'content_block_start') {
          const block = data.content_block as { type?: string; id?: string; name?: string } | undefined;
          if (block?.type === 'tool_use' && block.name) {
            const idx = toolIndex++;
            toolAcc.set(idx, { id: block.id ?? `call_${idx}`, name: block.name, args: '' });
            yield { type: 'tool-call-delta', call: { index: idx, id: toolAcc.get(idx)!.id, name: block.name } };
          }
        } else if (type === 'content_block_delta') {
          const delta = data.delta as { type?: string; text?: string; partial_json?: string; thinking?: string } | undefined;
          if (!delta) continue;
          if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
            yield { type: 'delta', content: delta.text };
          } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
            yield { type: 'reasoning', content: delta.thinking };
          } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            const idx = toolIndex - 1;
            const acc = toolAcc.get(idx);
            if (acc) {
              acc.args += delta.partial_json;
              yield { type: 'tool-call-delta', call: { index: idx, argumentsDelta: delta.partial_json } };
            }
          }
        } else if (type === 'message_delta') {
          const delta = data.delta as { stop_reason?: string } | undefined;
          const usageIn = (data.usage as Record<string, unknown> | undefined) ?? undefined;
          if (delta?.stop_reason) yield { type: 'finish', reason: delta.stop_reason };
          if (usageIn) {
            const usage = anthropicUsage(usageIn);
            if (usage) yield { type: 'usage', usage };
          }
        } else if (type === 'error') {
          const err = data.error as { message?: string } | undefined;
          throw new ProviderError('provider_error', `Upstream stream error: ${err?.message ?? 'unknown'}`, { status: 502 });
        }
      }
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrlOf(ctx)}/messages`, {
        method: 'POST',
        headers: headersOf(ctx),
        body: JSON.stringify(toAnthropicBody(opts, false)),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw classifyHttp(res.status, text);
      const data = JSON.parse(text) as {
        model?: string;
        stop_reason?: string;
        content?: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }>;
        usage?: Record<string, unknown>;
      };
      let content = '';
      let reasoning: string | null = null;
      const toolCalls: ProviderToolCall[] = [];
      for (const block of data.content ?? []) {
        if (block.type === 'text' && typeof block.text === 'string') content += block.text;
        else if (block.type === 'thinking' && typeof block.thinking === 'string') reasoning = block.thinking;
        else if (block.type === 'tool_use' && block.name) {
          toolCalls.push({
            id: block.id ?? `call_${toolCalls.length}`,
            type: 'function' as const,
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
        }
      }
      const usage = anthropicUsage(data.usage ?? {});
      return {
        content,
        servedModel: data.model ?? null,
        usage,
        finishReason: data.stop_reason ?? null,
        toolCalls,
        reasoning,
      };
    } finally {
      clearTimeout(timer);
    }
  },

  async checkHealth(ctx: AdapterContext): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      await this.listModels(ctx);
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
      case 'discovery':
        return true;
      case 'webSearch':
        return false; // server-side tool, Z.ai only
    }
  },
};

// usage arrives in message_delta frames (input+output tokens), which the
// loop above normalizes directly.

function anthropicUsage(u: Record<string, unknown>): TokenUsage | null {
  const input = Number(u.input_tokens ?? 0);
  const output = Number(u.output_tokens ?? 0);
  if (input === 0 && output === 0) return null;
  return { promptTokens: input, completionTokens: output, totalTokens: input + output };
}
