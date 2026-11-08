// ─────────────────────────────────────────────────────────────────────────────
// Chat role normalization — "be liberal in what you accept".
//
// Strict wire protocols define narrow role enums (Anthropic messages only
// allow user|assistant; OpenAI adds system|tool|developer). Real-world
// clients — coding agents, mixed SDKs, gateways chaining gateways — routinely
// leak other roles into the messages array: system prompts as messages,
// OpenAI-style tool results inside Anthropic payloads, "developer"/"function"
// legacy roles, or capitalized variants. Rejecting them at the schema door
// breaks agents that would work perfectly fine once normalized.
//
// This module normalizes roles and enforces the upstream provider's message
// invariants (system only at the top, no consecutive same-role messages,
// no empty non-tool messages) in one place, shared by every protocol layer
// and the provider adapter.
// ─────────────────────────────────────────────────────────────────────────────

import type { ProviderContentPart, ProviderMessage } from '@/lib/types';

export type NormalizedChatRole = 'user' | 'assistant' | 'system' | 'tool';

/**
 * Maps whatever role string a client sent onto the four roles the provider
 * pipeline understands (case-insensitive). Unknown roles degrade to "user" —
 * the message content is still delivered verbatim, so nothing is lost.
 */
export function normalizeChatRole(raw: string): NormalizedChatRole {
  const r = raw.trim().toLowerCase();
  if (r === 'user') return 'user';
  if (r === 'assistant' || r === 'bot') return 'assistant';
  if (r === 'system' || r === 'developer' || r === 'instruction' || r === 'instructions') return 'system';
  if (r === 'tool' || r === 'function') return 'tool';
  return 'user';
}

function partsToText(parts: ProviderContentPart[]): string {
  return parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

function textToParts(text: string): ProviderContentPart[] {
  return text.length > 0 ? [{ type: 'text', text }] : [];
}

function toParts(content: string | ProviderContentPart[]): ProviderContentPart[] {
  return typeof content === 'string' ? textToParts(content) : content;
}

function isEmptyContent(m: ProviderMessage): boolean {
  if (m.tool_calls || m.tool_call_id) return false;
  if (typeof m.content === 'string') return m.content.trim().length === 0;
  return Array.isArray(m.content) && m.content.length === 0;
}

/**
 * Enforces the upstream provider's message invariants on a translated
 * provider message array:
 *   1. every `system` message is hoisted into a single leading system message
 *      (mid-conversation system content becomes part of the system prompt)
 *   2. consecutive user/user and assistant/assistant messages are merged
 *      (agents that emit them would otherwise risk upstream rejection)
 *   3. empty non-tool messages are dropped
 * Tool messages are left in place — they reference specific tool calls.
 * Idempotent: already-clean arrays pass through unchanged.
 */
export function finalizeProviderMessages(messages: ProviderMessage[]): ProviderMessage[] {
  const systemTexts: string[] = [];
  const rest: ProviderMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content : partsToText(m.content);
      if (text.trim().length > 0) systemTexts.push(text);
    } else {
      rest.push(m);
    }
  }

  const merged: ProviderMessage[] = [];
  for (const m of rest) {
    if (isEmptyContent(m)) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role && (m.role === 'user' || m.role === 'assistant')) {
      if (typeof prev.content === 'string' && typeof m.content === 'string') {
        prev.content = prev.content.length > 0 ? `${prev.content}\n${m.content}` : m.content;
      } else {
        prev.content = [...toParts(prev.content), ...toParts(m.content)];
      }
      if (m.tool_calls) prev.tool_calls = [...(prev.tool_calls ?? []), ...m.tool_calls];
      continue;
    }
    merged.push(m);
  }

  const system = systemTexts.length > 0 ? systemTexts.join('\n\n') : null;
  if (merged.length === 0) {
    return system ? [{ role: 'system', content: system }] : [];
  }
  return system ? [{ role: 'system', content: system }, ...merged] : merged;
}
