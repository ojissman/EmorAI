import { authenticateV1 } from '@/lib/api/auth';
import { listEnabledModels } from '@/lib/model-registry';

export const runtime = 'nodejs';

/** OpenAI-compatible model listing for API consumers. */
export async function GET(req: Request) {
  const auth = await authenticateV1(req);
  if (!auth.ok) return auth.response;

  const models = await listEnabledModels();
  const created = Math.floor(Date.now() / 1000);
  return Response.json({
    object: 'list',
    data: models.map((m) => ({
      id: m.modelId,
      object: 'model',
      created,
      owned_by: m.provider,
      display_name: m.displayName,
      description: m.description,
      capabilities: m.capabilities,
      free_tier: m.freeTier,
      last_status: m.lastStatus,
      last_served_model: m.lastServedModel,
    })),
  });
}
