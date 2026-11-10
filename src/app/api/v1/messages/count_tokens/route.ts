import { authenticateV1 } from '@/lib/api/auth';
import { resolveModel, listEnabledModels } from '@/lib/model-registry';
import { corsPreflight, corsJson } from '@/lib/api/cors';
import { recordUsage, requestBodyPreview, modelGuessFromRaw } from '@/lib/usage';
import { randomId } from '@/lib/api/protocol/openai';
import {
  anthropicError,
  anthropicAuthFailure,
  anthropicBodySchema,
  estimateInputTokens,
  anthropicToProvider,
  ProtocolTranslationError,
} from '@/lib/api/protocol/anthropic';

export const runtime = 'nodejs';

const ENDPOINT = '/api/v1/messages/count_tokens';

export async function OPTIONS() {
  return corsPreflight();
}

/**
 * Anthropic count_tokens: Claude Code calls this before dispatching large
 * requests. We resolve the model, translate the payload (so the estimate
 * matches what would actually be sent upstream) and return a token estimate.
 */
export async function POST(req: Request) {
  const requestId = randomId('req');
  const authHeaders = { 'request-id': requestId };

  const auth = await authenticateV1(req);
  if (!auth.ok) return anthropicAuthFailure(auth.error);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return anthropicError(400, 'invalid_request_error', 'Request body must be valid JSON.', authHeaders);
  }
  // count_tokens accepts the same body shape as /v1/messages (stream ignored)
  const parsed = anthropicBodySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = `Invalid request: ${issue?.path.join('.') || 'body'} — ${issue?.message ?? 'malformed body'}`;
    void recordUsage({
      source: 'api',
      protocol: 'anthropic',
      endpoint: ENDPOINT,
      statusCode: 400,
      requestId,
      apiKeyId: auth.key.apiKeyId,
      modelId: modelGuessFromRaw(raw),
      success: false,
      errorText: `${message} | body: ${requestBodyPreview(raw)}`,
    }).catch(() => undefined);
    return anthropicError(400, 'invalid_request_error', message, authHeaders);
  }
  const body = parsed.data;

  const resolved = await resolveModel(body.model);
  if (!resolved) {
    const available = await listEnabledModels();
    return anthropicError(
      404,
      'not_found_error',
      `Model "${body.model}" does not exist in this EmorAI installation. Available models: ${available.map((m) => m.modelId).join(', ')}.`,
      authHeaders
    );
  }

  try {
    const translated = anthropicToProvider(body, {
      defaultMaxTokens: 4096,
      modelMaxOutputTokens: resolved.model.maxOutputTokens,
    });
    const inputTokens = estimateInputTokens(translated.messages, null);
    // Tool definitions also consume input tokens — include their JSON size.
    const toolsChars = translated.tools ? JSON.stringify(translated.tools).length : 0;
    const total = inputTokens + Math.ceil(toolsChars / 4);
    return corsJson({ input_tokens: total }, { headers: authHeaders });
  } catch (e) {
    if (e instanceof ProtocolTranslationError) {
      return anthropicError(e.status, e.type, e.message, authHeaders);
    }
    return anthropicError(400, 'invalid_request_error', String((e as Error)?.message ?? e), authHeaders);
  }
}
