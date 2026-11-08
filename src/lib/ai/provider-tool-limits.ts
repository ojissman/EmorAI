// ─────────────────────────────────────────────────────────────────────────────
// Provider tool normalization — makes coding-agent toolsets provider-safe.
//
// Z.ai (GLM) request validation enforces hard limits on function tools:
//   * tools[i].function.description  ≤ 2048 characters
//   * tools[i].function.name          ~ ^[a-zA-Z0-9_-]{1,64}$
//
// Coding agents (ZCode, Claude Code, OpenClaw…) routinely ship tool
// descriptions far longer than 2048 chars, and occasional exotic names.
// The EmorAI gateway accepts the full OpenAI/Anthropic-compatible payload
// (their real APIs impose no such tight description limit), then normalizes
// tools right before they are forwarded upstream so the provider never
// rejects an otherwise valid request.
//
// Renamed tools are transparent: a bidirectional map restores the caller's
// original names in tool-call responses and translates tool_choice names in
// requests, so the agent never sees the sanitized identifiers.
// ─────────────────────────────────────────────────────────────────────────────

import type { ProviderTool } from '@/lib/types';

export const PROVIDER_TOOL_DESC_MAX = 2048;
export const PROVIDER_TOOL_NAME_MAX = 64;

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export type SanitizedTools = {
  /** Normalized tools — safe to send to the provider. */
  tools: ProviderTool[];
  /** sanitized name → original name (response translation). */
  bySanitized: Map<string, string>;
  /** original name → sanitized name (request-side tool_choice translation). */
  byOriginal: Map<string, string>;
};

/** Clamp a string to the provider limit, flagging the truncation. */
function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  // Agents front-load semantics — keep the head, mark the cut.
  return `${text.slice(0, max - 1)}…`;
}

/**
 * Deep-clamps every `description` string inside a JSON Schema so oversized
 * property docs cannot trip the same upstream validation. Only informational
 * `description` values are touched — types, enums and structure are preserved.
 */
function clampSchemaDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clampSchemaDescriptions);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = k === 'description' && typeof v === 'string'
        ? clampText(v, PROVIDER_TOOL_DESC_MAX)
        : clampSchemaDescriptions(v);
    }
    return out;
  }
  return value;
}

/** Builds a provider-safe, collision-free name for an offending tool name. */
function safeName(original: string, taken: Set<string>): string {
  let base = original.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, PROVIDER_TOOL_NAME_MAX);
  if (!base) base = 'tool';
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) {
    const suffix = `_${n}`;
    candidate = base.slice(0, PROVIDER_TOOL_NAME_MAX - suffix.length) + suffix;
    n += 1;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * Normalizes a tool list for the Z.ai provider:
 *   1. clamps tool-level descriptions to 2048 chars
 *   2. deep-clamps `description` strings inside the parameters schema
 *   3. remaps names that violate the provider name pattern (or collide),
 *      returning the maps needed for transparent round-trip translation
 */
export function sanitizeToolsForProvider(tools: ProviderTool[]): SanitizedTools {
  const bySanitized = new Map<string, string>();
  const byOriginal = new Map<string, string>();
  const taken = new Set<string>();

  const sanitized = tools.map((tool) => {
    const originalName = tool.function.name;
    const nameOk = NAME_PATTERN.test(originalName) && originalName.length <= PROVIDER_TOOL_NAME_MAX;
    // Valid, unseen names pass through untouched; anything else is remapped
    // (this also de-duplicates exact duplicate names defensively).
    const name = nameOk && !taken.has(originalName)
      ? (taken.add(originalName), originalName)
      : (() => {
          const renamed = safeName(originalName, taken);
          bySanitized.set(renamed, originalName);
          byOriginal.set(originalName, renamed);
          return renamed;
        })();

    return {
      type: 'function' as const,
      function: {
        name,
        description: clampText(tool.function.description ?? '', PROVIDER_TOOL_DESC_MAX),
        parameters: (clampSchemaDescriptions(tool.function.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>),
      },
    };
  });

  return { tools: sanitized, bySanitized, byOriginal };
}

/**
 * Translates a tool_choice value (OpenAI/Anthropic-style object or enum) from
 * the caller's original tool names to the sanitized names actually sent
 * upstream. Enum values ("auto" | "none" | "required") pass through.
 */
export function translateToolChoiceName(toolChoice: unknown, byOriginal: Map<string, string>): unknown {
  if (!toolChoice || typeof toolChoice !== 'object' || byOriginal.size === 0) return toolChoice;
  const tc = toolChoice as { type?: unknown; function?: { name?: unknown } };
  if (tc.function && typeof tc.function.name === 'string') {
    const mapped = byOriginal.get(tc.function.name);
    if (mapped) return { ...tc, function: { ...tc.function, name: mapped } };
  }
  return toolChoice;
}
