import { db } from '@/lib/db';
import type { ModelCapabilities, ModelInfo } from '@/lib/types';
import { DEFAULT_CAPABILITIES } from '@/lib/types';

// ─── Default model catalog ───────────────────────────────────────────────────
// Candidate GLM models. Availability is NOT assumed: every entry carries
// `enabled` + health-probe state so the administrator can configure exactly
// which IDs their provider plan exposes. Zero-cost ("Flash") models are
// prioritised as defaults.

export type ModelSeed = {
  modelId: string;
  displayName: string;
  description: string;
  capabilities: ModelCapabilities;
  freeTier: boolean;
  sortOrder: number;
};

export const DEFAULT_MODELS: ModelSeed[] = [
  {
    modelId: 'glm-5.3-flash',
    displayName: 'GLM-5.3 Flash',
    description:
      'Fast, zero-cost tier model tuned for everyday chat and drafting. Priority default for free access.',
    capabilities: { ...DEFAULT_CAPABILITIES, reasoning: true, tools: true, json: true },
    freeTier: true,
    sortOrder: 1,
  },
  {
    modelId: 'glm-5.3',
    displayName: 'GLM-5.3',
    description:
      'Flagship model for complex reasoning, long context and coding. Requires provider plan access — verify availability before relying on it.',
    capabilities: { ...DEFAULT_CAPABILITIES, reasoning: true, tools: true, json: true },
    freeTier: false,
    sortOrder: 2,
  },
  {
    modelId: 'glm-4.7-flash',
    displayName: 'GLM-4.7 Flash',
    description: 'Free-tier generalist with strong instruction following and quick responses.',
    capabilities: { ...DEFAULT_CAPABILITIES, tools: true, json: true },
    freeTier: true,
    sortOrder: 3,
  },
  {
    modelId: 'glm-4.5-flash',
    displayName: 'GLM-4.5 Flash',
    description: 'Free-tier lightweight model for high-volume, low-latency chat.',
    capabilities: { ...DEFAULT_CAPABILITIES },
    freeTier: true,
    sortOrder: 4,
  },
  {
    modelId: 'glm-4.6v-flash',
    displayName: 'GLM-4.6V Flash',
    description: 'Free-tier vision model: image understanding, screenshots, charts and document images.',
    capabilities: { ...DEFAULT_CAPABILITIES, vision: true, files: true },
    freeTier: true,
    sortOrder: 5,
  },
];

function toModelInfo(row: {
  id: string;
  modelId: string;
  displayName: string;
  description: string;
  provider: string;
  capabilities: unknown;
  freeTier: boolean;
  enabled: boolean;
  sortOrder: number;
  lastCheckedAt: Date | null;
  lastStatus: string | null;
  lastServedModel: string | null;
  lastError: string | null;
}): ModelInfo {
  const caps = (row.capabilities ?? {}) as Partial<ModelCapabilities>;
  return {
    id: row.id,
    modelId: row.modelId,
    displayName: row.displayName,
    description: row.description,
    provider: row.provider,
    capabilities: { ...DEFAULT_CAPABILITIES, ...caps },
    freeTier: row.freeTier,
    enabled: row.enabled,
    sortOrder: row.sortOrder,
    lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    lastStatus: (row.lastStatus as ModelInfo['lastStatus']) ?? null,
    lastServedModel: row.lastServedModel,
    lastError: row.lastError,
  };
}

// Insert any missing default models. Never overwrites administrator edits.
export async function seedModelRegistry(): Promise<void> {
  for (const seed of DEFAULT_MODELS) {
    const existing = await db.modelConfig.findUnique({ where: { modelId: seed.modelId } });
    if (!existing) {
      await db.modelConfig.create({ data: { ...seed } });
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

export async function getModelInfoByModelId(modelId: string): Promise<ModelInfo | null> {
  await ensureRegistrySeeded();
  const row = await db.modelConfig.findUnique({ where: { modelId } });
  return row ? toModelInfo(row) : null;
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
  }>
): Promise<ModelInfo | null> {
  const row = await db.modelConfig.update({ where: { id: dbId }, data: patch });
  return toModelInfo(row);
}

export async function createModelConfig(seed: ModelSeed & { provider?: string }): Promise<ModelInfo> {
  const row = await db.modelConfig.create({ data: { ...seed, provider: seed.provider ?? 'zai' } });
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
