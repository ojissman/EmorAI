import { z } from 'zod';
import { db } from '@/lib/db';
import { ok, fail } from '@/lib/api/response';
import { serializeFolder } from '@/lib/serialize';

export const runtime = 'nodejs';

export async function GET() {
  const folders = await db.folder.findMany({ orderBy: { createdAt: 'asc' } });
  return ok({ folders: folders.map(serializeFolder) });
}

const createSchema = z.object({
  name: z.string().min(1).max(60).trim(),
  color: z.string().max(20).optional().nullable(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'bad_json', 'Request body must be valid JSON.');
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return fail(400, 'invalid_request', 'Folder name is required (max 60 chars).');
  const folder = await db.folder.create({ data: { name: parsed.data.name, color: parsed.data.color ?? null } });
  return ok({ folder: serializeFolder(folder) }, { status: 201 });
}
