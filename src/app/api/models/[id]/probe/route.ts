import { probeModel } from '@/lib/model-registry';
import { ok, fail } from '@/lib/api/response';

export const runtime = 'nodejs';
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

/** Health-check a model: sends a tiny completion and records what the gateway served. */
export async function POST(_req: Request, { params }: Params) {
  const { id } = await params;
  const model = await probeModel(id);
  if (!model) return fail(404, 'not_found', 'Model not found.');
  return ok({ model });
}
