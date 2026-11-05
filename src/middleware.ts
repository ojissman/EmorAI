import { NextResponse, type NextRequest } from 'next/server';

/**
 * Lightweight origin guard + security headers.
 * Mutating dashboard API calls must be same-origin (CSRF mitigation for the
 * cookie-less, single-owner installation). The developer API (/api/v1/*) uses
 * Bearer tokens and is exempt.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith('/api/') && !pathname.startsWith('/api/v1/')) {
    const method = req.method.toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const origin = req.headers.get('origin');
      // Requests without Origin (curl, server-to-server) are allowed;
      // cross-origin browser requests are rejected.
      if (origin) {
        const host = req.headers.get('host');
        try {
          const originHost = new URL(origin).host;
          if (host && originHost !== host) {
            return NextResponse.json(
              { error: { code: 'cross_origin_blocked', message: 'Cross-origin request rejected.' } },
              { status: 403 }
            );
          }
        } catch {
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
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return res;
}

export const config = {
  matcher: ['/api/:path*'],
};
