// ─── Secure outbound fetch for provider destinations ─────────────────────────
// The only sanctioned way EmorAI talks to a provider baseUrl. Wraps global
// fetch with the destination policy from url-policy.ts:
//
//   • pre-flight validation of the target on EVERY hop (fresh DNS — rebinding
//     between config-save time and request time cannot sneak past this)
//   • redirects are NEVER auto-followed; max 3 hops, each re-validated — a
//     redirect to loopback/private/metadata space or an https→http downgrade
//     is refused exactly like a direct connection would be
//   • credentials (authorization / x-api-key / api-key / cookie) never travel
//     to a different host across a redirect hop
//   • hard timeout covering connect+response (combined with the caller signal)
//   • response bodies are wrapped in a byte-counting stream: exceeding the
//     configured cap cancels the upstream body and raises
//     ResponseTooLargeError at read time — nothing is buffered in memory
//
// Errors thrown here are safe to surface to admins: reasons only, no URLs
// with embedded secrets, never a credential.

import { assertProviderUrlAllowed, bareHostname } from './url-policy';

/** Destination rejected by the network policy (SSRF guard). */
export class DestinationBlockedError extends Error {
  reason: string;
  constructor(reason: string, message?: string) {
    super(message ?? `Request destination rejected by network policy (${reason}).`);
    this.name = 'DestinationBlockedError';
    this.reason = reason;
  }
}

/** Upstream response body exceeded the configured byte cap. */
export class ResponseTooLargeError extends Error {
  maxBytes: number;
  constructor(maxBytes: number) {
    super(`Upstream response exceeded the configured cap of ${maxBytes} bytes and was aborted.`);
    this.name = 'ResponseTooLargeError';
    this.maxBytes = maxBytes;
  }
}

export type SecureFetchPolicy = {
  allowlist: string[];
  requireHttps: boolean;
  maxResponseBytes: number;
};

export type SecureFetchOptions = {
  timeoutMs?: number;
  policy: SecureFetchPolicy;
  fetchImpl?: typeof fetch;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_REDIRECT_HOPS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** Headers that must never cross a host boundary on a redirect hop. */
const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'cookie',
  'proxy-authorization',
]);

/** Abort-like failures (AbortError / TimeoutError DOMExceptions). */
export function isAbortLikeError(e: unknown): boolean {
  const name = (e as { name?: string } | null | undefined)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const message = String((e as Error | undefined)?.message ?? '');
  return name === 'DOMException' && /abort|timeout/i.test(message);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function headersToRecord(init: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const headers = new Headers(init.headers ?? undefined);
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function stripCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADERS.has(key)) next[key] = value;
  }
  return next;
}

/** host identity compared across redirect hops — hostname + effective port */
function hostKeyOf(url: URL): string {
  const port = url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80';
  return `${bareHostname(url.hostname)}:${port}`;
}

function combinedSignal(caller: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const timeoutCtor = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout;
  const timeoutSignal: AbortSignal =
    typeof timeoutCtor === 'function'
      ? timeoutCtor(timeoutMs)
      : fallbackTimeoutSignal(timeoutMs);

  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') {
    return caller ? anyFn([caller, timeoutSignal]) : timeoutSignal;
  }
  // manual composition for runtimes without AbortSignal.any
  const controller = new AbortController();
  const link = (source: AbortSignal) => {
    if (source.aborted) {
      controller.abort();
      return;
    }
    source.addEventListener('abort', () => controller.abort(), { once: true });
  };
  if (caller) link(caller);
  link(timeoutSignal);
  return controller.signal;
}

function fallbackTimeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

/**
 * Wraps a response body stream in a byte-counting stream. Bytes flow through
 * unbuffered (chunk-for-chunk); the moment the cumulative count exceeds the
 * cap the upstream body is cancelled and the consumer's read fails with
 * ResponseTooLargeError.
 */
function capBodyStream(source: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let seen = 0;
  let capped = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (capped) {
        controller.close();
        return;
      }
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        controller.error(e);
        return;
      }
      if (chunk.done) {
        controller.close();
        return;
      }
      seen += chunk.value.byteLength;
      if (seen > maxBytes) {
        capped = true;
        // stop the upstream transfer — do not keep pulling a runaway body
        try {
          await reader.cancel(new ResponseTooLargeError(maxBytes));
        } catch {
          // upstream already closed — nothing to cancel
        }
        controller.error(new ResponseTooLargeError(maxBytes));
        return;
      }
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      capped = true;
      return reader.cancel(reason).then(
        () => undefined,
        () => undefined,
      );
    },
  });
}

