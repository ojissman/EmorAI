// ─────────────────────────────────────────────────────────────────────────────
// Anthropic Messages API protocol layer — REAL protocol translation.
//
// Translates Anthropic wire format (used by Claude Code, the Anthropic SDKs
// and Anthropic-compatible agents) to/from EmorAI's internal provider format:
//   * request translation: content blocks, tool_use / tool_result round-trips,
//     system prompts, sampling params, stop sequences, tool definitions
//   * response translation: Anthropic message objects with text + tool_use
//     content blocks, stop_reason semantics, input/output token usage
//   * streaming translation: full Anthropic SSE event sequence
//     (message_start, ping, content_block_start/delta/stop, message_delta,
//     message_stop) incl. tool-use input_json_delta streaming
//   * error translation: Anthropic error envelopes with proper types
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import type { AuthFailure } from '@/lib/api/auth';
import type { AuthenticatedKey } from '@/lib/api/auth';
import { corsJson } from '@/lib/api/cors';
import type { ProviderContentPart, ProviderMessage, ProviderTool, ProviderToolCall, TokenUsage } from '@/lib/types';
import type { StreamEvent, ToolCallDelta } from '@/lib/ai/zai-adapter';

// ─── Error envelope ──────────────────────────────────────────────────────────

export type AnthropicErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'api_error'
  | 'overloaded_error';

export function anthropicError(
  status: number,
  type: AnthropicErrorType,
  message: string,
  headers?: Record<string, string>
): Response {
  return corsJson({ type: 'error', error: { type, message } }, { status, headers });
}

/** Shapes a protocol-agnostic auth failure into the Anthropic envelope. */
export function anthropicAuthFailure(failure: AuthFailure): Response {
  const headers: Record<string, string> = {};
  if (failure.retryAfterSec) headers['retry-after'] = String(failure.retryAfterSec);
  return anthropicError(failure.status, failure.anthropicType, failure.message, headers);
}

/** Maps a provider (upstream) failure into the Anthropic error envelope. */
export function anthropicProviderError(code: string, message: string, status: number): Response {
  const type: AnthropicErrorType =
    code === 'rate_limited'
      ? 'rate_limit_error'
      : code === 'bad_request'
        ? 'invalid_request_error'
        : code === 'model_unavailable'
          ? 'api_error'
          : status >= 500
            ? 'overloaded_error'
            : 'api_error';
  const headers: Record<string, string> = {};
  if (code === 'rate_limited') headers['retry-after'] = '15';
  return anthropicError(status === 429 ? 429 : status >= 500 ? (status === 502 ? 529 : status) : status, type, message, headers);
}

// ─── Request schema (Anthropic Messages API) ─────────────────────────────────

export const anthropicImageSourceSchema = z.union([
  z.object({ type: z.literal('base64'), media_type: z.string(), data: z.string() }),
  z.object({ type: z.literal('url'), url: z.string() }),
]);

export const anthropicContentBlockSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string(), cache_control: z.unknown().optional() }),
  z.object({ type: z.literal('image'), source: anthropicImageSourceSchema }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.union([z.string(), z.array(z.object({ type: z.string() }).passthrough())]).optional(),
    is_error: z.boolean().optional(),
    cache_control: z.unknown().optional(),
  }),
  z.object({ type: z.literal('document'), source: z.unknown() }),
  z.object({ type: z.literal('thinking'), thinking: z.string().optional(), signature: z.string().optional() }),
  z.object({ type: z.literal('redacted_thinking'), data: z.string().optional() }),
]);

export const anthropicMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string().max(400_000), z.array(anthropicContentBlockSchema).max(128)]),
});

export const anthropicToolSchema = z.object({
  name: z.string().min(1).max(128),
  // Coding agents (ZCode, Claude Code…) ship long descriptions. Accept what
  // the real Anthropic API accepts; the provider adapter clamps to the
  // upstream limit before forwarding.
  description: z.string().max(100_000).optional(),
  input_schema: z.record(z.string(), z.unknown()),
  cache_control: z.unknown().optional(),
});

