import { probeModel } from '@/lib/model-registry';
import { ok, fail } from '@/lib/api/response';
import { requireAdmin } from '@/lib/api/admin-auth';

export const runtime = 'nodejs';
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

/** Health-check a model: sends a tiny completion and records what the gateway served. */
export async function POST(req: Request, { params }: Params) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const { id } = await params;
  const model = await probeModel(id);
  if (!model) return fail(404, 'not_found', 'Model not found.');
  return ok({ model });
}
