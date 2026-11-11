import { ok, fail } from '@/lib/api/response';
import { requireAdmin, adminLogout, clearedCookies } from '@/lib/api/admin-auth';

export const runtime = 'nodejs';

/** POST /api/admin/auth/logout — revokes the session and clears cookies. */
export async function POST(req: Request) {
  // A valid session + CSRF is required to log OUT (prevents forced logout CSRF).
  const denied = await requireAdmin(req);
  if (denied) return denied;
  await adminLogout(req);
  const res = ok({ authenticated: false });
  for (const cookie of clearedCookies(req)) {
    res.headers.append('set-cookie', cookie);
  }
  return res;
}