export const anthropicToolChoiceSchema = z.union([
  z.object({ type: z.literal('auto'), disable_parallel_tool_use: z.boolean().optional() }),
  z.object({ type: z.literal('any'), disable_parallel_tool_use: z.boolean().optional() }),
  z.object({ type: z.literal('tool'), name: z.string().min(1).max(128), disable_parallel_tool_use: z.boolean().optional() }),
]);

export const anthropicBodySchema = z.object({
  model: z.string().min(1).max(160),
  messages: z.array(anthropicMessageSchema).min(1).max(512),
  max_tokens: z.number().int().min(1).max(131_072).optional(),
  system: z.union([z.string().max(200_000), z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).max(64)]).optional(),
  temperature: z.number().min(0).max(1).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().min(0).max(2048).optional(),
  stop_sequences: z.array(z.string().max(500)).max(16).optional(),
  stream: z.boolean().optional().default(false),
  tools: z.array(anthropicToolSchema).max(128).optional(),
  tool_choice: anthropicToolChoiceSchema.optional(),
  metadata: z.object({ user_id: z.string().max(256).optional() }).optional(),
  thinking: z
    .object({ type: z.enum(['enabled', 'disabled']), budget_tokens: z.number().int().optional() })
    .optional(),
});

export type AnthropicBody = z.infer<typeof anthropicBodySchema>;
export type AnthropicContentBlock = z.infer<typeof anthropicContentBlockSchema>;

// ─── Request translation: Anthropic → provider (OpenAI-style) ────────────────

export class ProtocolTranslationError extends Error {
  status: number;
  type: AnthropicErrorType;
  constructor(message: string, status = 400, type: AnthropicErrorType = 'invalid_request_error') {
    super(message);
    this.name = 'ProtocolTranslationError';
    this.status = status;
    this.type = type;
  }
}

type RawBlock = AnthropicContentBlock;

