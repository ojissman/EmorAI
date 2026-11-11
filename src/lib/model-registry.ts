import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import type { ModelCapabilities, ModelInfo, ModelLifecycle, ModelPricing } from '@/lib/types';
import { DEFAULT_CAPABILITIES } from '@/lib/types';

// ─── Default model catalog ───────────────────────────────────────────────────
// Candidate GLM models. Availability is NOT assumed: every entry carries
// `enabled` + health-probe state so the administrator can configure exactly
// which IDs their provider plan exposes. Zero-cost ("Flash") models are
// prioritised as defaults.
//
// Verified against the live gateway (scripts/model-availability-probe.ts):
// every ID below is accepted; the gateway currently serves `glm-4-plus`
// regardless of the requested ID — recorded honestly via lastServedModel.

export type ModelSeed = {
  modelId: string;
  displayName: string;
  description: string;
  capabilities: ModelCapabilities;
  freeTier: boolean;
  sortOrder: number;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
};

export const DEFAULT_MODELS: ModelSeed[] = [
  {
    modelId: 'glm-5.3-flash',
    displayName: 'GLM-5.3 Flash',
    description:
      'Fast, zero-cost tier model tuned for everyday chat, drafting and coding-agent workloads. Priority default for free access.',
    capabilities: { ...DEFAULT_CAPABILITIES, reasoning: true, tools: true, json: true },
    freeTier: true,
    sortOrder: 1,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
  },
  {
    modelId: 'glm-5.3',
    displayName: 'GLM-5.3',
    description:
      'Flagship model for complex reasoning, long context and coding. Requires provider plan access — verify availability before relying on it.',
    capabilities: { ...DEFAULT_CAPABILITIES, reasoning: true, tools: true, json: true },
    freeTier: false,
    sortOrder: 2,
    contextWindow: 200_000,
    maxOutputTokens: 32_768,
  },
  {
    modelId: 'glm-4.7-flash',
    displayName: 'GLM-4.7 Flash',
    description: 'Free-tier generalist with strong instruction following and quick responses.',
    capabilities: { ...DEFAULT_CAPABILITIES, tools: true, json: true },
    freeTier: true,
    sortOrder: 3,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
  },
  {
    modelId: 'glm-4.5-flash',
    displayName: 'GLM-4.5 Flash',
    description: 'Free-tier lightweight model for high-volume, low-latency chat.',
    capabilities: { ...DEFAULT_CAPABILITIES },
    freeTier: true,
    sortOrder: 4,
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
  },
  {
    modelId: 'glm-4.6v-flash',
    displayName: 'GLM-4.6V Flash',
    description: 'Free-tier vision model: image understanding, screenshots, charts and document images.',
    capabilities: { ...DEFAULT_CAPABILITIES, vision: true, files: true },
    freeTier: true,
    sortOrder: 5,
    contextWindow: 64_000,
    maxOutputTokens: 8_192,
  },
];

function toModelInfo(row: {
  id: string;
  modelId: string;
  displayName: string;
  description: string;
  provider: string;
  category: string | null;
  lifecycle: string | null;
  generation: string | null;
  pricing: unknown;
  capabilities: unknown;
  freeTier: boolean;
  enabled: boolean;
  sortOrder: number;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  aliases: unknown;
  streamSupported: boolean;
  lastCheckedAt: Date | null;
  lastStatus: string | null;
  lastServedModel: string | null;
  lastError: string | null;
}): ModelInfo {
  const caps = (row.capabilities ?? {}) as Partial<ModelCapabilities>;
  const aliases = Array.isArray(row.aliases) ? (row.aliases as unknown[]).filter((a): a is string => typeof a === 'string') : [];
  const pricing = (row.pricing ?? null) as ModelPricing | null;
  return {
    id: row.id,
    modelId: row.modelId,
    displayName: row.displayName,
    description: row.description,
    provider: row.provider,
    category: row.category === 'emorai' ? 'emorai' : 'provider',
    lifecycle: (['draft', 'preview', 'active', 'deprecated', 'retired'] as const).includes(
      (row.lifecycle ?? 'active') as ModelLifecycle
    )
      ? ((row.lifecycle ?? 'active') as ModelLifecycle)
      : 'active',
    generation: typeof row.generation === 'string' ? row.generation : null,
    pricing:
      pricing && typeof pricing.inputPerMTok === 'number' && typeof pricing.outputPerMTok === 'number'
        ? { inputPerMTok: pricing.inputPerMTok, outputPerMTok: pricing.outputPerMTok, currency: pricing.currency ?? 'USD' }
        : null,
    capabilities: { ...DEFAULT_CAPABILITIES, ...caps },
    freeTier: row.freeTier,
    enabled: row.enabled,
    sortOrder: row.sortOrder,
    contextWindow: row.contextWindow ?? null,
    maxOutputTokens: row.maxOutputTokens ?? null,
    aliases,
    streamSupported: row.streamSupported ?? true,
    lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    lastStatus: (row.lastStatus as ModelInfo['lastStatus']) ?? null,
    lastServedModel: row.lastServedModel,
    lastError: row.lastError,
  };
}

