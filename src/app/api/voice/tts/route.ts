import { z } from 'zod';
import { getSettings } from '@/lib/settings';
import { rateLimit } from '@/lib/rate-limit';
import { fail } from '@/lib/api/response';
import { requireAdmin } from '@/lib/api/admin-auth';
import { synthesizeSpeech, TTS_VOICES } from '@/lib/ai/media';

export const runtime = 'nodejs';
export const maxDuration = 120;

const schema = z.object({
  text: z.string().min(1).max(8000),
  voice: z.enum(TTS_VOICES).optional(),
  speed: z.number().min(0.5).max(2).default(1),
});

function ipOf(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'local'
  );
}

/** Text → speech stream for read-aloud in chat (ephemeral, not archived). */
export async function POST(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'bad_json', 'Request body must be valid JSON.');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return fail(400, 'invalid_request', 'Invalid speech request.', { details: parsed.error.flatten() });
  }

  const settings = await getSettings();
  const rl = rateLimit(`voice:${ipOf(req)}`, settings.dashboardRateLimitPerMin, 60_000);
  if (!rl.ok) {
    return fail(429, 'rate_limited', `Too many speech requests. Retry after ${rl.retryAfterSec}s.`);
  }

  try {
    const audio = await synthesizeSpeech(parsed.data.text, parsed.data.voice, parsed.data.speed);
    return new Response(new Uint8Array(audio.buffer), {
      headers: {
        'Content-Type': audio.mime,
        'Content-Length': String(audio.buffer.byteLength),
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return fail(502, 'tts_failed', `Speech generation failed: ${(e as Error).message.slice(0, 240)}`);
  }
}
