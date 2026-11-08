// ─────────────────────────────────────────────────────────────────────────────
// OpenAI-compatible wire protocol: shared request schemas, response shaping
// and error envelopes for every /v1/chat/completions-style endpoint.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import type { AuthFailure } from '@/lib/api/auth';
import { corsJson } from '@/lib/api/cors';

// ─── Error envelope ──────────────────────────────────────────────────────────

export type OpenAiErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'rate_limit_error'
  | 'api_error'
  | 'provider_error'
  | 'not_found_error';

export function openAiError(
  status: number,
  code: string,
  message: string,
  type: OpenAiErrorType = 'invalid_request_error',
  extra?: Record<string, unknown>,
  headers?: Record<string, string>
): Response {
  return corsJson(
    { error: { message, type, code, ...(extra ?? {}) } },
    { status, headers }
  );
}

/** Shapes a protocol-agnostic auth failure into the OpenAI envelope. */
export function openAiAuthFailure(failure: AuthFailure): Response {
  const headers: Record<string, string> = {};
  if (failure.retryAfterSec) headers['retry-after'] = String(failure.retryAfterSec);
  return openAiError(failure.status, failure.code, failure.message, failure.openaiType, undefined, headers);
}

// ─── Request schemas ─────────────────────────────────────────────────────────

export const contentPartSchema = z.object({
  type: z.enum(['text', 'image_url']),
  text: z.string().optional(),
  image_url: z.object({ url: z.string() }).optional(),
});

export const toolCallSchema = z.object({
  id: z.string().optional(),
  type: z.literal('function').optional(),
  function: z.object({
    name: z.string().min(1).max(128),
    arguments: z.string().optional(),
  }),
});

export const chatMessageSchema = z.object({
  // Liberal role acceptance: any role string is validated here and normalized
  // during translation (see lib/api/protocol/roles.ts). Covers system, user,
  // assistant, tool, developer, legacy function, and unknown-but-harmless
  // variants that real-world clients send.
  role: z.string().min(1).max(32),
  content: z.union([z.string().max(400_000), z.array(contentPartSchema).max(64), z.null()]),
  name: z.string().max(128).optional(),
  tool_calls: z.array(toolCallSchema).max(32).optional(),
  tool_call_id: z.string().max(128).optional(),
});

export const toolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1).max(128),
    // Coding agents (ZCode, Claude Code…) ship long descriptions. Accept what
    // the real OpenAI API accepts; the provider adapter clamps to the
    // upstream limit before forwarding.
    description: z.string().max(100_000).optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const toolChoiceSchema = z.union([
  z.enum(['auto', 'none', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({ name: z.string().min(1).max(128) }),
  }),
]);

export const chatCompletionsBodySchema = z.object({
  model: z.string().min(1).max(160),
  messages: z.array(chatMessageSchema).min(1).max(512),
  stream: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().min(1).max(131_072).optional(),
  max_completion_tokens: z.number().int().min(1).max(131_072).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop: z.union([z.string().max(500), z.array(z.string().max(500)).max(16)]).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  n: z.number().int().min(1).max(1).optional(), // only n=1 supported (honest)
  tools: z.array(toolSchema).max(128).optional(),
  tool_choice: toolChoiceSchema.optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
  user: z.string().max(256).optional(),
  // accepted-and-ignored optional params common in the wild
  response_format: z.unknown().optional(),
  logit_bias: z.unknown().optional(),
  logprobs: z.unknown().optional(),
  top_logprobs: z.unknown().optional(),
  seed: z.unknown().optional(),
});

export type ChatCompletionsBody = z.infer<typeof chatCompletionsBodySchema>;

// ─── Response shaping ────────────────────────────────────────────────────────

export function randomId(prefix: string): string {
  const rand = globalThis.crypto?.randomUUID?.() ?? `${Math.random()}${Date.now()}`;
  return `${prefix}-${rand.replace(/-/g, '').slice(0, 24)}`;
}

export function normalizeStop(stop?: string | string[]): string[] | undefined {
  if (stop === undefined) return undefined;
  return Array.isArray(stop) ? stop : [stop];
}

/** Map provider finish reasons to OpenAI finish_reason values. */
export function toOpenAiFinishReason(reason: string | null): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
  switch (reason) {
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}
