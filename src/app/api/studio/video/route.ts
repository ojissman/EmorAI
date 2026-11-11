import { z } from 'zod';
import { db } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { rateLimit } from '@/lib/rate-limit';
import { fail } from '@/lib/api/response';
import { requireAdmin } from '@/lib/api/admin-auth';
import { startVideoJob } from '@/lib/ai/media';
import { serializeArtifact } from '@/lib/artifacts';

export const runtime = 'nodejs';
export const maxDuration = 120;

const schema = z.object({
  prompt: z.string().min(3).max(4000),
  quality: z.enum(['speed', 'quality']).default('speed'),
  withAudio: z.boolean().default(false),
  duration: z.number().int().min(5).max(10).optional(),
  size: z.string().max(20).optional(),
});

function ipOf(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'local'
  );
}

/**
 * Starts an async video generation task. Returns a `processing` artifact; the
 * client polls GET /api/artifacts/[id] until status flips to ready/failed.
 */
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
    return fail(400, 'invalid_request', 'Invalid video request.', { details: parsed.error.flatten() });
  }
  const { prompt, quality, withAudio, duration, size } = parsed.data;

  const settings = await getSettings();
  const rl = rateLimit(`studio:${ipOf(req)}`, settings.dashboardRateLimitPerMin, 60_000);
  if (!rl.ok) {
    return fail(429, 'rate_limited', `Too many generation requests. Retry after ${rl.retryAfterSec}s.`);
  }

  let taskId: string;
  try {
    taskId = await startVideoJob({ prompt, quality, withAudio, duration, size });
  } catch (e) {
    return fail(502, 'video_submit_failed', `The video service rejected the task: ${(e as Error).message.slice(0, 240)}`);
  }

  const row = await db.artifact.create({
    data: {
      kind: 'video',
      title: prompt.trim().slice(0, 80) || 'Generated video',
      description: '',
      prompt,
      status: 'processing',
      providerTaskId: taskId,
      meta: { quality, withAudio, ...(duration ? { duration } : {}), ...(size ? { size } : {}) },
    },
  });

  return Response.json({ artifact: serializeArtifact(row) });
}
