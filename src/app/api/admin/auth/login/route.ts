import { z } from 'zod';
import { ok, fail } from '@/lib/api/response';
import { adminLogin, sessionCookies } from '@/lib/api/admin-auth';

export const runtime = 'nodejs';

const loginSchema = z.object({ password: z.string().min(1).max(1024) });

/** POST /api/admin/auth/login — creates an administrator session. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'bad_json', 'Request body must be valid JSON.');
  }
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return fail(400, 'invalid_request', 'Password is required.', { details: parsed.error.flatten() });
  }
  const result = await adminLogin(req, parsed.data.password);
  if (!result.ok) {
    return fail(result.status, result.code, result.message, result.retryAfterSec ? { retryAfterSec: result.retryAfterSec } : undefined);
  }
  const res = ok({
    authenticated: true,
    username: 'admin',
    expiresAt: result.expiresAt.toISOString(),
    csrfToken: result.csrfToken,
  });
  for (const cookie of sessionCookies(req, result.token, result.csrfToken, result.expiresAt)) {
    res.headers.append('set-cookie', cookie);
  }
  return res;
}
