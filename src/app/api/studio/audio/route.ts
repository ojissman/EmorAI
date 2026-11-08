import { z } from 'zod';
import { db } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { rateLimit } from '@/lib/rate-limit';
import { fail } from '@/lib/api/response';
import { synthesizeSpeech, writeArtifactFile, TTS_VOICES } from '@/lib/ai/media';
import { serializeArtifact } from '@/lib/artifacts';

export const runtime = 'nodejs';
export const maxDuration = 120;

const schema = z.object({
  text: z.string().min(1).max(8000),
  voice: z.enum(TTS_VOICES).optional(),
  speed: z.number().min(0.5).max(2).default(1),
  title: z.string().max(120).optional(),
});

function ipOf(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'local'
  );
}

/** Text → speech, archived as an audio artifact. */
export async function POST(req: Request) {
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
  const { text, voice, speed, title } = parsed.data;

  const settings = await getSettings();
  const rl = rateLimit(`studio:${ipOf(req)}`, settings.dashboardRateLimitPerMin, 60_000);
  if (!rl.ok) {
    return fail(429, 'rate_limited', `Too many generation requests. Retry after ${rl.retryAfterSec}s.`);
  }

  const row = await db.artifact.create({
    data: {
      kind: 'audio',
      title: (title?.trim() || text.trim().slice(0, 80)) || 'Generated speech',
      description: voice ? `Voice: ${voice}` : '',
      prompt: text,
      status: 'processing',
      meta: { voice: voice ?? null, speed },
    },
  });

  try {
    const audio = await synthesizeSpeech(text, voice, speed);
    const { storagePath, size: bytes } = await writeArtifactFile(row.id, audio.buffer);
    const updated = await db.artifact.update({
      where: { id: row.id },
      data: { status: 'ready', storagePath, mime: audio.mime, size: bytes },
    });
    return Response.json({ artifact: serializeArtifact(updated) });
  } catch (e) {
    const message = (e as Error).message.slice(0, 300);
    await db.artifact
      .update({ where: { id: row.id }, data: { status: 'failed', error: message } })
      .catch(() => undefined);
    return fail(502, 'tts_failed', `Speech generation failed: ${message}`);
  }
}
