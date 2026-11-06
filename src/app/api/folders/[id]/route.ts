import { z } from 'zod';
import { db } from '@/lib/db';
import { ok, fail } from '@/lib/api/response';
import { serializeFolder } from '@/lib/serialize';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  name: z.string().min(1).max(60).trim().optional(),
  color: z.string().max(20).nullable().optional(),
});

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'bad_json', 'Request body must be valid JSON.');
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return fail(400, 'invalid_request', 'Invalid folder update.');
  try {
    const folder = await db.folder.update({ where: { id }, data: parsed.data });
    return ok({ folder: serializeFolder(folder) });
  } catch {
    return fail(404, 'not_found', 'Folder not found.');
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    // Conversations survive: folderId is SetNull.
    await db.folder.delete({ where: { id } });
    return ok({ deleted: true });
  } catch {
    return fail(404, 'not_found', 'Folder not found.');
  }
}
