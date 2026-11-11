// ─── Unit tests: destination URL policy + secureFetch (SSRF guard) ────────────
// Covers parse/scheme rejection, blocked-address classes (IPv4 + IPv6),
// allowlist exemptions, requireHttps enforcement, DNS paths, and the
// secureFetch behaviors: re-validated redirects (blocked/private targets),
// credential stripping on cross-host hops, response size caps, timeouts.
//
// Network-facing tests use tiny Bun.serve mock servers bound to 127.0.0.1,
// allowlisted for the first hop; everything else is pure policy logic.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  assertProviderUrlAllowed,
  isBlockedAddress,
  parseTargetUrl,
} from '@/lib/net/url-policy';
import {
  DestinationBlockedError,
  ResponseTooLargeError,
  isAbortLikeError,
  secureFetch,
} from '@/lib/net/secure-fetch';
import type { SecureFetchPolicy } from '@/lib/net/secure-fetch';

// ── mock upstream servers ───────────────────────────────────────────────────

let controlServer: Bun.Server | null = null;
let echoServer: Bun.Server | null = null;
let controlPort = 0;
let echoPort = 0;
let lastEchoHeaders: Record<string, string | null> = {};

beforeAll(() => {
  echoServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      lastEchoHeaders = {
        authorization: req.headers.get('authorization'),
        'x-api-key': req.headers.get('x-api-key'),
        'api-key': req.headers.get('api-key'),
        cookie: req.headers.get('cookie'),
      };
      return Response.json({ seen: true });
    },
  });
  echoPort = echoServer.port;

  controlServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      switch (path) {
        case '/to-private':
          // classic SSRF lure: redirect off to private network space
          return new Response(null, { status: 302, headers: { location: 'http://10.1.2.3/steal' } });
        case '/to-echo':
          // cross-host hop (different host:port) — credentials must be stripped
          return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${echoPort}/echo` } });
        case '/big':
          return new Response('A'.repeat(256 * 1024), { status: 200 });
        case '/hang':
          return new Promise<Response>(() => {
            // never resolves — connection hangs
          });
        default:
          return new Response('ok', { status: 200 });
      }
    },
  });
  controlPort = controlServer.port;
});

afterAll(() => {
  controlServer?.stop(true);
  echoServer?.stop(true);
});

// ── parseTargetUrl ──────────────────────────────────────────────────────────

describe('parseTargetUrl', () => {
  test('rejects every non-http(s) scheme outright', () => {
    const raw = [
      'file:///etc/passwd',
      'gopher://127.0.0.1:70/x',
      'data:text/plain,hello',
      'ftp://example.com/pub',
      'ws://example.com/socket',
      'javascript:alert(1)',
    ];
    for (const candidate of raw) {
      expect(parseTargetUrl(candidate)).toEqual({ ok: false, reason: 'scheme_not_allowed' });
    }
  });

  test('rejects malformed urls, userinfo, bad port', () => {
    expect(parseTargetUrl('not a url at all')).toEqual({ ok: false, reason: 'invalid_url' });
    // empty-hostname forms (http://, http://:81, http://#f…) are rejected by
    // the URL parser itself — the missing_hostname branch is defense-in-depth
    expect(parseTargetUrl('http://:81/x')).toEqual({ ok: false, reason: 'invalid_url' });
    expect(parseTargetUrl('http://user:secret@example.com/v1')).toEqual({ ok: false, reason: 'userinfo_not_allowed' });
    expect(parseTargetUrl('http://example.com:0/v1')).toEqual({ ok: false, reason: 'invalid_port' });
    expect(parseTargetUrl('http://example.com:70000/v1')).toEqual({ ok: false, reason: 'invalid_url' });
  });

  test('accepts a well-formed http url with explicit port', () => {
    const verdict = parseTargetUrl('http://127.0.0.1:3999/v1');
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.url.toString()).toBe('http://127.0.0.1:3999/v1');
  });
});

// ── blocked-address classification ───────────────────────────────────────────

describe('isBlockedAddress', () => {
  test.each([
    ['127.0.0.1', 'loopback'],
    ['127.200.1.1', 'loopback'],
    ['169.254.169.254', 'link_local'], // cloud metadata
    ['169.254.0.1', 'link_local'],
    ['10.1.2.3', 'private'],
    ['192.168.0.5', 'private'],
    ['172.20.1.1', 'private'],
    ['172.31.255.1', 'private'],
    ['100.64.0.1', 'cgnat'],
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['255.255.255.255', 'broadcast'],
    ['240.0.0.1', 'reserved'],
    ['224.0.0.1', 'multicast'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link_local'],
    ['febf::abcd', 'link_local'],
    ['fd00::5', 'unique_local'],
    ['fc12::1', 'unique_local'],
    ['ff02::1', 'multicast'],
    ['::ffff:127.0.0.1', 'loopback'], // IPv4-mapped
    ['::ffff:169.254.169.254', 'link_local'], // IPv4-mapped metadata
    ['::ffff:10.1.2.3', 'private'], // IPv4-mapped private
  ])('%s → %s', (ip, reason) => {
    expect(isBlockedAddress(ip)).toEqual({ blocked: true, reason });
  });

  test.each(['8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '11.0.0.1', '2606:4700:4700::1111', '2a00:1450:4009:81::200e'])(
    '%s is allowed',
    (ip) => {
      expect(isBlockedAddress(ip).blocked).toBe(false);
    },
  );

  test('malformed or non-canonical literals are blocked as invalid', () => {
    for (const bad of ['127.1', '010.0.0.1', '2130706433', '0x7f.0.0.1', '1.2.3.4.5', 'not-an-ip', '', ':::1', 'fe80:!:1']) {
      const verdict = isBlockedAddress(bad);
      expect(verdict.blocked).toBe(true);
      expect(verdict.reason).toBe('invalid_address');
    }
  });
});

// ── assertProviderUrlAllowed ─────────────────────────────────────────────────

describe('assertProviderUrlAllowed', () => {
  test('allowlist exempts a private http destination (self-hosted escape hatch)', async () => {
    const ok = await assertProviderUrlAllowed('http://127.0.0.1:3999/v1', { allowlist: ['127.0.0.1:3999'] });
    expect(ok).toEqual({ ok: true, resolved: ['127.0.0.1'] });
  });

  test('bare-hostname allowlist entries cover all ports on that host', async () => {
    const ok = await assertProviderUrlAllowed('http://127.0.0.1:3999/v1', { allowlist: ['127.0.0.1'] });
    expect(ok.ok).toBe(true);
  });

  test('loopback IP literal blocked with empty allowlist', async () => {
    const verdict = await assertProviderUrlAllowed('http://127.0.0.1:3999/v1', { allowlist: [], requireHttps: false });
    expect(verdict).toEqual({ ok: false, reason: 'loopback' });
  });

  test('IPv6 literal URLs are blocked by class', async () => {
    expect(await assertProviderUrlAllowed('http://[::1]:3999/v1', { allowlist: [], requireHttps: false })).toEqual({ ok: false, reason: 'loopback' });
    expect(await assertProviderUrlAllowed('http://[fd00::5]/', { allowlist: [], requireHttps: false })).toEqual({ ok: false, reason: 'unique_local' });
    expect(await assertProviderUrlAllowed('http://[fe80::1]/', { allowlist: [], requireHttps: false })).toEqual({ ok: false, reason: 'link_local' });
    expect(await assertProviderUrlAllowed('http://[::ffff:10.1.2.3]/', { allowlist: [], requireHttps: false })).toEqual({ ok: false, reason: 'private' });
  });

  test('requireHttps enforcement: public http rejected when not allowlisted', async () => {
    // scheme rule fires before DNS, so no network is needed
    expect(await assertProviderUrlAllowed('http://example.com/v1', {})).toEqual({ ok: false, reason: 'insecure_scheme' });
    expect((await assertProviderUrlAllowed('http://example.com/v1', { allowlist: ['example.com'] })).ok).toBe(true);
  });

  test('localhost never needs DNS to be classified as loopback', async () => {
    expect(await assertProviderUrlAllowed('http://localhost:1234/v1', { allowlist: [], requireHttps: false })).toEqual({ ok: false, reason: 'loopback' });
    expect(await assertProviderUrlAllowed('http://api.localhost/v1', { allowlist: [], requireHttps: false })).toEqual({ ok: false, reason: 'loopback' });
    const allowlisted = await assertProviderUrlAllowed('http://localhost:1234/v1', { allowlist: ['localhost'] });
    expect(allowlisted.ok).toBe(true);
  });

  test('unresolvable hostnames are blocked with dns_unresolvable', async () => {
    const verdict = await assertProviderUrlAllowed('https://emorai-no-such-host.invalid/v1', { requireHttps: false });
    expect(verdict).toEqual({ ok: false, reason: 'dns_unresolvable' });
  });

  test('public https url passes when DNS is available (else fails honestly)', async () => {
    const verdict = await assertProviderUrlAllowed('https://api.anthropic.com/v1', { allowlist: [] });
    if (verdict.ok) {
      expect(verdict.resolved.length).toBeGreaterThan(0);
      for (const addr of verdict.resolved) {
        expect(isBlockedAddress(addr).blocked).toBe(false);
      }
    } else {
      // sandbox without DNS — the parse path must still fail honestly
      expect(verdict.reason).toBe('dns_unresolvable');
    }
  }, 15_000);
});

// ── secureFetch ─────────────────────────────────────────────────────────────

describe('secureFetch', () => {
  const openHttpPolicy = (): SecureFetchPolicy => ({
    allowlist: [`127.0.0.1:${controlPort}`, `127.0.0.1:${echoPort}`],
    requireHttps: false,
    maxResponseBytes: 1024 * 1024,
  });

  test('cloud metadata endpoint is blocked outright (no connection attempted)', async () => {
    let threw: unknown = null;
    try {
      await secureFetch('http://169.254.169.254/latest/meta-data', { method: 'GET' }, { timeoutMs: 2_000, policy: { allowlist: [], requireHttps: false, maxResponseBytes: 64 * 1024 } });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(DestinationBlockedError);
    expect((threw as DestinationBlockedError).reason).toBe('link_local');
  });

  test('non-http schemes are rejected before any connection', async () => {
    let threw: unknown = null;
    try {
      await secureFetch('file:///etc/passwd', { method: 'GET' }, { timeoutMs: 2_000, policy: { allowlist: [], requireHttps: false, maxResponseBytes: 64 * 1024 } });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(DestinationBlockedError);
    expect((threw as DestinationBlockedError).reason).toBe('scheme_not_allowed');
  });

  test('redirect into private network space is refused at the hop', async () => {
    // first hop is legal (allowlisted); the redirect points at 10.1.2.3
    let threw: unknown = null;
    try {
      await secureFetch(
        `http://127.0.0.1:${controlPort}/to-private`,
        { method: 'GET', headers: { authorization: 'Bearer sekrit' } },
        { timeoutMs: 5_000, policy: { allowlist: [`127.0.0.1:${controlPort}`], requireHttps: false, maxResponseBytes: 64 * 1024 } },
      );
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(DestinationBlockedError);
    expect((threw as DestinationBlockedError).reason).toBe('private');
  });

  test('cross-host redirect strips authorization / x-api-key / api-key headers', async () => {
    const res = await secureFetch(
      `http://127.0.0.1:${controlPort}/to-echo`,
      { method: 'GET', headers: { authorization: 'Bearer sekrit', 'x-api-key': 'sekrit2', 'api-key': 'sekrit3' } },
      { timeoutMs: 5_000, policy: openHttpPolicy() },
    );
    expect(res.ok).toBe(true);
    await res.text();
    // the second (cross-host) hop must arrive with no credentials
    expect(lastEchoHeaders.authorization).toBe(null);
    expect(lastEchoHeaders['x-api-key']).toBe(null);
    expect(lastEchoHeaders['api-key']).toBe(null);
  });

  test('credentials are preserved when there is no cross-host hop', async () => {
    const res = await secureFetch(
      `http://127.0.0.1:${echoPort}/echo`,
      { method: 'GET', headers: { authorization: 'Bearer kept', 'x-api-key': 'kept2' } },
      { timeoutMs: 5_000, policy: openHttpPolicy() },
    );
    expect(res.ok).toBe(true);
    await res.text();
    expect(lastEchoHeaders.authorization).toBe('Bearer kept');
    expect(lastEchoHeaders['x-api-key']).toBe('kept2');
  });

  test('oversized response body throws ResponseTooLargeError at read time', async () => {
    // server returns 256 KiB; the policy caps bodies at 4 KiB
    const res = await secureFetch(
      `http://127.0.0.1:${controlPort}/big`,
      { method: 'GET' },
      { timeoutMs: 5_000, policy: { allowlist: [`127.0.0.1:${controlPort}`], requireHttps: false, maxResponseBytes: 4 * 1024 } },
    );
    expect(res.status).toBe(200);
    let threw: unknown = null;
    try {
      await res.text();
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(ResponseTooLargeError);
    expect((threw as ResponseTooLargeError).maxBytes).toBe(4 * 1024);
  });

  test('hanging endpoint aborts within the timeout budget', async () => {
    const started = Date.now();
    let threw: unknown = null;
    try {
      await secureFetch(
        `http://127.0.0.1:${controlPort}/hang`,
        { method: 'GET' },
        { timeoutMs: 500, policy: openHttpPolicy() },
      );
    } catch (e) {
      threw = e;
    }
    const elapsed = Date.now() - started;
    expect(threw).toBeTruthy();
    expect(threw).not.toBeInstanceOf(DestinationBlockedError);
    const looksAbort = isAbortLikeError(threw);
    const name = (threw as Error | undefined)?.name ?? '';
    const message = String((threw as Error | undefined)?.message ?? '');
    expect(looksAbort || name === 'AbortError' || name === 'TimeoutError' || /abort|timeout/i.test(message)).toBe(true);
    expect(elapsed).toBeLessThan(5_000);
  }, 15_000);
});
