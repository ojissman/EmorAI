import { z } from 'zod';
import { db } from '@/lib/db';
import type { AppSettings } from '@/lib/types';

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
};

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
});

export const settingsPatchSchema = settingsSchema.partial();

const SETTINGS_KEY = 'app';

export async function getSettings(): Promise<AppSettings> {
  const row = await db.appSetting.findUnique({ where: { key: SETTINGS_KEY } });
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(row.value) as Partial<AppSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const next = { ...current, ...patch };
  const validated = settingsSchema.parse(next);
  await db.appSetting.upsert({
    where: { key: SETTINGS_KEY },
    update: { value: JSON.stringify(validated) },
    create: { key: SETTINGS_KEY, value: JSON.stringify(validated) },
  });
  return validated;
}
