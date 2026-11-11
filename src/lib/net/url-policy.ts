// ─── Destination URL policy (SSRF guard) ──────────────────────────────────────
// Central control over WHICH network destinations EmorAI may connect to for
// provider traffic. Every outbound provider request (OpenAI-compat, Anthropic-
// compat, self-hosted) is validated through this module — both when an admin
// saves a provider account's baseUrl and again right before every connection
// (fresh DNS resolution mitigates rebinding TOCTOU on cached answers).
//
// Policy pillars (fail closed):
//   • scheme: http/https only — nothing else, ever
//   • address classes: loopback, link-local (incl. cloud metadata), private,
//     CGNAT, unique-local, multicast, unspecified, broadcast, reserved are
//     rejected unless the destination is explicitly allowlisted
//   • https required by default; plain http passes only for allowlisted hosts
//     (self-hosted inference behind private networks is the only sanctioned use)
//   • DNS is resolved fresh and EVERY returned address must be clean — an
//     attacker-controlled name that answers with one public + one private A
//     record is still blocked.

import { lookup } from 'node:dns/promises';
import { getSettings } from '@/lib/settings';

export type UrlPolicyResult =
  | { ok: true; resolved: string[] }
  | { ok: false; reason: string };

export type NetworkPolicy = {
  allowlist: string[];
  requireHttps: boolean;
  maxResponseBytes: number;
};

export const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

// ── URL parsing ─────────────────────────────────────────────────────────────

/**
 * Parses a candidate destination URL. Only http(s) schemes survive; the
 * hostname must be present, the port sane, and no user:pass@ credentials.
 */
export function parseTargetUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  const protocol = url.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { ok: false, reason: 'scheme_not_allowed' };
  }
  if (!url.hostname) {
    return { ok: false, reason: 'missing_hostname' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'userinfo_not_allowed' };
  }
  if (url.port !== '') {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, reason: 'invalid_port' };
    }
  }
  return { ok: true, url };
}

/**
 * Normalizes a URL hostname for policy comparisons: lowercase, IPv6 brackets
 * stripped, IPv6 zone ids (%eth0 / %25eth0) dropped. The zone id never changes
 * the address class, so it is ignored for classification purposes.
 */
export function bareHostname(hostname: string): string {
  let h = String(hostname ?? '').trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) {
    h = h.slice(1, -1);
  }
  const zoneIdx = h.indexOf('%');
  if (zoneIdx !== -1) h = h.slice(0, zoneIdx);
  return h;
}

// ── IP parsing & classification ──────────────────────────────────────────────

type IPv4 = [number, number, number, number];

/**
 * Strict, canonical dotted-quad parse. Rejects leading zeros, non-decimal
 * digits, shorthand forms ('127.1'), hex/octal and any inet_aton-style
 * permissiveness — those bypasses are handled before DNS is ever consulted.
 */
function parseIPv4Strict(s: string): IPv4 | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const quad: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    if (p.length > 1 && p.charCodeAt(0) === 48) return null; // non-canonical leading zero
    const v = Number(p);
    if (v > 255) return null;
    quad.push(v);
  }
  return [quad[0], quad[1], quad[2], quad[3]] as IPv4;
}

/** IPv4 address class → block reason, or null when the address is public. */
function classifyIPv4(a: number, b: number, c: number, d: number): string | null {
  if (a === 0) return 'unspecified'; // 0.0.0.0/8 "this" network
  if (a === 10) return 'private'; // 10/8 RFC 1918
  if (a === 127) return 'loopback'; // 127/8
  if (a === 169 && b === 254) return 'link_local'; // 169.254/16 (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return 'private'; // 172.16/12 RFC 1918
  if (a === 192 && b === 168) return 'private'; // 192.168/16 RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat'; // 100.64/10 carrier-grade NAT
  if (a >= 224 && a <= 239) return 'multicast'; // 224/4
  if (a === 255 && b === 255 && c === 255 && d === 255) return 'broadcast';
  if (a >= 240) return 'reserved'; // 240/4 (future use / broadcast range)
  return null;
}

