import { authenticateV1 } from '@/lib/api/auth';
import { resolveModel } from '@/lib/model-registry';
import { corsPreflight, corsJson } from '@/lib/api/cors';
import { openAiAuthFailure, openAiError } from '@/lib/api/protocol/openai';

export const runtime = 'nodejs';

/** OpenAI-compatible model retrieval: GET /api/v1/models/{model}. */
export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateV1(req);
  if (!auth.ok) return openAiAuthFailure(auth.error);

  const { id } = await params;
  const resolved = await resolveModel(id);
  if (!resolved || !resolved.model.enabled) {
    return openAiError(404, 'model_not_found', `Model "${id}" does not exist in this EmorAI installation.`);
  }
  const m = resolved.model;
  return corsJson({
    id: m.modelId,
    object: 'model',
    created: 1_700_000_000,
    owned_by: m.provider,
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
  });
}