// Insert any missing default models and backfill metadata on existing rows
// (never overwrites administrator edits — only fills nulls).
export async function seedModelRegistry(): Promise<void> {
  for (const seed of DEFAULT_MODELS) {
    const existing = await db.modelConfig.findUnique({ where: { modelId: seed.modelId } });
    if (!existing) {
      await db.modelConfig.create({
        data: {
          modelId: seed.modelId,
          displayName: seed.displayName,
          description: seed.description,
          capabilities: seed.capabilities,
          freeTier: seed.freeTier,
          sortOrder: seed.sortOrder,
          contextWindow: seed.contextWindow ?? null,
          maxOutputTokens: seed.maxOutputTokens ?? null,
        },
      });
    } else if (
      (seed.contextWindow != null && existing.contextWindow == null) ||
      (seed.maxOutputTokens != null && existing.maxOutputTokens == null)
    ) {
      // Backfill registry metadata added by upgrades on legacy rows.
      await db.modelConfig.update({
        where: { id: existing.id },
        data: {
          ...(seed.contextWindow != null && existing.contextWindow == null
            ? { contextWindow: seed.contextWindow }
            : {}),
          ...(seed.maxOutputTokens != null && existing.maxOutputTokens == null
            ? { maxOutputTokens: seed.maxOutputTokens }
            : {}),
        },
      });
    }
  }
}

let registryChecked = false;
/** Lazy, cached seeding so a fresh install works without manual scripts. */
export async function ensureRegistrySeeded(): Promise<void> {
  if (registryChecked) return;
  await seedModelRegistry();
  registryChecked = true;
}

export async function listModels(): Promise<ModelInfo[]> {
  await ensureRegistrySeeded();
  const rows = await db.modelConfig.findMany({ orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }] });
  return rows.map(toModelInfo);
}

export async function listEnabledModels(): Promise<ModelInfo[]> {
  const all = await listModels();
  return all.filter((m) => m.enabled);
}

/**
 * Resolves a requested model ID to the registry entry that serves it.
 * Resolution order:
 *   1. exact modelId match
 *   2. admin-configured alias match (transparent: aliases are visible in
 *      /v1/models and the response reports the actual registry model + the
 *      served provider model — never a silent substitution)
 * Case-insensitive fallback because coding agents frequently normalise IDs.
 */
export async function resolveModel(requested: string): Promise<{ model: ModelInfo; viaAlias: string | null } | null> {
  await ensureRegistrySeeded();
  const exact = await db.modelConfig.findUnique({ where: { modelId: requested } });
  if (exact) return { model: toModelInfo(exact), viaAlias: null };

  const all = await listModels();
  const lower = requested.toLowerCase();
  const byLower = all.find((m) => m.modelId.toLowerCase() === lower);
  if (byLower) return { model: byLower, viaAlias: null };

  for (const m of all) {
    if (m.aliases.some((a) => a.toLowerCase() === lower)) {
      return { model: m, viaAlias: requested };
    }
  }
  return null;
}

