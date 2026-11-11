// Priority 0 acceptance — administrator authentication & authorization,
// verified with DIRECT HTTP requests (not browser navigation).
//
// Covers: 401 on every admin surface without a session; 403 when a customer
// emr_ API key is presented to admin endpoints; login (wrong + right);
// secure cookie flags; CSRF double-submit enforcement; logout revocation;
// customer /api/v1/* unaffected (missing_api_key, NOT admin_auth_required).

import { describe, test, expect, beforeAll } from 'bun:test';
import { BASE, ADMIN_PASSWORD, adminLogin, freshAdminLogin, adminGet, adminMutate, gatewayCall } from './helpers';

const FAKE_KEY = 'emr_' + '0'.repeat(48);

describe('P0 — administrator authentication', () => {
  test('admin surface returns 401 without a session', async () => {
    const paths = [
      '/api/providers',
      '/api/models',
      '/api/routes',
      '/api/keys',
      '/api/settings',
      '/api/usage',
      '/api/conversations',
      '/api/folders',
      '/api/ops/metrics',
      '/api/ops/budgets',
      '/api/ops/jobs',
      '/api/ops/alerts',
    ];
    for (const p of paths) {
      const res = await fetch(`${BASE}${p}`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('admin_auth_required');
    }
  });

  test('customer API key can never authenticate administration (403)', async () => {
    for (const p of ['/api/providers', '/api/routes', '/api/keys']) {
      const res = await fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${FAKE_KEY}` } });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('api_key_not_admin_credential');
    }
  });

  test('wrong password rejected (401), no session granted', async () => {
    const res = await fetch(`${BASE}/api/admin/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'definitely-not-the-password' }),
    });
    expect(res.status).toBe(401);
  });

  test('login sets HttpOnly + SameSite=Strict cookies with CSRF pair', async () => {
    const res = await fetch(`${BASE}/api/admin/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    expect(res.status).toBe(200);
    const setCookies = res.headers.getSetCookie?.() ?? [];
    const session = setCookies.find((c) => c.startsWith('emor_admin_session=')) ?? '';
    const csrf = setCookies.find((c) => c.startsWith('emor_admin_csrf=')) ?? '';
    expect(session).toContain('HttpOnly');
    expect(session).toContain('SameSite=Strict');
    expect(csrf).toContain('SameSite=Strict');
    expect(csrf).not.toContain('HttpOnly'); // readable for double-submit echo
  });

  test('session check works; mutations demand the CSRF header', async () => {
    const s = await freshAdminLogin();
    const sessionRes = await adminGet(s, '/api/admin/auth/session');
    expect(sessionRes.status).toBe(200);

    // valid session, mutating request, NO X-CSRF-Token → 403
    const noCsrf = await fetch(`${BASE}/api/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: s.cookie },
      body: JSON.stringify({ name: 'csrf-probe' }),
    });
    expect(noCsrf.status).toBe(403);
    const body = (await noCsrf.json()) as { error: { code: string } };
    expect(body.error.code).toBe('csrf_token_invalid');

    // WITH the CSRF header the auth layer passes (business validation may still 4xx)
    const withCsrf = await adminMutate(s, '/api/folders', 'POST', { name: 'csrf-probe-folder' });
    expect([200, 201]).toContain(withCsrf.status);
    // clean up the probe folder
    const created = (await withCsrf.json()) as { id?: string };
    if (created?.id) await adminMutate(s, `/api/folders/${created.id}`, 'DELETE');
  });

  test('invalid CSRF token value rejected (403)', async () => {
    const s = await adminLogin();
    const res = await fetch(`${BASE}/api/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: s.cookie, 'X-CSRF-Token': 'deadbeef' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  test('logout revokes the session server-side', async () => {
    const s = await freshAdminLogin();
    const out = await adminMutate(s, '/api/admin/auth/logout', 'POST');
    expect(out.status).toBe(200);
    // the same cookie is now dead
    const after = await adminGet(s, '/api/admin/auth/session');
    expect(after.status).toBe(401);
    const guard = await adminGet(s, '/api/providers');
    expect(guard.status).toBe(401);
    // leave a live cached session for any subsequent tests
    await freshAdminLogin();
  });

  test('customer gateway stays key-authenticated, not session-gated', async () => {
    const noKey = await fetch(`${BASE}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'emor-5.3', messages: [] }),
    });
    expect(noKey.status).toBe(401);
    const body = (await noKey.json()) as { error: { code: string } };
    expect(body.error.code).toBe('missing_api_key'); // NOT admin_auth_required

    const badKey = await gatewayCall('/api/v1/chat/completions', FAKE_KEY, {
      model: 'emor-5.3',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(badKey.status).toBe(401);

    // preflight stays open for customer CORS flows
    const pre = await fetch(`${BASE}/api/v1/chat/completions`, { method: 'OPTIONS' });
    expect([200, 204]).toContain(pre.status);
  });
});
