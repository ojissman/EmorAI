"use client";

// Shared display helpers for the Providers and Routing settings tabs.
// Kept next to the dialogs that use it — same pattern as studio-shared.tsx.

const PROVIDER_TYPE_LABELS: Record<string, string> = {
  zai: 'Z.ai',
  openai: 'OpenAI-compatible',
  anthropic: 'Anthropic-compatible',
  'self-hosted': 'Self-hosted',
};

/** Human label for an adapter key; unknown adapters fall back to the raw key. */
export function providerTypeLabel(type: string): string {
  return PROVIDER_TYPE_LABELS[type] ?? type;
}

/** Compact relative time ("3h ago") for ISO timestamps; '' for null/invalid. */
export function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diff = Math.max(0, Date.now() - then);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