function joinText(blocks: RawBlock[]): string {
  return blocks
    .filter((b): b is Extract<RawBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function toolResultToText(block: Extract<RawBlock, { type: 'tool_result' }>): string {
  let text: string;
  if (typeof block.content === 'string') {
    text = block.content;
  } else if (Array.isArray(block.content)) {
    const parts = block.content.map((p) => {
      if (typeof (p as { text?: unknown }).text === 'string') return (p as { text: string }).text;
      if ((p as { type?: string }).type === 'image') {
        throw new ProtocolTranslationError(
          'Images inside tool_result blocks are not supported by the underlying provider. Return tool results as text.',
          400
        );
      }
      return '';
    });
    text = parts.filter(Boolean).join('\n');
  } else {
    text = '';
  }
  if (block.is_error) {
    text = text.length > 0 ? `[tool error] ${text}` : '[tool error]';
  }
  // The provider expects tool content as a string (JSON or plain text).
  return text.length > 0 ? text : '(empty tool result)';
}

function imageSourceToPart(block: Extract<RawBlock, { type: 'image' }>): ProviderContentPart {
  const source = block.source;
  if (source.type === 'url') {
    return { type: 'image_url', image_url: { url: source.url } };
  }
  // Anthropic base64 image → OpenAI-style data URI
  const mediaType = source.media_type || 'image/png';
  return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${source.data}` } };
}

function documentToText(block: Extract<RawBlock, { type: 'document' }>): string {
  const source = block.source as { type?: string; content?: string; media_type?: string } | undefined;
  if (source?.type === 'text' && typeof source.content === 'string') {
    return source.content;
  }
  throw new ProtocolTranslationError(
    'PDF document blocks are not supported by the underlying provider. Send document text inline or use a vision model with images.',
    400
  );
}

/**
 * Translates one Anthropic message (string or block array) into one or more
 * provider messages. Tool results become individual `tool` messages; text and
 * images stay in `user`/`assistant` messages; thinking blocks are accepted
 * and dropped (the provider does not replay reasoning in history).
 */
function translateMessage(msg: z.infer<typeof anthropicMessageSchema>): ProviderMessage[] {
  if (typeof msg.content === 'string') {
    return [{ role: msg.role, content: msg.content }];
  }
  const blocks = msg.content;

  if (msg.role === 'assistant') {
    const text = joinText(blocks);
    const toolUses = blocks.filter((b): b is Extract<RawBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    if (toolUses.length > 0) {
      const toolCalls: ProviderToolCall[] = toolUses.map((u) => ({
        id: u.id,
        type: 'function',
        function: {
          name: u.name,
          arguments: JSON.stringify(u.input ?? {}),
        },
      }));
      return [{ role: 'assistant', content: text, tool_calls: toolCalls }];
    }
    return [{ role: 'assistant', content: text }];
  }

  // user message: tool_result blocks must be answered first, then any text /
  // image content follows as a regular user message (ordering preserved).
  const out: ProviderMessage[] = [];
  for (const block of blocks) {
    if (block.type === 'tool_result') {
      out.push({ role: 'tool', content: toolResultToText(block), tool_call_id: block.tool_use_id });
    }
  }
  const rest = blocks.filter((b) => b.type !== 'tool_result');
  if (rest.length > 0) {
    const hasImages = rest.some((b) => b.type === 'image');
    if (hasImages) {
      const parts: ProviderContentPart[] = rest.map((b) => {
        if (b.type === 'text') return { type: 'text' as const, text: b.text };
        if (b.type === 'image') return imageSourceToPart(b);
        if (b.type === 'document') return { type: 'text' as const, text: documentToText(b) };
        // thinking blocks in user history are dropped
        return null;
      });
      const compact = parts.filter((p): p is ProviderContentPart => p !== null);
      if (compact.length > 0) out.push({ role: 'user', content: compact });
    } else {
      const texts = rest
        .map((b) => {
          if (b.type === 'text') return b.text;
          if (b.type === 'document') return documentToText(b);
          return null;
        })
        .filter((t): t is string => t !== null);
      if (texts.length > 0) out.push({ role: 'user', content: texts.join('\n') });
    }
  }
  return out;
}

function translateSystem(system: AnthropicBody['system']): string | null {
  if (system === undefined) return null;
  if (typeof system === 'string') return system.length > 0 ? system : null;
  const texts = system
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean);
  return texts.length > 0 ? texts.join('\n\n') : null;
}

function translateTools(tools: AnthropicBody['tools']): ProviderTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.input_schema ?? { type: 'object', properties: {} },
    },
  }));
}

function translateToolChoice(choice: AnthropicBody['tool_choice']): unknown {
  if (!choice) return undefined;
  switch (choice.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'tool':
      return { type: 'function', function: { name: choice.name } };
  }
}

export type TranslatedRequest = {
  messages: ProviderMessage[];
  tools: ProviderTool[] | undefined;
  toolChoice: unknown;
  maxTokens: number;
  temperature: number | undefined;
  topP: number | undefined;
  topK: number | undefined;
  stop: string[] | undefined;
  thinkingEnabled: boolean;
};

/** Full request translation, applying EmorAI model limits. */
export function anthropicToProvider(
  body: AnthropicBody,
  opts: { defaultMaxTokens: number; modelMaxOutputTokens: number | null }
): TranslatedRequest {
  if (body.messages.length === 0) {
    throw new ProtocolTranslationError('messages: at least one message is required.');
  }
  const first = body.messages[0];
  if (first.role !== 'user') {
    throw new ProtocolTranslationError('messages: first message must have role "user" (Anthropic protocol).');
  }

  const providerMessages: ProviderMessage[] = [];
  const system = translateSystem(body.system);
  if (system) providerMessages.push({ role: 'system', content: system });
  for (const msg of body.messages) {
    providerMessages.push(...translateMessage(msg));
  }

  // Anthropic marks max_tokens optional in newer drafts but the classic API
  // requires it; we default to the model limit (friendlier than erroring).
  const requestedMax = body.max_tokens ?? opts.defaultMaxTokens;
  const maxTokens = Math.min(requestedMax, opts.modelMaxOutputTokens ?? requestedMax);

  return {
    messages: providerMessages,
    tools: translateTools(body.tools),
    toolChoice: translateToolChoice(body.tool_choice),
    maxTokens,
    temperature: body.temperature,
    topP: body.top_p,
    topK: body.top_k,
    stop: body.stop_sequences && body.stop_sequences.length > 0 ? body.stop_sequences : undefined,
    thinkingEnabled: body.thinking?.type === 'enabled',
  };
}

// ─── Token estimation ────────────────────────────────────────────────────────

export function estimateInputTokens(messages: ProviderMessage[], system?: string | null): number {
  let chars = system?.length ?? 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const p of m.content) chars += p.text?.length ?? 0;
    }
    if (m.tool_calls) {
      for (const tc of m.tool_calls) chars += tc.function.arguments.length + tc.function.name.length;
    }
  }
  return Math.max(1, Math.ceil(chars / 4));
}

// ─── Response translation: provider → Anthropic ──────────────────────────────

export type AnthropicStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal';

export function toAnthropicStopReason(reason: string | null): AnthropicStopReason {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
    case 'max_tokens':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

export type AnthropicContentOut =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

function safeParseArguments(args: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args || '{}');
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    // Malformed arguments from the provider — surface raw text honestly.
    return { _raw: args };
  }
}

/** Builds the non-streaming Anthropic message response. */
export function buildAnthropicMessage(params: {
  id: string;
  requestedModel: string;
  servedModel: string | null;
  content: string;
  toolCalls: ProviderToolCall[];
  finishReason: string | null;
  usage: TokenUsage | null;
}): Record<string, unknown> {
  const content: AnthropicContentOut[] = [];
  if (params.content && params.content.length > 0) {
    content.push({ type: 'text', text: params.content });
  }
  for (const tc of params.toolCalls) {
    content.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.function.name,
      input: safeParseArguments(tc.function.arguments),
    });
  }
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }
  return {
    id: params.id,
    type: 'message',
    role: 'assistant',
    model: params.requestedModel,
    content,
    stop_reason: toAnthropicStopReason(params.finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: params.usage?.promptTokens ?? 0,
      output_tokens: params.usage?.completionTokens ?? 0,
    },
    // EmorAI transparency extension (ignored by Anthropic SDKs)
    emorai_served_model: params.servedModel ?? params.requestedModel,
  };
}

// ─── Streaming translation: provider events → Anthropic SSE frames ───────────

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

type OpenBlock =
  | { kind: 'text'; index: number }
  | { kind: 'tool_use'; index: number; id: string; name: string };

/**
 * Stateful translator that consumes normalized provider stream events and
 * produces the Anthropic SSE event sequence. Faithful to the protocol:
 *   message_start → ping → (content_block_start → deltas → content_block_stop)*
 *   → message_delta(stop_reason, usage) → message_stop
 * Tool-call arguments stream as input_json_delta chunks.
 */
export class AnthropicStreamTranslator {
  private readonly messageId: string;
  private readonly requestedModel: string;
  private blockCount = 0;
  private open: OpenBlock | null = null;
  private outputChars = 0;
  private usage: TokenUsage | null = null;
  private inputTokens: number;
  private closed = false;

  constructor(params: { messageId: string; requestedModel: string; estimatedInputTokens: number }) {
    this.messageId = params.messageId;
    this.requestedModel = params.requestedModel;
    this.inputTokens = params.estimatedInputTokens;
  }

  private nextIndex(): number {
    return this.blockCount++;
  }

  private closeOpenBlock(): string | null {
    if (!this.open) return null;
    const frame = sseFrame('content_block_stop', { type: 'content_block_stop', index: this.open.index });
    this.open = null;
    return frame;
  }

  /** Initial frames: message_start + ping. */
  start(): string {
    return (
      sseFrame('message_start', {
        type: 'message_start',
        message: {
          id: this.messageId,
          type: 'message',
          role: 'assistant',
          model: this.requestedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: this.inputTokens, output_tokens: 1 },
        },
      }) + sseFrame('ping', { type: 'ping' })
    );
  }

  /** Feed one normalized provider event; returns SSE frames to write. */
  onEvent(ev: StreamEvent): string {
    if (this.closed) return '';
    switch (ev.type) {
      case 'delta': {
        this.outputChars += ev.content.length;
        if (!this.open || this.open.kind !== 'text') {
          const closeFrame = this.closeOpenBlock();
          const index = this.nextIndex();
          this.open = { kind: 'text', index };
          const startFrame = sseFrame('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'text', text: '' },
          });
          return (
            (closeFrame ?? '') +
            startFrame +
            sseFrame('content_block_delta', {
              type: 'content_block_delta',
              index,
              delta: { type: 'text_delta', text: ev.content },
            })
          );
        }
        return sseFrame('content_block_delta', {
          type: 'content_block_delta',
          index: this.open.index,
          delta: { type: 'text_delta', text: ev.content },
        });
      }
      case 'reasoning': {
        // GLM reasoning trace: Anthropic surfaces extended thinking as
        // thinking blocks. We stream them as thinking blocks (signature is
        // empty; clients tolerate unsigned thinking on custom gateways).
        if (!this.open || this.open.kind !== 'text') {
          // reasoning arrives before text typically — open a thinking block
          // only if nothing is open; otherwise ignore (kept simple & robust).
          if (this.open) return '';
          const index = this.nextIndex();
          this.open = { kind: 'text', index };
          // Represent reasoning as a thinking-typed content block
          return (
            sseFrame('content_block_start', {
              type: 'content_block_start',
              index,
              content_block: { type: 'thinking', thinking: '', signature: '' },
            }) +
            sseFrame('content_block_delta', {
              type: 'content_block_delta',
              index,
              delta: { type: 'thinking_delta', thinking: ev.content },
            })
          );
        }
        return '';
      }
      case 'tool-call-delta': {
        return this.onToolCallDelta(ev.call);
      }
      case 'served-model': {
        // No Anthropic frame for this; recorded by the caller.
        return '';
      }
      case 'usage': {
        this.usage = ev.usage;
        return '';
      }
      case 'finish': {
        // handled in finish(); nothing to emit now
        return '';
      }
    }
  }

  private onToolCallDelta(call: ToolCallDelta): string {
    let frames = '';
    const sameToolOpen =
      this.open && this.open.kind === 'tool_use' && this.open.id === (call.id ?? this.open.id);
    if (!sameToolOpen) {
      frames += this.closeOpenBlock() ?? '';
      const index = this.nextIndex();
      const id = call.id ?? `toolu_${Math.random().toString(36).slice(2, 12)}`;
      const name = call.name ?? '';
      this.open = { kind: 'tool_use', index, id, name };
      frames += sseFrame('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id, name, input: {} },
      });
    }
    if (call.argumentsDelta && call.argumentsDelta.length > 0) {
      this.outputChars += call.argumentsDelta.length;
      frames += sseFrame('content_block_delta', {
        type: 'content_block_delta',
        index: this.open!.index,
        delta: { type: 'input_json_delta', partial_json: call.argumentsDelta },
      });
    }
    return frames;
  }

  /** Terminal frames: close block, message_delta with stop_reason + usage, message_stop. */
  finish(finishReason: string | null): string {
    if (this.closed) return '';
    this.closed = true;
    const closeFrame = this.closeOpenBlock() ?? '';
    const stopReason = toAnthropicStopReason(finishReason);
    const outputTokens =
      this.usage?.completionTokens ?? Math.max(1, Math.ceil(this.outputChars / 4));
    if (this.usage) this.inputTokens = this.usage.promptTokens;
    return (
      closeFrame +
      sseFrame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      }) +
      sseFrame('message_stop', { type: 'message_stop' })
    );
  }

  /** Mid-stream error frame (Anthropic error event). */
  errorFrame(type: AnthropicErrorType, message: string): string {
    this.closed = true;
    return sseFrame('error', { type: 'error', error: { type, message } });
  }

  get finalUsage(): TokenUsage | null {
    return this.usage;
  }
}

// ─── Scope helpers (Anthropic view) ──────────────────────────────────────────

export function anthropicScopeFailure(key: AuthenticatedKey, scope: string): Response | null {
  if (key.scopes.includes(scope)) return null;
  return anthropicError(
    403,
    'permission_error',
    `This API key is not permitted to use "${scope}". Edit the key's permissions in the EmorAI dashboard.`
  );
}

export function anthropicModelAllowFailure(key: AuthenticatedKey, modelId: string): Response | null {
  if (!key.allowedModels) return null;
  const allowed = key.allowedModels.some((m) => m.toLowerCase() === modelId.toLowerCase());
  if (allowed) return null;
  return anthropicError(
    403,
    'permission_error',
    `Model "${modelId}" is not on this key's allowed-models list. Allowed: ${key.allowedModels.join(', ')}.`
  );
}
