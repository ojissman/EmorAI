import { ok, fail } from '@/lib/api/response';
import { validateAdminSession } from '@/lib/api/admin-auth';

export const runtime = 'nodejs';

/**
 * GET /api/admin/auth/session — the only admin route reachable without a
 * session. Reports login state (401 when unauthenticated) so the frontend
 * can gate the dashboard on real server state, never on navigation.
 */
export async function GET(req: Request) {
  const session = await validateAdminSession(req);
  if (!session) {
    return fail(401, 'admin_auth_required', 'Administrator session required. Log in through the dashboard.');
  }
  return ok({ authenticated: true, username: 'admin', expiresAt: session.expiresAt.toISOString(), csrfToken: session.csrfToken });
}
