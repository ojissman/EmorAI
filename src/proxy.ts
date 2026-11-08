import { NextResponse, type NextRequest } from 'next/server';

/**
 * Lightweight origin guard + security headers.
 * Mutating dashboard API calls must be same-origin (CSRF mitigation for the
 * cookie-less, single-owner installation). The developer API (/api/v1/*) uses
 * Bearer tokens and is exempt.
 *
 * Proxy-aware: the app runs behind reverse proxies (Caddy gateway / preview
 * tunnel), so the browser's Origin may differ from the rewritten Host header
 * that reaches Next.js. We therefore accept an Origin that matches ANY host
 * advertised by the proxy chain (`Host`, `X-Forwarded-Host`). As a final
 * fallback, requests carrying no cookies are always allowed — CSRF is only
 * exploitable when ambient credentials (cookies) exist, and this install is
 * cookie-less by design. If cookie auth is ever added, the guard tightens
 * automatically.
 */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith('/api/') && !pathname.startsWith('/api/v1/')) {
    const method = req.method.toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const origin = req.headers.get('origin');
      // Requests without Origin (curl, server-to-server) are allowed.
      if (origin) {
        // Collect every host the proxy chain may present as "ours".
        const allowedHosts = new Set<string>();
        const push = (value: string | null) => {
          if (!value) return;
          // X-Forwarded-Host can be a comma-separated list across proxies.
          for (const part of value.split(',')) {
            const host = part.trim().toLowerCase();
            if (host) allowedHosts.add(host);
          }
        };
        push(req.headers.get('host'));
        push(req.headers.get('x-forwarded-host'));

        let originHost: string | null = null;
        try {
          originHost = new URL(origin).host.toLowerCase();
        } catch {
          originHost = null;
        }

        const matchesProxy = originHost !== null && allowedHosts.has(originHost);
        const hasCookies = Boolean(req.headers.get('cookie'));

        if (!matchesProxy && hasCookies) {
          return NextResponse.json(
            { error: { code: 'cross_origin_blocked', message: 'Cross-origin request rejected.' } },
            { status: 403 }
          );
        }
        if (originHost === null) {
          return NextResponse.json(
            { error: { code: 'invalid_origin', message: 'Invalid Origin header.' } },
            { status: 403 }
          );
        }
      }
    }
  }

  const res = NextResponse.next();
  res.headers.set('X-Content-Type-Options', 'nosniff');
  // SAMEORIGIN (not DENY) so the Agent Studio can frame artifact previews
  // served from /api/artifacts/[id]/preview on this same origin.
  res.headers.set('X-Frame-Options', 'SAMEORIGIN');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return res;
}

export const config = {
  matcher: ['/api/:path*'],
};