/**
 * Parses an IPv6 literal (brackets and zone ids already stripped) into its
 * 128-bit value. Handles '::' compression and embedded dotted-quad tails
 * (e.g. ::ffff:127.0.0.1). Returns null for anything non-strict.
 */
function parseIPv6(input: string): bigint | null {
  const s = String(input ?? '').trim().toLowerCase().split('%')[0];
  if (!s.includes(':')) return null;

  const firstDbl = s.indexOf('::');
  if (firstDbl !== -1 && s.indexOf('::', firstDbl + 2) !== -1) return null; // ':::' or two '::'

  let head: string[] = [];
  let tail: string[] | null = null;
  let ipv4Tail: IPv4 | null = null;

  if (firstDbl !== -1) {
    const headStr = s.slice(0, firstDbl);
    const tailStr = s.slice(firstDbl + 2);
    head = headStr === '' ? [] : headStr.split(':');
    tail = tailStr === '' ? [] : tailStr.split(':');
    // a dotted quad is only legal as the LAST part of the tail
    if (tail.length > 0 && tail[tail.length - 1].includes('.')) {
      ipv4Tail = parseIPv4Strict(tail[tail.length - 1]);
      if (!ipv4Tail) return null;
      tail = tail.slice(0, -1);
    }
    if (head.some((p) => p.includes('.')) || tail.some((p) => p.includes('.'))) return null;
  } else {
    const parts = s.split(':');
    const last = parts[parts.length - 1];
    if (last.includes('.')) {
      if (parts.length !== 7) return null; // 6 hextets + dotted quad = 8 groups
      ipv4Tail = parseIPv4Strict(last);
      if (!ipv4Tail) return null;
      parts.pop();
    } else if (parts.length !== 8) {
      return null;
    }
    head = parts;
  }

  const hextets: number[] = [];
  for (const p of head.concat(tail ?? [])) {
    if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
    hextets.push(parseInt(p, 16));
  }
  const explicit = hextets.length + (ipv4Tail ? 2 : 0);
  if (firstDbl !== -1 ? explicit > 7 : explicit !== 8) return null;

  let groups: number[];
  if (firstDbl !== -1) {
    const zeros = 8 - explicit;
    groups = [...hextets.slice(0, head.length), ...new Array(zeros).fill(0), ...hextets.slice(head.length)];
  } else {
    groups = [...hextets];
  }
  if (ipv4Tail) {
    groups.push((ipv4Tail[0] << 8) | ipv4Tail[1]);
    groups.push((ipv4Tail[2] << 8) | ipv4Tail[3]);
  }
  if (groups.length !== 8) return null;

  let v = 0n;
  for (const g of groups) v = (v << 16n) | BigInt(g);
  return v;
}

/** IPv6 address class → block reason, or null when the address is public. */
function classifyIPv6(v: bigint): string | null {
  if (v === 0n) return 'unspecified'; // ::
  if (v === 1n) return 'loopback'; // ::1
  const top = Number((v >> 112n) & 0xffffn); // first hextet
  if (top >= 0xfe80 && top <= 0xfebf) return 'link_local'; // fe80::/10
  if ((top & 0xfe00) === 0xfc00) return 'unique_local'; // fc00::/7 (fc00–fdff)
  if ((top & 0xff00) === 0xff00) return 'multicast'; // ff00::/8
  // IPv4-mapped ::ffff:0:0/96 → classify the embedded IPv4 itself
  if (v >> 32n === 0xffffn) {
    const low = v & 0xffffffffn;
    const embedded = classifyIPv4(
      Number((low >> 24n) & 0xffn),
      Number((low >> 16n) & 0xffn),
      Number((low >> 8n) & 0xffn),
      Number(low & 0xffn),
    );
    return embedded ?? 'reserved'; // mapped-but-public still unusable; keep blocked
  }
  // deprecated IPv4-compatible ::/96 (everything else in ::/96) — blocked
  if (v >> 32n === 0n) return 'reserved';
  return null;
}

