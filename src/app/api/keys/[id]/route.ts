import { z } from 'zod';
import { db } from '@/lib/db';
import { ok, fail } from '@/lib/api/response';
import { serializeApiKey } from '@/lib/serialize';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  action: z.enum(['revoke', 'restore']),
  name: z.string().min(1).max(60).trim().optional(),
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
  if (!parsed.success) return fail(400, 'invalid_request', 'Invalid key update.');

  try {
    const data: Record<string, unknown> = {};
    if (parsed.data.action === 'revoke') data.revokedAt = new Date();
    if (parsed.data.action === 'restore') data.revokedAt = null;
    if (parsed.data.name) data.name = parsed.data.name;
    const row = await db.apiKey.update({ where: { id }, data });
    return ok({ key: serializeApiKey(row) });
  } catch {
    return fail(404, 'not_found', 'API key not found.');
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    await db.apiKey.delete({ where: { id } });
    return ok({ deleted: true });
  } catch {
    return fail(404, 'not_found', 'API key not found.');
  }
}
