import { ok, fail } from '@/lib/api/response';
import { requireAdmin } from '@/lib/api/admin-auth';
import { discoverAvailability } from '@/lib/model-registry';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Discover genuine availability across the whole registry: probes every model
 * sequentially with backoff and records what the provider gateway actually
 * serves. Spaced to respect upstream rate limits — may take ~1–2 minutes.
 */
export async function POST(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const models = await discoverAvailability();
  return ok({ models });
}
