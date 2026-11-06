import { z } from 'zod';
import { db } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { rateLimit } from '@/lib/rate-limit';
import { fail } from '@/lib/api/response';
import { editImage, writeArtifactFile, IMAGE_SIZES } from '@/lib/ai/media';
import { readStoredFile } from '@/lib/files';
import { serializeArtifact } from '@/lib/artifacts';

export const runtime = 'nodejs';
export const maxDuration = 300;

const schema = z.object({
  prompt: z.string().min(3).max(4000),
  fileId: z.string().min(1),
  size: z.enum(IMAGE_SIZES).default('1024x1024'),
});

function ipOf(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'local'
  );
}

/** Edits an uploaded image (via chat attachment upload) with a prompt. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'bad_json', 'Request body must be valid JSON.');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return fail(400, 'invalid_request', 'Invalid image edit request.', { details: parsed.error.flatten() });
  }
  const { prompt, fileId, size } = parsed.data;

  const settings = await getSettings();
  const rl = rateLimit(`studio:${ipOf(req)}`, settings.dashboardRateLimitPerMin, 60_000);
  if (!rl.ok) {
    return fail(429, 'rate_limited', `Too many generation requests. Retry after ${rl.retryAfterSec}s.`);
  }

  const stored = await readStoredFile(fileId);
  if (!stored) return fail(404, 'file_not_found', 'The source image was not found. Upload it again.');
  if (stored.meta.kind !== 'image') return fail(400, 'not_an_image', 'Image editing requires an image attachment.');

  const row = await db.artifact.create({
    data: {
      kind: 'image',
      title: prompt.trim().slice(0, 80) || 'Edited image',
      description: `Edit of ${stored.meta.name}`,
      prompt,
      status: 'processing',
      meta: { size, sourceFileId: fileId },
    },
  });

  try {
    const base64 = stored.buffer.toString('base64');
    const img = await editImage(prompt, base64, size);
    const { storagePath, size: bytes } = await writeArtifactFile(row.id, img.buffer);
    const updated = await db.artifact.update({
      where: { id: row.id },
      data: { status: 'ready', storagePath, mime: img.mime, size: bytes },
    });
    return Response.json({ artifact: serializeArtifact(updated) });
  } catch (e) {
    const message = (e as Error).message.slice(0, 300);
    await db.artifact
      .update({ where: { id: row.id }, data: { status: 'failed', error: message } })
      .catch(() => undefined);
    return fail(502, 'generation_failed', `Image editing failed: ${message}`);
  }
}
