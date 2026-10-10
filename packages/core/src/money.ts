/**
 * Integer-only monetary arithmetic.
 *
 * Every amount in this runtime is a `bigint` count of a currency's minor unit
 * (US cents, JPY yen). Floating point is never used to hold, add, or compare
 * money, because 0.1 + 0.2 !== 0.3 and a budget that drifts by a fraction of a
 * cent is a budget nobody can explain to an auditor.
 *
 * Floating point appears in exactly one place: the provider boundary, where
 * Reap hands us a JSON `number`. `fromMajor` converts that number into minor
 * units by going through its decimal string form, so no binary rounding
 * artefact can leak into a stored balance.
 */

/** Number of minor units per major unit, keyed by ISO 4217 code. */
const MINOR_UNIT_DIGITS: Readonly<Record<string, number>> = {
  // Zero-decimal currencies: the minor unit IS the major unit.
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // Three-decimal currencies.
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};

/** Fallback for any currency not listed above. Most of the world uses 2. */
const DEFAULT_MINOR_UNIT_DIGITS = 2;

export interface Money {
  /** Amount in minor units. Signed, so refunds and deltas are expressible. */
  readonly minor: bigint;
  /** ISO 4217 alphabetic code, always stored uppercase. */
  readonly currency: string;
}

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

/** Minor-unit exponent for a currency. Unknown currencies fall back to 2. */
export function minorUnitDigits(currency: string): number {
  return MINOR_UNIT_DIGITS[currency.toUpperCase()] ?? DEFAULT_MINOR_UNIT_DIGITS;
}

/**
 * Expand a JSON number into an exact decimal string.
 *
 * `String(0.1)` is "0.1", but `String(1e21)` is "1e+21" and
 * `String(0.0000001)` is "1e-7". Both forms have to be handled before the
 * digits can be shifted, otherwise large or tiny amounts would silently parse
 * as garbage.
 */
function expandExponent(raw: string): { sign: '-' | ''; int: string; frac: string } {
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(raw);
  if (!match) throw new MoneyError(`not a decimal number: ${raw}`);

  const sign = match[1] ?? '';
  const int = match[2] ?? '';
  const frac = match[3] ?? '';
  const exp = Number(match[4] ?? '0');
  const digits = int + frac;
  const pointIndex = int.length + exp;

  if (pointIndex <= 0) {
    return { sign: sign as '-' | '', int: '0', frac: '0'.repeat(-pointIndex) + digits };
  }
  if (pointIndex >= digits.length) {
    return { sign: sign as '-' | '', int: digits + '0'.repeat(pointIndex - digits.length), frac: '' };
  }
  return { sign: sign as '-' | '', int: digits.slice(0, pointIndex), frac: digits.slice(pointIndex) };
}

/**
 * Convert a decimal string to minor units without floating point.
 *
 * Fractional digits beyond the currency's precision are rejected rather than
 * rounded. Silently rounding a provider amount is how a charge ends up a cent
 * away from the approved total.
 */
function decimalStringToMinor(value: string, digits: number): bigint {
  const trimmed = value.trim();
  if (trimmed === '') throw new MoneyError('empty amount');

  let sign = 1n;
  let magnitude = trimmed;
  if (magnitude.startsWith('-')) {
    sign = -1n;
    magnitude = magnitude.slice(1);
  } else if (magnitude.startsWith('+')) {
    magnitude = magnitude.slice(1);
  }

  const expanded = /[eE]/.test(magnitude) ? expandExponent(magnitude) : null;
  const int = expanded ? expanded.int : (magnitude.split('.')[0] ?? '');
  const frac = expanded ? expanded.frac : (magnitude.split('.')[1] ?? '');

  if (!/^\d*$/.test(int) || !/^\d*$/.test(frac)) {
    throw new MoneyError(`not a decimal number: ${value}`);
  }
  if (int === '' && frac === '') throw new MoneyError(`not a decimal number: ${value}`);

  if (frac.length > digits) {
    // Allow trailing zeros beyond the precision; reject anything genuinely finer.
    if (!/^0*$/.test(frac.slice(digits))) {
      throw new MoneyError(
        `amount ${value} has more precision than ${digits} decimal places allowed`,
      );
    }
  }

  const padded = frac.padEnd(digits, '0').slice(0, digits);
  return sign * (BigInt(int === '' ? '0' : int) * 10n ** BigInt(digits) + BigInt(padded === '' ? '0' : padded));
}

