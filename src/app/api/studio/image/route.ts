import { z } from 'zod';
import { db } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { rateLimit } from '@/lib/rate-limit';
import { fail } from '@/lib/api/response';
import { requireAdmin } from '@/lib/api/admin-auth';
import { generateImages, writeArtifactFile, IMAGE_SIZES } from '@/lib/ai/media';
import { serializeArtifact } from '@/lib/artifacts';

export const runtime = 'nodejs';
export const maxDuration = 300;

const schema = z.object({
  prompt: z.string().min(3).max(4000),
  size: z.enum(IMAGE_SIZES).default('1024x1024'),
  count: z.number().int().min(1).max(4).default(1),
});

function ipOf(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'local'
  );
}

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
    return fail(400, 'invalid_request', 'Invalid image request.', { details: parsed.error.flatten() });
  }
  const { prompt, size, count } = parsed.data;

  const settings = await getSettings();
  const rl = rateLimit(`studio:${ipOf(req)}`, settings.dashboardRateLimitPerMin, 60_000);
  if (!rl.ok) {
    return fail(429, 'rate_limited', `Too many generation requests. Retry after ${rl.retryAfterSec}s.`);
  }

  const title = prompt.trim().slice(0, 80) || 'Generated image';
  // Reserve artifact rows first so the client immediately sees pending cards.
  const rows = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      db.artifact.create({
        data: {
          kind: 'image',
          title: count > 1 ? `${title} (${i + 1})` : title,
          description: '',
          prompt,
          status: 'processing',
          meta: { size },
        },
      })
    )
  );

  const done: Awaited<ReturnType<typeof db.artifact.update>>[] = [];
  try {
    // The provider returns one image per call; run `count` sequential calls.
    for (const row of rows) {
      const [img] = await generateImages(prompt, size);
      const { storagePath, size: bytes } = await writeArtifactFile(row.id, img.buffer);
      const updated = await db.artifact.update({
        where: { id: row.id },
        data: { status: 'ready', storagePath, mime: img.mime, size: bytes },
      });
      done.push(updated);
    }
    return Response.json({ artifacts: done.map((a) => serializeArtifact(a)) });
  } catch (e) {
    const message = (e as Error).message.slice(0, 300);
    await Promise.all(
      rows
        .filter((r) => !done.some((d) => d.id === r.id))
        .map((r) =>
          db.artifact
            .update({ where: { id: r.id }, data: { status: 'failed', error: message } })
            .catch(() => undefined)
        )
    );
    return fail(502, 'generation_failed', `Image generation failed: ${message}`);
  }
}
