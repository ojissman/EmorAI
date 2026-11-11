import { z } from 'zod';
import { listModels, createModelConfig } from '@/lib/model-registry';
import { ok, fail } from '@/lib/api/response';
import { requireAdmin } from '@/lib/api/admin-auth';
import { DEFAULT_CAPABILITIES, type ModelCapabilities } from '@/lib/types';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const models = await listModels();
  return ok({ models });
}

const capabilitiesSchema = z.object({
  chat: z.boolean(),
  reasoning: z.boolean(),
  vision: z.boolean(),
  files: z.boolean(),
  webSearch: z.boolean(),
  tools: z.boolean(),
  json: z.boolean(),
});

const createSchema = z.object({
  modelId: z.string().min(1).max(120).regex(/^[a-z0-9._-]+$/i, 'Model ID may contain letters, digits, dots, dashes and underscores.'),
  displayName: z.string().min(1).max(80),
  description: z.string().max(400).default(''),
  provider: z.string().min(1).max(40).default('zai'),
  freeTier: z.boolean().default(false),
  enabled: z.boolean().default(true),
  capabilities: capabilitiesSchema.default(DEFAULT_CAPABILITIES as ModelCapabilities),
  contextWindow: z.number().int().min(1024).max(2_000_000).nullish(),
  maxOutputTokens: z.number().int().min(64).max(262_144).nullish(),
  aliases: z.array(z.string().min(1).max(160)).max(32).default([]),
  streamSupported: z.boolean().default(true),
});

export async function POST(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'bad_json', 'Request body must be valid JSON.');
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return fail(400, 'invalid_request', 'Invalid model definition.', { details: parsed.error.flatten() });
  }
  const existing = await listModels();
  if (existing.some((m) => m.modelId === parsed.data.modelId)) {
    return fail(409, 'duplicate_model', `A model with ID "${parsed.data.modelId}" already exists.`);
  }
  const maxOrder = existing.reduce((max, m) => Math.max(max, m.sortOrder), 0);
  const model = await createModelConfig({ ...parsed.data, sortOrder: maxOrder + 1 });
  return ok({ model }, { status: 201 });
}