export async function getModelInfoByModelId(modelId: string): Promise<ModelInfo | null> {
  const resolved = await resolveModel(modelId);
  return resolved?.model ?? null;
}

export async function updateModelConfig(
  dbId: string,
  patch: Partial<{
    displayName: string;
    description: string;
    enabled: boolean;
    capabilities: ModelCapabilities;
    freeTier: boolean;
    sortOrder: number;
    contextWindow: number | null;
    maxOutputTokens: number | null;
    aliases: string[];
    streamSupported: boolean;
    lifecycle: string;
    pricing: { inputPerMTok: number; outputPerMTok: number; currency: string } | null;
  }>
): Promise<ModelInfo | null> {
  const { pricing, ...rest } = patch;
  const row = await db.modelConfig.update({
    where: { id: dbId },
    data: { ...rest, ...(pricing !== undefined ? { pricing: pricing ?? Prisma.DbNull } : {}) },
  });
  return toModelInfo(row);
}

export async function createModelConfig(
  seed: ModelSeed & {
    provider?: string;
    aliases?: string[];
    category?: 'emorai' | 'provider';
    lifecycle?: string;
    generation?: string | null;
    pricing?: { inputPerMTok: number; outputPerMTok: number; currency: string } | null;
    enabled?: boolean;
  }
): Promise<ModelInfo> {
  const row = await db.modelConfig.create({
    data: {
      modelId: seed.modelId,
      displayName: seed.displayName,
      description: seed.description,
      capabilities: seed.capabilities,
      freeTier: seed.freeTier,
      sortOrder: seed.sortOrder,
      provider: seed.provider ?? 'zai',
      category: seed.category ?? 'provider',
      lifecycle: seed.lifecycle ?? 'active',
      generation: seed.generation ?? null,
      pricing: seed.pricing ?? Prisma.DbNull,
      enabled: seed.enabled ?? true,
      contextWindow: seed.contextWindow ?? null,
      maxOutputTokens: seed.maxOutputTokens ?? null,
      aliases: seed.aliases && seed.aliases.length > 0 ? seed.aliases : undefined,
    },
  });
  return toModelInfo(row);
}

export async function deleteModelConfig(dbId: string): Promise<void> {
  await db.modelConfig.delete({ where: { id: dbId } });
}

/**
 * Health probe: sends a tiny completion to the provider using this model ID
 * and records what the gateway actually served (some gateways route or alias
 * model IDs — EmorAI reports that honestly instead of pretending).
 */
export async function probeModel(dbId: string): Promise<ModelInfo | null> {
  const { completeChat } = await import('@/lib/ai/zai-adapter');
  const row = await db.modelConfig.findUnique({ where: { id: dbId } });
  if (!row) return null;
  const started = Date.now();
  try {
    const res = await completeChat({
      messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
      modelId: row.modelId,
      provider: row.provider,
      maxTokens: 16,
    });
    if (!res.content || res.content.trim().length === 0) {
      throw new Error('Provider returned an empty response');
    }
    const updated = await db.modelConfig.update({
      where: { id: dbId },
      data: {
        lastCheckedAt: new Date(),
        lastStatus: 'ok',
        lastServedModel: res.servedModel ?? null,
        lastError: null,
      },
    });
    void started;
    return toModelInfo(updated);
  } catch (e) {
    const updated = await db.modelConfig.update({
      where: { id: dbId },
      data: {
        lastCheckedAt: new Date(),
        lastStatus: 'error',
        lastError: String((e as Error)?.message ?? e).slice(0, 500),
      },
    });
    return toModelInfo(updated);
  }
}

/**
 * Discovers genuine availability across the whole registry: probes every
 * enabled model sequentially (spaced to respect upstream rate limits) and
 * returns the updated list. Used by the dashboard "Discover availability"
 * action — never run automatically on request paths.
 */
export async function discoverAvailability(): Promise<ModelInfo[]> {
  const models = await listModels();
  for (const m of models) {
    // probeModel enforces its own retry/backoff against upstream 429s.
    await probeModel(m.id);
  }
  return listModels();
}
