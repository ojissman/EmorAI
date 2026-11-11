import { readStoredFile, deleteStoredFile } from '@/lib/files';
import { fail, ok } from '@/lib/api/response';
import { requireAdmin } from '@/lib/api/admin-auth';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/** Serves an uploaded file's bytes (used for image previews and vision requests). */
export async function GET(req: Request, { params }: Params) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const { id } = await params;
  const stored = await readStoredFile(id);
  if (!stored) return fail(404, 'not_found', 'File not found.');
  return new Response(new Uint8Array(stored.buffer), {
    headers: {
      'Content-Type': stored.meta.mime,
      'Content-Disposition': `inline; filename="${encodeURIComponent(stored.meta.name)}"`,
      'Cache-Control': 'private, max-age=3600',
    },
  });
}

export async function DELETE(req: Request, { params }: Params) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const { id } = await params;
  await deleteStoredFile(id);
  return ok({ deleted: true });
}
