import { z } from 'zod';
import { authenticateV1 } from '@/lib/api/auth';
import { getSettings } from '@/lib/settings';
import { recordUsage } from '@/lib/usage';
import { startVideoJob } from '@/lib/ai/media';

export const runtime = 'nodejs';
export const maxDuration = 120;

function openAiError(status: number, code: string, message: string, type = 'invalid_request_error') {
  return Response.json({ error: { message, type, code } }, { status });
}

const bodySchema = z.object({
  model: z.string().max(120).optional(),
  prompt: z.string().min(3).max(4000),
  quality: z.enum(['speed', 'quality']).default('speed'),
  with_audio: z.boolean().default(false),
  duration: z.number().int().min(5).max(10).optional(),
  size: z.string().max(20).optional(),
  request_id: z.string().max(120).optional(),
});

/** OpenAI-style async video task submission: POST /api/v1/videos/generations */
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
  const startedAt = Date.now();

  try {
    const taskId = await startVideoJob({
      prompt: parsed.data.prompt,
      quality: parsed.data.quality,
      withAudio: parsed.data.with_audio,
      duration: parsed.data.duration,
      size: parsed.data.size,
    });
    void recordUsage({
      source: 'api',
      apiKeyId: auth.apiKeyId,
      modelId: parsed.data.model ?? 'zai-video',
      latencyMs: Date.now() - startedAt,
      success: true,
    });
    return Response.json({
      id: taskId,
      request_id: parsed.data.request_id ?? null,
      model: parsed.data.model ?? 'zai-video',
      task_status: 'PROCESSING',
    });
  } catch (e) {
    void recordUsage({
      source: 'api',
      apiKeyId: auth.apiKeyId,
      modelId: parsed.data.model ?? 'zai-video',
      latencyMs: Date.now() - startedAt,
      success: false,
      errorText: (e as Error).message,
    });
    return openAiError(502, 'video_submit_failed', `The video service rejected the task: ${(e as Error).message.slice(0, 240)}`, 'provider_error');
  }
}
