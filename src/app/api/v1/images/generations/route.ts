import { z } from 'zod';
import { authenticateV1, scopeFailure } from '@/lib/api/auth';
import { recordUsage } from '@/lib/usage';
import { generateImages, IMAGE_SIZES } from '@/lib/ai/media';
import { openAiAuthFailure } from '@/lib/api/protocol/openai';

export const runtime = 'nodejs';
export const maxDuration = 300;

function openAiError(status: number, code: string, message: string, type = 'invalid_request_error') {
  return Response.json({ error: { message, type, code } }, { status });
}

const bodySchema = z.object({
  model: z.string().max(120).optional(),
  prompt: z.string().min(3).max(4000),
  size: z.enum(IMAGE_SIZES).default('1024x1024'),
  n: z.number().int().min(1).max(4).default(1),
  response_format: z.enum(['b64_json']).default('b64_json'),
});

/** OpenAI-compatible image generation: POST /api/v1/images/generations */
export async function POST(req: Request) {
  const auth = await authenticateV1(req);
  if (!auth.ok) return openAiAuthFailure(auth.error);
  const mediaScope = scopeFailure(auth.key, 'media');
  if (mediaScope) return openAiAuthFailure(mediaScope);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return openAiError(400, 'bad_json', 'Request body must be valid JSON.');
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return openAiError(400, 'invalid_request', `Invalid request payload: ${parsed.error.issues[0]?.message ?? 'malformed body'}`);
  }
  const { prompt, size, n } = parsed.data;
  const startedAt = Date.now();

  try {
    const data: { b64_json: string }[] = [];
    for (let i = 0; i < n; i++) {
      const images = await generateImages(prompt, size);
      for (const img of images) {
        data.push({ b64_json: img.buffer.toString('base64') });
        if (data.length >= n) break;
      }
      if (data.length >= n) break;
    }
    void recordUsage({
      source: 'api',
      protocol: 'openai',
      endpoint: '/api/v1/images/generations',
      apiKeyId: auth.key.apiKeyId,
      modelId: parsed.data.model ?? 'zai-image',
      latencyMs: Date.now() - startedAt,
      success: true,
    });
    return Response.json({ created: Math.floor(Date.now() / 1000), data });
  } catch (e) {
    void recordUsage({
      source: 'api',
      protocol: 'openai',
      endpoint: '/api/v1/images/generations',
      apiKeyId: auth.key.apiKeyId,
      modelId: parsed.data.model ?? 'zai-image',
      latencyMs: Date.now() - startedAt,
      success: false,
      errorText: (e as Error).message,
    });
    return openAiError(502, 'image_generation_failed', `Image generation failed: ${(e as Error).message.slice(0, 240)}`, 'provider_error');
  }
}
