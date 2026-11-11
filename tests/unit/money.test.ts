/// <reference types="bun-types" />
// Pure unit tests for the money module — no server, no DB, no mocks.
// Bun test runner: `bun test tests/unit/money.test.ts`
import { describe, test, expect } from 'bun:test';
import {
  parseDecimalString,
  toScaled,
  addScaled,
  compareScaled,
  formatScaled,
  computeCostMicro,
  microToDecimalString,
  MAX_SCALE,
} from '@/lib/money';

describe('parseDecimalString', () => {
  test('parses plain decimals with their natural scale', () => {
    expect(parseDecimalString('0.001250')).toEqual({ scaled: BigInt(1250), scale: 6 });
    expect(parseDecimalString('1.5')).toEqual({ scaled: BigInt(15), scale: 1 });
    expect(parseDecimalString('1')).toEqual({ scaled: BigInt(1), scale: 0 });
    expect(parseDecimalString('0')).toEqual({ scaled: BigInt(0), scale: 0 });
    expect(parseDecimalString('12.')).toEqual({ scaled: BigInt(12), scale: 0 });
    expect(parseDecimalString('.5')).toEqual({ scaled: BigInt(5), scale: 1 });
  });

  test('parses signed values without losing the sign', () => {
    expect(parseDecimalString('-0.5')).toEqual({ scaled: -BigInt(5), scale: 1 });
    expect(parseDecimalString('+2.25')).toEqual({ scaled: BigInt(225), scale: 2 });
    expect(parseDecimalString('-0')).toEqual({ scaled: BigInt(0), scale: 0 });
  });

  test('trims surrounding whitespace', () => {
    expect(parseDecimalString('  1.50 ')).toEqual({ scaled: BigInt(150), scale: 2 });
  });

  test('rejects invalid or over-precision input with null (never guesses)', () => {
    expect(parseDecimalString('')).toBeNull();
    expect(parseDecimalString('   ')).toBeNull();
    expect(parseDecimalString('abc')).toBeNull();
    expect(parseDecimalString('NaN')).toBeNull();
    expect(parseDecimalString('Infinity')).toBeNull();
    expect(parseDecimalString('.')).toBeNull();
    expect(parseDecimalString('1.2.3')).toBeNull();
    expect(parseDecimalString('1e5')).toBeNull(); // no scientific notation
    expect(parseDecimalString('-')).toBeNull();
    expect(parseDecimalString('1.2345678901234')).toBeNull(); // 13 > MAX_SCALE
    const twelveDigits = '1.' + '0'.repeat(MAX_SCALE);
    expect(parseDecimalString(twelveDigits)).toEqual({ scaled: BigInt(10) ** BigInt(MAX_SCALE), scale: MAX_SCALE });
  });
});

describe('toScaled', () => {
  test('rescales exactly to the requested scale', () => {
    expect(toScaled('1.5', 6)).toBe(BigInt(1500000));
    expect(toScaled('0.001250', 6)).toBe(BigInt(1250));
    expect(toScaled('2', 12)).toBe(BigInt(2000000000000));
    expect(toScaled('1.5', 0)).toBe(BigInt(1)); // truncation toward zero
  });

  test('returns null for unparseable input or invalid scale', () => {
    expect(toScaled('nope', 6)).toBeNull();
    expect(toScaled('1.5', 13)).toBeNull();
    expect(toScaled('1.5', -1)).toBeNull();
    expect(toScaled('1.5', 1.5)).toBeNull();
  });
});

