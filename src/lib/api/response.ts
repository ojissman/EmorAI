import { NextResponse } from 'next/server';

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data as object, init);
}

export function fail(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>
): NextResponse {
  return NextResponse.json({ error: { code, message, ...(extra ?? {}) } }, { status });
}

/** Wraps a route handler with consistent 500 handling and error logging. */
export async function handleRoute<T>(fn: () => Promise<T>): Promise<T | NextResponse> {
  try {
    return await fn();
  } catch (e) {
    console.error('[api]', e);
    return fail(500, 'internal_error', 'Something went wrong on the server. Check the server logs for details.');
  }
}
