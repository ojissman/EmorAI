import { z } from 'zod';
import { authenticateV1 } from '@/lib/api/auth';
import { getSettings } from '@/lib/settings';
import { recordUsage } from '@/lib/usage';
import { synthesizeSpeech, TTS_VOICES } from '@/lib/ai/media';

export const runtime = 'nodejs';
export const maxDuration = 120;

function openAiError(status: number, code: string, message: string, type = 'invalid_request_error') {
  return Response.json({ error: { message, type, code } }, { status });
}

const bodySchema = z.object({
  model: z.string().max(120).optional(),
  input: z.string().min(1).max(8000),
  voice: z.enum(TTS_VOICES).optional(),
  speed: z.number().min(0.5).max(2).default(1),
  response_format: z.string().max(20).optional(),
});

/** OpenAI-compatible text → speech: POST /api/v1/audio/speech (binary audio). */
export async function POST(req: Request) {
  const auth = await authenticateV1(req);
  if (!auth.ok) return auth.response;

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
  const { input, voice, speed } = parsed.data;
  const startedAt = Date.now();

  try {
    const audio = await synthesizeSpeech(input, voice, speed);
    void recordUsage({
      source: 'api',
      apiKeyId: auth.apiKeyId,
      modelId: parsed.data.model ?? 'zai-tts',
      latencyMs: Date.now() - startedAt,
      success: true,
    });
    return new Response(new Uint8Array(audio.buffer), {
      headers: {
        'Content-Type': audio.mime,
        'Content-Length': String(audio.buffer.byteLength),
      },
    });
  } catch (e) {
    void recordUsage({
      source: 'api',
      apiKeyId: auth.apiKeyId,
      modelId: parsed.data.model ?? 'zai-tts',
      latencyMs: Date.now() - startedAt,
      success: false,
      errorText: (e as Error).message,
    });
    return openAiError(502, 'speech_failed', `Speech synthesis failed: ${(e as Error).message.slice(0, 240)}`, 'provider_error');
  }
}
