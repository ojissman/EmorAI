import { z } from 'zod';
import { db } from '@/lib/db';
import type { AppSettings, RoutingStrategyName } from '@/lib/types';
import { ROUTING_STRATEGIES } from '@/lib/types';

export const DEFAULT_SETTINGS: AppSettings = {
  defaultModelId: 'glm-5.3-flash',
  systemInstructions: '',
  temperature: 0.7,
  maxTokens: 4096,
  streamEnabled: true,
  contextMessageLimit: 24,
  apiRateLimitPerMin: 60,
  dashboardRateLimitPerMin: 30,
  titleGeneration: true,
  routingStrategy: 'balanced',
  network: {
    // empty by default: private/loopback/link-local/metadata destinations are
    // rejected unless an administrator explicitly allowlists them here
    allowlist: [],
    requireHttps: true,
    maxResponseBytes: 32 * 1024 * 1024,
  },
  concurrency: { mode: 'queue', queueWaitMs: 30_000 },
  budget: { enforce: true },
  jobs: { healthCheckMin: 15, modelSyncHrs: 6 },
};

const networkSettingsSchema = z.object({
  allowlist: z.array(z.string().min(1).max(253)).max(256),
  requireHttps: z.boolean(),
  maxResponseBytes: z.number().int().min(64 * 1024).max(512 * 1024 * 1024),
});

const concurrencySettingsSchema = z.object({
  mode: z.enum(['queue', 'reject']),
  queueWaitMs: z.number().int().min(100).max(600_000),
});

const budgetSettingsSchema = z.object({ enforce: z.boolean() });

const jobsSettingsSchema = z.object({
  healthCheckMin: z.number().int().min(1).max(1440),
  modelSyncHrs: z.number().int().min(1).max(168),
});

export const settingsSchema = z.object({
  defaultModelId: z.string().min(1).max(120),
  systemInstructions: z.string().max(8000),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(64).max(32768),
  streamEnabled: z.boolean(),
  contextMessageLimit: z.number().int().min(2).max(200),
  apiRateLimitPerMin: z.number().int().min(1).max(10000),
  dashboardRateLimitPerMin: z.number().int().min(1).max(1000),
  titleGeneration: z.boolean(),
  routingStrategy: z.enum(ROUTING_STRATEGIES as [RoutingStrategyName, ...RoutingStrategyName[]]),
  network: networkSettingsSchema,
  concurrency: concurrencySettingsSchema,
  budget: budgetSettingsSchema,
  jobs: jobsSettingsSchema,
});

export const settingsPatchSchema = settingsSchema.partial();

const SETTINGS_KEY = 'app';

export async function getSettings(): Promise<AppSettings> {
  const row = await db.appSetting.findUnique({ where: { key: SETTINGS_KEY } });
  if (!row) return structuredDefaults();
  try {
    const parsed = JSON.parse(row.value) as Partial<AppSettings>;
    // deep-merge nested config blocks so pre-Phase-10 stored settings keep working
    return {
      ...structuredDefaults(),
      ...parsed,
      network: { ...structuredDefaults().network, ...(parsed.network ?? {}) },
      concurrency: { ...structuredDefaults().concurrency, ...(parsed.concurrency ?? {}) },
      budget: { ...structuredDefaults().budget, ...(parsed.budget ?? {}) },
      jobs: { ...structuredDefaults().jobs, ...(parsed.jobs ?? {}) },
    };
  } catch {
    return structuredDefaults();
  }
}

/** Defaults re-created per call (arrays must never be shared/leaked mutable). */
function structuredDefaults(): AppSettings {
  return { ...DEFAULT_SETTINGS, network: { ...DEFAULT_SETTINGS.network }, concurrency: { ...DEFAULT_SETTINGS.concurrency }, budget: { ...DEFAULT_SETTINGS.budget }, jobs: { ...DEFAULT_SETTINGS.jobs } };
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  // deep-merge nested blocks: a patch of `budget` alone must not drop `network`
  const next: AppSettings = {
    ...current,
    ...patch,
    network: { ...current.network, ...(patch.network ?? {}) },
    concurrency: { ...current.concurrency, ...(patch.concurrency ?? {}) },
    budget: { ...current.budget, ...(patch.budget ?? {}) },
    jobs: { ...current.jobs, ...(patch.jobs ?? {}) },
  };
  const validated = settingsSchema.parse(next);
  await db.appSetting.upsert({
    where: { key: SETTINGS_KEY },
    update: { value: JSON.stringify(validated) },
    create: { key: SETTINGS_KEY, value: JSON.stringify(validated) },
  });
  return validated;
}
