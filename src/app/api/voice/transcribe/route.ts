import { z } from 'zod';
import { getSettings } from '@/lib/settings';
import { rateLimit } from '@/lib/rate-limit';
import { fail } from '@/lib/api/response';
import { transcribeAudio } from '@/lib/ai/media';

export const runtime = 'nodejs';
export const maxDuration = 120;

const schema = z.object({
  // base64 of the recorded audio (webm/opus from MediaRecorder, or wav/mp3/m4a)
  audio: z.string().min(64).max(30 * 1024 * 1024),
});

function ipOf(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'local'
  );
}

/** Speech → text for voice dictation in the composer. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'bad_json', 'Request body must be valid JSON.');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return fail(400, 'invalid_request', 'Invalid transcription request (audio payload missing or too large).');
  }

  const settings = await getSettings();
  const rl = rateLimit(`voice:${ipOf(req)}`, settings.dashboardRateLimitPerMin, 60_000);
  if (!rl.ok) {
    return fail(429, 'rate_limited', `Too many transcription requests. Retry after ${rl.retryAfterSec}s.`);
  }

  try {
    const text = await transcribeAudio(parsed.data.audio);
    return Response.json({ text });
  } catch (e) {
    return fail(502, 'asr_failed', `Transcription failed: ${(e as Error).message.slice(0, 240)}`);
  }
}
