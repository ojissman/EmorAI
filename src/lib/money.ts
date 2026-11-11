// ─── Money arithmetic (decimal strings → BigInt, NEVER floats) ───────────────
// Phase 10 Priority 4. All cost/budget math goes through this module so no
// IEEE-754 float ever touches a monetary amount:
//
//   • Amounts travel as decimal STRINGS ("0.001250") and are converted to
//     { scaled: bigint, scale: number } (scaled = value × 10^scale) for exact
//     arithmetic. Scale (decimal places) is capped at 12.
//   • Sub-micro dust (below 10^-6 currency units) is floored, never rounded
//     up — a request can never be billed more than the exact price implies.
//   • Unknown/unparseable inputs return null — callers must treat null as
//     "unknown", never as zero.
//
// Pure module: no DB, no server, no imports — fully unit-testable.

/** A decimal amount as an exact integer mantissa with its decimal scale. */
export type ScaledDecimal = {
  /** value × 10^scale (always an exact integer) */
  scaled: bigint;
  /** number of decimal places, 0..MAX_SCALE */
  scale: number;
};

/** Maximum supported decimal places. */
export const MAX_SCALE = 12;

/** Micro-unit scale: 10^-6 currency units (CostLedger's storage precision). */
export const MICRO_SCALE = 6;

// 10^k lookup for k = 0..MAX_SCALE (BigInt powers of ten).
const POW10: readonly bigint[] = (() => {
  const out: bigint[] = [BigInt(1)];
  for (let i = 1; i <= MAX_SCALE; i++) out.push(out[i - 1] * BigInt(10));
  return out;
})();

/**
 * Parses a decimal string into an exact scaled value.
 * Accepted: optional sign, "1", "1.5", "1.", ".5", "+0.25", "-2".
 * Rejected (returns null): empty/whitespace-only, no digits ("." / "+"),
 * multiple dots, scientific notation ("1e5"), NaN/Infinity, non-numeric
 * garbage, or more than MAX_SCALE decimal places (scale > 12 never silently
 * truncates — that would be hidden money loss).
 */
export function parseDecimalString(s: string): ScaledDecimal | null {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (trimmed.length === 0) return null;
  // sign? (digits[.digits] | .digits) — exactly one optional dot
  const m = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(trimmed);
  if (!m) return null;
  const [, sign, intPart, fracPart, fracOnly] = m;
  const frac = fracPart ?? fracOnly ?? '';
  if (frac.length > MAX_SCALE) return null;
  const digits = (intPart ?? '') + frac;
  if (digits.length === 0) return null;
  const negative = sign === '-';
  let scaled = BigInt(digits.length === 0 ? '0' : digits);
  if (negative && scaled !== BigInt(0)) scaled = -scaled;
  return { scaled, scale: frac.length };
}

/**
 * Rescales a decimal string to EXACTLY `scale` decimal places.
 * Up-rescaling is exact. Down-rescaling truncates toward zero (documented —
 * it only ever happens for prices carrying more precision than the target,
 * and truncation keeps a bill ≤ the exact price).
 * Returns null for unparseable input or an invalid target scale.
 */
export function toScaled(amountStr: string, scale: number): bigint | null {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) return null;
  const parsed = parseDecimalString(amountStr);
  if (!parsed) return null;
  if (parsed.scale === scale) return parsed.scaled;
  if (parsed.scale < scale) return parsed.scaled * POW10[scale - parsed.scale];
  return parsed.scaled / POW10[parsed.scale - scale]; // BigInt division truncates
}

/** Exact addition; result uses the larger of the two scales. */
export function addScaled(a: ScaledDecimal, b: ScaledDecimal): ScaledDecimal {
  if (a.scale === b.scale) return { scaled: a.scaled + b.scaled, scale: a.scale };
  if (a.scale > b.scale) {
    return { scaled: a.scaled + b.scaled * POW10[a.scale - b.scale], scale: a.scale };
  }
  return { scaled: a.scaled * POW10[b.scale - a.scale] + b.scaled, scale: b.scale };
}

/** Exact comparison: -1 (a<b), 0 (a==b), 1 (a>b). */
export function compareScaled(a: ScaledDecimal, b: ScaledDecimal): number {
  if (a.scale === b.scale) {
    if (a.scaled < b.scaled) return -1;
    if (a.scaled > b.scaled) return 1;
    return 0;
  }
  if (a.scale > b.scale) {
    const bAligned = b.scaled * POW10[a.scale - b.scale];
    if (a.scaled < bAligned) return -1;
    if (a.scaled > bAligned) return 1;
    return 0;
  }
  const aAligned = a.scaled * POW10[b.scale - a.scale];
  if (aAligned < b.scaled) return -1;
  if (aAligned > b.scaled) return 1;
  return 0;
}

/**
 * Renders a scaled value as a fixed-precision decimal string.
 * formatScaled(1250n, 6) === "0.001250". Negative zero renders unsigned
 * ("0.000000"). Invalid scales are clamped to 0 — this function never throws
 * (it renders final stored values, it must not be able to fail).
 */
export function formatScaled(scaled: bigint, scale: number): string {
  const s = Number.isInteger(scale) && scale > 0 ? Math.min(scale, MAX_SCALE) : 0;
  const neg = scaled < BigInt(0);
  const abs = neg ? -scaled : scaled;
  const divisor = s > 0 ? POW10[s] : BigInt(1);
  const intPart = abs / divisor;
  const fracPart = abs % divisor;
  const fracStr = s > 0 ? `.${fracPart.toString().padStart(s, '0')}` : '';
  const sign = neg && abs !== BigInt(0) ? '-' : '';
  return `${sign}${intPart.toString()}${fracStr}`;
}

/**
 * Cost of `tokens` at `pricePerMTokStr` (price is per 1,000,000 tokens),
 * expressed in MICRO currency units (10^-6), computed EXACTLY with BigInt:
 *
 *     cost        = tokens × price / 1_000_000   (currency units)
 *     micro-units = cost × 1_000_000 = tokens × price
 *
 * Sub-micro dust is floored (BigInt division truncates toward zero — prices
 * are non-negative here), so a bill is never inflated by rounding.
 *
 * Returns null when the price string is unparseable or tokens are invalid
 * (negative / non-finite) — unknown stays unknown, never zero.
 */
export function computeCostMicro(tokens: number, pricePerMTokStr: string): bigint | null {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || !Number.isInteger(tokens) || tokens < 0) return null;
  const price = parseDecimalString(pricePerMTokStr);
  if (!price || price.scaled < BigInt(0)) return null;
  // micro = tokens × price.scaled / 10^price.scale  (exact, floored)
  return (BigInt(tokens) * price.scaled) / POW10[price.scale];
}

/** Micro units (10^-6) → decimal string, e.g. 1250n → "0.001250". */
export function microToDecimalString(micro: bigint): string {
  return formatScaled(micro, MICRO_SCALE);
}
