import { getSettings, updateSettings, settingsPatchSchema } from '@/lib/settings';
import { listModels } from '@/lib/model-registry';
import { ok, fail } from '@/lib/api/response';

export const runtime = 'nodejs';

export async function GET() {
  const settings = await getSettings();
  return ok({ settings });
}

export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'bad_json', 'Request body must be valid JSON.');
  }
  const parsed = settingsPatchSchema.safeParse(body);
  if (!parsed.success) {
    return fail(400, 'invalid_settings', 'Invalid settings payload.', { details: parsed.error.flatten() });
  }
  if (parsed.data.defaultModelId) {
    const models = await listModels();
    const target = models.find((m) => m.modelId === parsed.data.defaultModelId);
    if (!target) return fail(400, 'unknown_model', `Model "${parsed.data.defaultModelId}" is not in the registry.`);
  }
  const settings = await updateSettings(parsed.data);
  return ok({ settings });
}
