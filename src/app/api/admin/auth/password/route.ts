import { z } from 'zod';
import { ok, fail } from '@/lib/api/response';
import { requireAdmin, changeAdminPassword, clearedCookies } from '@/lib/api/admin-auth';

export const runtime = 'nodejs';

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(10).max(1024),
});

/** POST /api/admin/auth/password — changes the administrator password (revokes all sessions). */
export async function POST(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'bad_json', 'Request body must be valid JSON.');
  }
  const parsed = passwordSchema.safeParse(body);
  if (!parsed.success) {
    return fail(400, 'invalid_request', 'currentPassword and newPassword (min 10 chars) are required.', { details: parsed.error.flatten() });
  }
  const result = await changeAdminPassword(parsed.data.currentPassword, parsed.data.newPassword);
  if (!result.ok) {
    return fail(result.status, result.code, result.message);
  }
  const res = ok({ changed: true, message: result.message });
  for (const cookie of clearedCookies(req)) {
    res.headers.append('set-cookie', cookie);
  }
  return res;
}