/**
 * Classifies an IP literal string (IPv4 or IPv6). Anything that is not a
 * strict, canonical IP address is treated as invalid — and therefore blocked.
 * Exported for unit tests and admin-facing diagnostics.
 */
export function isBlockedAddress(ip: string): { blocked: boolean; reason?: string } {
  const s = String(ip ?? '').trim().toLowerCase();
  if (!s) return { blocked: true, reason: 'invalid_address' };
  if (s.includes(':')) {
    const v = parseIPv6(s);
    if (v === null) return { blocked: true, reason: 'invalid_address' };
    const reason = classifyIPv6(v);
    return reason ? { blocked: true, reason } : { blocked: false };
  }
  if (/^[\d.]+$/.test(s)) {
    const quad = parseIPv4Strict(s);
    if (!quad) return { blocked: true, reason: 'invalid_address' };
    const reason = classifyIPv4(quad[0], quad[1], quad[2], quad[3]);
    return reason ? { blocked: true, reason } : { blocked: false };
  }
  return { blocked: true, reason: 'invalid_address' };
}

// ── Hostname resolution ───────────────────────────────────────────────────────

/**
 * Resolves a hostname to the full set of addresses DNS currently reports.
 * IP literals never touch DNS (and are returned verbatim); malformed
 * numeric-looking "hostnames" (octal/hex/shorthand IP bypass attempts) are
 * rejected outright; *.localhost is resolved deterministically to loopback
 * per RFC 6761 so it can never be DNS-waved into something public.
 */
export async function resolveHostAddresses(
  hostname: string,
): Promise<{ ok: true; addresses: string[] } | { ok: false; reason: string }> {
  const host = bareHostname(hostname);
  if (!host) return { ok: false, reason: 'dns_unresolvable' };

  // IPv6-looking literal (brackets already stripped) — validate strictly, no DNS
  if (host.includes(':')) {
    if (parseIPv6(host) === null) return { ok: false, reason: 'invalid_ip_literal' };
    return { ok: true, addresses: [host.split('%')[0]] };
  }

  // IPv4-looking literal — strict canonical parse only; '127.1', '010.0.0.1',
  // '2130706433' and friends are inet_aton bypasses, not hostnames.
  if (/^[\d.]+$/.test(host)) {
    if (parseIPv4Strict(host) === null) return { ok: false, reason: 'invalid_ip_literal' };
    return { ok: true, addresses: [host] };
  }

  // RFC 6761: localhost and *.localhost resolve to loopback — always
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: true, addresses: ['127.0.0.1'] };
  }

  // defensive hostname charset guard (URL parsing already constrains most of this)
  if (!/^[a-z0-9.-]+$/.test(host)) return { ok: false, reason: 'invalid_hostname' };

  try {
    const records = await lookup(host, { all: true });
    if (!Array.isArray(records) || records.length === 0) {
      return { ok: false, reason: 'dns_unresolvable' };
    }
    return { ok: true, addresses: records.map((r) => r.address) };
  } catch {
    // ENOTFOUND / EAI_AGAIN / resolver outage — unresolvable means blocked
    return { ok: false, reason: 'dns_unresolvable' };
  }
}

// ── Allowlist matching ───────────────────────────────────────────────────────

/**
 * Allowlist entries are exact, case-insensitive, trimmed matches of either a
 * bare hostname ("vllm.internal") or hostname:port ("127.0.0.1:3999"). IPv6
 * entries with a port must be bracketed ("[::1]:3999"). A bare-hostname entry
 * covers every port on that host; scheme-default ports (443/80) are treated
 * as equivalent to their explicit spelling.
 */