describe('addScaled / compareScaled', () => {
  test('adds exactly across mixed scales', () => {
    expect(addScaled({ scaled: BigInt(150), scale: 2 }, { scaled: BigInt(1250), scale: 6 })).toEqual({
      scaled: BigInt(1501250),
      scale: 6,
    });
    expect(addScaled({ scaled: BigInt(1), scale: 0 }, { scaled: BigInt(1), scale: 0 })).toEqual({ scaled: BigInt(2), scale: 0 });
    expect(addScaled({ scaled: -BigInt(150), scale: 2 }, { scaled: BigInt(50), scale: 2 })).toEqual({ scaled: -BigInt(100), scale: 2 });
  });

  test('compares exactly regardless of representation scale', () => {
    expect(compareScaled({ scaled: BigInt(1500), scale: 6 }, { scaled: BigInt(15), scale: 4 })).toBe(0); // 0.0015 === 0.0015
    expect(compareScaled({ scaled: BigInt(2), scale: 0 }, { scaled: BigInt(15), scale: 6 })).toBe(1);
    expect(compareScaled({ scaled: BigInt(1), scale: 6 }, { scaled: BigInt(2), scale: 0 })).toBe(-1);
    expect(compareScaled({ scaled: BigInt(0), scale: 6 }, { scaled: BigInt(0), scale: 0 })).toBe(0);
  });
});

describe('formatScaled', () => {
  test('renders fixed-precision decimal strings', () => {
    expect(formatScaled(BigInt(1250), 6)).toBe('0.001250');
    expect(formatScaled(BigInt(1500000), 6)).toBe('1.500000');
    expect(formatScaled(BigInt(5), 0)).toBe('5');
    expect(formatScaled(BigInt(0), 6)).toBe('0.000000');
  });

  test('handles negatives and never renders negative zero', () => {
    expect(formatScaled(-BigInt(1250), 6)).toBe('-0.001250');
    expect(formatScaled(-BigInt(0), 6)).toBe('0.000000');
  });
});

describe('computeCostMicro', () => {
  test('tokens × price per MTok in micro units (exact, floored)', () => {
    // 1000 tokens at 1.50/MTok → cost 0.0015 → 1500 micro
    expect(computeCostMicro(1000, '1.50')).toBe(BigInt(1500));
    // 2.5M tokens at 4.00/MTok → cost 10 → 10,000,000 micro
    expect(computeCostMicro(2_500_000, '4.00')).toBe(BigInt(10_000_000));
    // zero tokens cost nothing
    expect(computeCostMicro(0, '5')).toBe(BigInt(0));
    // zero price costs nothing (but is "known")
    expect(computeCostMicro(1000, '0')).toBe(BigInt(0));
  });

  test('floors sub-micro dust — a bill is never rounded UP', () => {
    // 1 token at 0.000001/MTok → exact cost 1e-12 → 1e-6 micro → floored to 0
    expect(computeCostMicro(1, '0.000001')).toBe(BigInt(0));
    // 100 tokens at 0.0000025/MTok → exact 0.00000025 micro... 2.5e-8 cost → floor
    expect(computeCostMicro(100, '0.0000025')).toBe(BigInt(0));
  });

  test('null means unknown — never silently zero', () => {
    expect(computeCostMicro(1000, 'not-a-price')).toBeNull();
    expect(computeCostMicro(1000, '')).toBeNull();
    expect(computeCostMicro(1000, '1e3')).toBeNull();
    expect(computeCostMicro(-5, '1.00')).toBeNull(); // negative tokens are invalid
    expect(computeCostMicro(1.5, '1.00')).toBeNull(); // fractional tokens are invalid
    expect(computeCostMicro(Number.NaN, '1.00')).toBeNull();
  });
});

describe('microToDecimalString', () => {
  test('micro units to decimal string', () => {
    expect(microToDecimalString(BigInt(1250))).toBe('0.001250');
    expect(microToDecimalString(BigInt(0))).toBe('0.000000');
    expect(microToDecimalString(BigInt(10_000_000))).toBe('10.000000');
    expect(microToDecimalString(-BigInt(1250))).toBe('-0.001250');
  });
});

describe('end-to-end exactness (no float drift)', () => {
  test('the classic float-poison sum is exact in micro units', () => {
    // 0.1 + 0.2 === 0.3 exactly: 100000n + 200000n === 300000n
    const a = toScaled('0.1', 6)!;
    const b = toScaled('0.2', 6)!;
    expect(a + b).toBe(BigInt(300000));
    expect(a + b === toScaled('0.3', 6)).toBe(true);
    // and 0.1 + 0.2 !== 0.30000000000000004 in this world
    expect(a + b === toScaled('0.30000000000000004', 6)).toBe(false);
  });
});