export function money(minor: bigint, currency: string): Money {
  const code = currency.toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new MoneyError(`invalid currency code: ${currency}`);
  return { minor, currency: code };
}

/** Build a `Money` from a decimal amount in major units, e.g. "129.99". */
export function fromMajor(value: number | string, currency: string): Money {
  const raw = typeof value === 'number' ? String(value) : value;
  const code = currency.toUpperCase();
  const digits = minorUnitDigits(code);
  if (Number.isNaN(Number(raw))) throw new MoneyError(`not a decimal number: ${value}`);
  return money(decimalStringToMinor(raw, digits), code);
}

/**
 * Build a `Money` from an integer that is already denominated in minor units.
 *
 * Used when `REAP_AMOUNT_SEMANTICS=MINOR`. Kept separate from `fromMajor` so the
 * distinction is visible at every call site rather than hidden behind a flag.
 */
export function fromMinor(value: number | bigint, currency: string): Money {
  if (!Number.isSafeInteger(Number(value))) {
    throw new MoneyError(`amount ${value} is not a safe integer in minor units`);
  }
  return money(BigInt(value), currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor + b.minor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor - b.minor, a.currency);
}

/** Ascending comparison: negative when a < b, zero when equal, positive when a > b. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.minor < b.minor) return -1;
  if (a.minor > b.minor) return 1;
  return 0;
}

export const isZero = (a: Money): boolean => a.minor === 0n;
export const isNegative = (a: Money): boolean => a.minor < 0n;
export const isPositive = (a: Money): boolean => a.minor > 0n;
export const negate = (a: Money): Money => money(-a.minor, a.currency);
export const zero = (currency: string): Money => money(0n, currency);

export function sum(amounts: readonly Money[], currency: string): Money {
  const target = currency.toUpperCase();
  return amounts.reduce((acc, m) => add(acc, m), zero(target));
}

/**
 * Multiply by a whole quantity.
 *
 * Exact by construction: minor units are integers, so an integer multiplier
 * cannot introduce rounding. 10.00 USD (1000n) x 3 is exactly 30.00 (3000n),
 * and 0.05 USD (5n) x 3 is exactly 0.15 (15n).
 */
export function multiply(m: Money, quantity: bigint): Money {
  if (quantity < 0n) throw new MoneyError('quantity must not be negative');
  const total = m.minor * quantity;
  // Allocation is only lossy when the unit itself is fractional; otherwise the
  // product is already exact.
  return money(total, m.currency);
}

/** Exact decimal string in major units, e.g. "129.99". Suitable for display. */
export function toMajorString(m: Money): string {
  const digits = minorUnitDigits(m.currency);
  if (digits === 0) return m.minor.toString();
  const negative = m.minor < 0n;
  const abs = negative ? -m.minor : m.minor;
  const scale = 10n ** BigInt(digits);
  const whole = abs / scale;
  const frac = abs % scale;
  const fracText = frac.toString().padStart(digits, '0');
  return `${negative ? '-' : ''}${whole}.${fracText}`;
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

/** JSON shape used by the API and persisted records. */
export interface SerializedMoney {
  amount: string;
  currency: string;
}

export function serialize(m: Money): SerializedMoney {
  return { amount: toMajorString(m), currency: m.currency };
}

export function deserialize(raw: SerializedMoney): Money {
  return fromMajor(raw.amount, raw.currency);
}
