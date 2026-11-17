// ─── Client thinking / reasoning-effort vocabulary → boolean ─────────────────
//
// Real-world clients send wildly different "make the model think" controls:
//
//   • Anthropic classic: thinking.type = "enabled" | "disabled" (+budget_tokens)
//   • ZCode / Claude-Code-style tooling: thinking.type = "low" | "medium" |
//     "high" | "max" (effort levels — the model config exposes these)
//   • OpenAI-style: reasoning_effort = "minimal" | "low" | "medium" | "high"
//
// EmorAI used to hard-reject anything but enabled|disabled, which produced
// `Invalid request: thinking.type — Invalid option: expected one of
// "enabled"|"disabled"` for perfectly reasonable clients (ZCode with EmorAI
// models configured at effort levels). The upstream only understands
// enabled|disabled, so everything maps onto that single boolean here —
// liberal in what we accept, honest in what we forward.

const ON_VALUES = new Set([
  'enabled', 'enable', 'on', 'true', 'yes',
  'auto', 'dynamic', 'default',
  // effort vocabulary — any explicit reasoning request turns thinking on
  'low', 'medium', 'high', 'max', 'minimal',
]);
const OFF_VALUES = new Set(['disabled', 'disable', 'off', 'none', 'false', 'no']);

/** Maps a client `thinking` object (any vocabulary) to the upstream boolean. */
export function mapThinkingToEnabled(
  raw: { type?: string | null; budget_tokens?: number | null } | null | undefined
): boolean {
  if (!raw) return false;
  const hasType = raw.type !== undefined && raw.type !== null && String(raw.type).trim() !== '';
  const hasBudget = typeof raw.budget_tokens === 'number' && raw.budget_tokens > 0;

  if (hasType) {
    const t = String(raw.type).trim().toLowerCase();
    if (OFF_VALUES.has(t)) return false;
    if (ON_VALUES.has(t)) return true;
    // Unknown vocabulary: fall back to the budget signal, else off.
    return hasBudget;
  }
  // No type — an explicit positive budget is an enable (Anthropic semantics).
  return hasBudget;
}

/** Maps an OpenAI-style `reasoning_effort` string to the upstream boolean. */
export function reasoningEffortToEnabled(effort: string | null | undefined): boolean {
  if (!effort) return false;
  const t = effort.trim().toLowerCase();
  if (OFF_VALUES.has(t)) return false;
  return ON_VALUES.has(t);
}