function allowlistMatches(
  allowlist: string[] | undefined | null,
  host: string,
  urlPort: string,
  scheme: string,
): boolean {
  if (!allowlist || allowlist.length === 0) return false;
  const effectivePort = urlPort !== '' ? urlPort : scheme === 'https:' ? '443' : '80';
  const portMatches = (entryPort: string): boolean =>
    entryPort === urlPort || (urlPort === '' && entryPort === effectivePort);

  for (const rawEntry of allowlist) {
    const e = String(rawEntry ?? '').trim().toLowerCase();
    if (!e) continue;

    if (e.startsWith('[')) {
      // bracketed IPv6: [addr] or [addr]:port
      const close = e.indexOf(']');
      if (close === -1) continue;
      const aHost = e.slice(1, close);
      const rest = e.slice(close + 1);
      if (rest === '') {
        if (aHost === host) return true;
        continue;
      }
      if (!rest.startsWith(':') || !/^\d{1,5}$/.test(rest.slice(1))) continue;
      if (aHost === host && portMatches(rest.slice(1))) return true;
      continue;
    }

    const portEntry = /^([^:]+):(\d{1,5})$/.exec(e);
    if (portEntry && !portEntry[1].includes(':')) {
      // hostname:port (an IPv6 host:port must be bracketed — ambiguous otherwise)
      if (portEntry[1] === host && portMatches(portEntry[2])) return true;
      continue;
    }

    // bare hostname — or a bare (unbracketed) IPv6 literal without a port
    if (e === host) return true;
  }
  return false;
}

// ── The policy gate ──────────────────────────────────────────────────────────

/**
 * Validates a destination URL against the network policy. Runs BOTH at admin
 * config-save time and immediately before every connection (fresh DNS each
 * time). Returns the resolved addresses on success so callers can pin/audit.
 *
 * Order of checks (cheapest & most decisive first):
 *   parse → scheme/https rule → allowlist match → literal guard →
 *   DNS resolution → EVERY resolved address must be clean (unless allowlisted)
 */
export async function assertProviderUrlAllowed(
  rawUrl: string,
  opts?: { allowlist?: string[]; requireHttps?: boolean },
): Promise<UrlPolicyResult> {
  const parsed = parseTargetUrl(rawUrl);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const url = parsed.url;
  const host = bareHostname(url.hostname);
  if (!host) return { ok: false, reason: 'missing_hostname' };

  const requireHttps = opts?.requireHttps !== false; // default: true
  const allowlisted = allowlistMatches(opts?.allowlist, host, url.port, url.protocol);

  // plain http is only acceptable for explicitly allowlisted destinations —
  // private self-hosted http inference must be sanctioned by an admin
  if (url.protocol === 'http:' && requireHttps && !allowlisted) {
    return { ok: false, reason: 'insecure_scheme' };
  }

  // fresh resolution — malformed numeric literals never reach DNS
  const resolved = await resolveHostAddresses(host);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  if (!allowlisted) {
    for (const addr of resolved.addresses) {
      const verdict = isBlockedAddress(addr);
      if (verdict.blocked) return { ok: false, reason: verdict.reason ?? 'blocked_address' };
    }
  }
  return { ok: true, resolved: resolved.addresses };
}

// ── Settings-backed convenience loader ───────────────────────────────────────

let policyMemo: { at: number; value: NetworkPolicy } | null = null;
const POLICY_TTL_MS = 5_000; // per-request settings reads would hammer the row

/**
 * Loads the effective network policy from stored settings (via getSettings()).
 * Fails closed to the strictest defaults if settings cannot be read.
 */
export async function loadNetworkPolicy(): Promise<NetworkPolicy> {
  const now = Date.now();
  if (policyMemo && now - policyMemo.at < POLICY_TTL_MS) {
    return policyMemo.value;
  }
  try {
    const s = await getSettings();
    const net = s?.network;
    const value: NetworkPolicy = {
      allowlist: Array.isArray(net?.allowlist)
        ? net.allowlist.map((e) => String(e).trim()).filter((e) => e.length > 0)
        : [],
      requireHttps: net?.requireHttps !== false,
      maxResponseBytes:
        typeof net?.maxResponseBytes === 'number' && Number.isFinite(net.maxResponseBytes) && net.maxResponseBytes > 0
          ? net.maxResponseBytes
          : DEFAULT_MAX_RESPONSE_BYTES,
    };
    policyMemo = { at: now, value };
    return value;
  } catch {
    // unreadable settings → strictest posture, never fail open
    return { allowlist: [], requireHttps: true, maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES };
  }
}