/** Rebuilds the (possibly redirected) Response with its capped body. */
function finalizeResponse(res: Response, maxBytes: number): Response {
  if (!res.body || NULL_BODY_STATUSES.has(res.status)) {
    return new Response(null, {
      status: res.status,
      statusText: res.statusText,
      headers: new Headers(res.headers),
    });
  }
  return new Response(capBodyStream(res.body, maxBytes) as unknown as BodyInit, {
    status: res.status,
    statusText: res.statusText,
    headers: new Headers(res.headers),
  });
}

// ── secureFetch ──────────────────────────────────────────────────────────────

/**
 * Policy-enforcing fetch. Same signature shape as global fetch plus a policy:
 *
 *   secureFetch(url, init, { timeoutMs, policy, fetchImpl })
 *
 * - the target is validated (fresh DNS) before connecting, and again before
 *   every redirect hop (max 3 hops, all re-validated)
 * - credentials are stripped whenever a hop changes the host
 * - the returned Response carries a size-capped body stream
 * - aborts propagate as AbortError/TimeoutError; policy failures raise
 *   DestinationBlockedError; oversized bodies raise ResponseTooLargeError
 *   at read time
 */
export async function secureFetch(url: string, init: RequestInit, opts: SecureFetchOptions): Promise<Response> {
  const policy = opts.policy;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;

  const callerSignal = (init.signal ?? null) as AbortSignal | null;
  const signal = combinedSignal(callerSignal, timeoutMs);

  let headers = headersToRecord(init);
  let method = (init.method ?? 'GET').toUpperCase();
  let body: BodyInit | undefined = init.body;
  // a streaming body can only be sent once — it cannot follow a 307/308 hop
  const bodyReplayable = !(body instanceof ReadableStream);

  let currentUrl = url;
  let hops = 0;

  for (;;) {
    // pre-flight policy check — fresh DNS resolution on every hop
    const verdict = await assertProviderUrlAllowed(currentUrl, {
      allowlist: policy.allowlist,
      requireHttps: policy.requireHttps,
    });
    if (!verdict.ok) {
      throw new DestinationBlockedError(verdict.reason);
    }

    const current = new URL(currentUrl);
    const fetchInit: RequestInit = {
      method,
      headers,
      redirect: 'manual', // never let the runtime follow redirects for us
      signal,
    };
    if (method !== 'GET' && method !== 'HEAD') {
      fetchInit.body = body;
      if (init.duplex) fetchInit.duplex = init.duplex;
    }

    const res = await doFetch(currentUrl, fetchInit);

    if (!REDIRECT_STATUSES.has(res.status)) {
      return finalizeResponse(res, policy.maxResponseBytes);
    }

    const location = res.headers.get('location');
    if (!location) {
      // 3xx without a Location header — nothing to follow; hand it back
      return finalizeResponse(res, policy.maxResponseBytes);
    }
    // the redirect response body is never interesting — release it
    try {
      await res.body?.cancel();
    } catch {
      // body already gone
    }

    hops += 1;
    if (hops > MAX_REDIRECT_HOPS) {
      throw new DestinationBlockedError('max_redirects', `Redirect chain exceeded ${MAX_REDIRECT_HOPS} hops.`);
    }

    let next: URL;
    try {
      next = new URL(location, currentUrl);
    } catch {
      throw new DestinationBlockedError('invalid_redirect');
    }

    // legacy/browser-compatible method conversion
    if (res.status === 303) {
      method = 'GET';
      body = undefined;
    } else if ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD') {
      method = 'GET';
      body = undefined;
    } else if (res.status === 307 || res.status === 308) {
      if (body !== undefined && !bodyReplayable) {
        throw new Error('secureFetch: cannot replay a streaming request body across a 307/308 redirect.');
      }
    }

    // credentials never travel to a different host (hostname or port)
    if (hostKeyOf(next) !== hostKeyOf(current)) {
      headers = stripCredentialHeaders(headers);
    }

    currentUrl = next.href;
  }
}
