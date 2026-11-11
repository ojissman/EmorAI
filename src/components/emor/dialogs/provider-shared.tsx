"use client";

// Shared display helpers for the Providers and Routing settings tabs.
// Kept next to the dialogs that use it — same pattern as studio-shared.tsx.

import type { ModelCapabilities } from '@/lib/types';

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

// ─── Provider discovery (POST /api/providers/[id]/discover) ──────────────────

/** One upstream model reported by the provider's listing API (dry-run shape). */
export type DiscoveredModel = {
  modelId: string;
  displayName: string | null;
  contextWindow: number | null;
  ownedBy: string | null;
  alreadyCatalogued: boolean;
};

/** Execution route auto-created (or found) for an adopted model. */
export type DiscoveredRoute = {
  modelId: string;
  routeId: string;
  providerAccountId: string;
  upstreamModelId: string;
  created: boolean;
  enabled: boolean;
};

/** Full discover response — identical for dry runs and adoption calls. */
export type DiscoveryResponse = {
  discovered: DiscoveredModel[];
  adopted: string[];
  routes: DiscoveredRoute[];
  note: string;
};

/** Admin-editable adoption fields for one discovered model. */
export type AdoptionDraft = {
  displayName: string;
  freeTier: boolean;
  capabilities: ModelCapabilities;
  contextWindow: string;
};

/** Neutral adoption draft seeded from a discovered model's metadata. */
export function adoptionDraftFor(m: DiscoveredModel): AdoptionDraft {
  return {
    displayName: m.displayName ?? m.modelId,
    freeTier: false,
    capabilities: {
      chat: true,
      reasoning: false,
      vision: false,
      files: false,
      webSearch: false,
      tools: false,
      json: false,
    },
    contextWindow: m.contextWindow != null ? String(m.contextWindow) : '',
  };
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
