import { authenticateV1 } from '@/lib/api/auth';
import { listEnabledModels } from '@/lib/model-registry';
import { corsPreflight, corsJson } from '@/lib/api/cors';
import { openAiAuthFailure } from '@/lib/api/protocol/openai';

export const runtime = 'nodejs';

/** OpenAI-compatible model listing for API consumers. */
export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(req: Request) {
  const auth = await authenticateV1(req);
  if (!auth.ok) return openAiAuthFailure(auth.error);
  if (!auth.key.scopes.includes('models')) {
    // Model listing is metadata; require the "models" scope (default-on).
    return openAiAuthFailure({
      status: 403,
      code: 'insufficient_scope',
      message: 'This API key is not permitted to list models.',
      anthropicType: 'permission_error',
      openaiType: 'permission_error',
    });
  }

  const models = await listEnabledModels();
  return corsJson({
    object: 'list',
    data: models.map((m) => ({
      id: m.modelId,
      object: 'model',
      created: 1_700_000_000,
      owned_by: m.provider,
      // EmorAI registry metadata (ignored by OpenAI SDKs, useful to agents)
      display_name: m.displayName,
      description: m.description,
      context_window: m.contextWindow,
      max_output_tokens: m.maxOutputTokens,
      aliases: m.aliases,
      streaming: m.streamSupported,
      capabilities: m.capabilities,
      free_tier: m.freeTier,
      last_status: m.lastStatus,
      last_served_model: m.lastServedModel,
    })),
  });
}
