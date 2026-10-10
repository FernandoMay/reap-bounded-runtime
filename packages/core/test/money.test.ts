import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  add,
  compare,
  fromMajor,
  fromMinor,
  isNegative,
  isZero,
  money,
  multiply,
  negate,
} from '../src/index.ts';
import { minorUnitDigits, subtract, sum, toMajorString, serialize, deserialize } from '../src/money.ts';

describe('minorUnitDigits', () => {
  test('uses the ISO exponent for zero- and three-decimal currencies', () => {
    assert.equal(minorUnitDigits('USD'), 2);
    assert.equal(minorUnitDigits('EUR'), 2);
    assert.equal(minorUnitDigits('JPY'), 0);
    assert.equal(minorUnitDigits('KRW'), 0);
    assert.equal(minorUnitDigits('KWD'), 3);
    assert.equal(minorUnitDigits('BHD'), 3);
  });

  test('falls back to 2 for currencies outside the table', () => {
    assert.equal(minorUnitDigits('ZZZ'), 2);
  });
});

describe('fromMajor', () => {
  test('parses plain decimals exactly', () => {
    assert.equal(fromMajor('129.99', 'USD').minor, 12999n);
    assert.equal(fromMajor('129', 'USD').minor, 12900n);
    assert.equal(fromMajor('0.01', 'USD').minor, 1n);
    assert.equal(fromMajor(0, 'USD').minor, 0n);
  });

  test('accepts a JSON number without introducing binary rounding error', () => {
    // 142.85 is not representable in binary. The conversion must go through the
    // decimal string form, not through float multiplication.
    assert.equal(fromMajor(142.85, 'USD').minor, 14285n);
    assert.equal(toMajorString(fromMajor(142.85, 'USD')), '142.85');
  });

  test('handles exponent notation from JSON parsers', () => {
    assert.equal(fromMajor('1e3', 'USD').minor, 100000n);
    assert.equal(fromMajor('1.5e2', 'USD').minor, 15000n);
    assert.equal(fromMajor('1e-2', 'USD').minor, 1n);
  });

  test('honours zero-decimal currencies', () => {
    assert.equal(fromMajor('150', 'JPY').minor, 150n);
    assert.equal(toMajorString(fromMajor('150', 'JPY')), '150');
  });

  test('honours three-decimal currencies', () => {
    assert.equal(fromMajor('1.234', 'KWD').minor, 1234n);
  });

  test('rejects sub-precision amounts rather than rounding them', () => {
    // Rounding here would let a charge land a fraction of a cent away from the
    // amount the human approved.
    assert.throws(() => fromMajor('10.005', 'USD'), /precision/);
    // "10.0050" is 10.005: three genuinely significant decimals, still rejected.
    assert.throws(() => fromMajor('10.0050', 'USD'), /precision/);
    // Trailing zeros beyond the currency precision carry no information and
    // are accepted, so padded wire values do not need special handling.
    assert.doesNotThrow(() => fromMajor('10.0000', 'USD'));
    assert.doesNotThrow(() => fromMajor('10.00', 'USD'));
  });

  test('rejects malformed input', () => {
    assert.throws(() => fromMajor('abc', 'USD'), /not a decimal number/);
    assert.throws(() => fromMajor('', 'USD'), /empty amount/);
  });

  test('rejects an invalid currency code', () => {
    assert.throws(() => fromMajor('1', 'DOLLARS'), /invalid currency code/);
  });
});

describe('arithmetic', () => {
  test('addition is exact where float addition is not', () => {
    const a = fromMajor('0.1', 'USD');
    const b = fromMajor('0.2', 'USD');
    assert.notEqual(0.1 + 0.2, 0.3); // the bug this exists to prevent
    assert.equal(add(a, b).minor, 30n);
    assert.equal(toMajorString(add(a, b)), '0.30');
  });

  test('subtraction and comparison work on integers', () => {
    const total = fromMajor('142.00', 'USD');
    const items = fromMajor('129.00', 'USD');
    assert.equal(subtract(total, items).minor, 1300n);
    assert.equal(compare(total, items), 1);
    assert.equal(compare(items, items), 0);
    assert.equal(compare(items, total), -1);
  });

  test('refuses to mix currencies', () => {
    assert.throws(() => add(fromMajor('1', 'USD'), fromMajor('1', 'EUR')), /currency mismatch/);
  });

  test('multiply by a whole quantity stays exact', () => {
    assert.equal(multiply(fromMajor('10.00', 'USD'), 3n).minor, 3000n);
    assert.equal(multiply(fromMajor('0.05', 'USD'), 3n).minor, 15n);
    assert.equal(multiply(fromMajor('0.01', 'USD'), 3n).minor, 3n);
    assert.throws(() => multiply(fromMajor('1', 'USD'), -1n), /must not be negative/);
  });

  test('sum starts from zero in the target currency', () => {
    const total = sum([fromMajor('1.10', 'USD'), fromMajor('2.20', 'USD'), fromMajor('0.05', 'USD')], 'USD');
    assert.equal(total.minor, 335n);
  });

  test('zero and sign helpers', () => {
    assert.ok(isZero(fromMajor('0', 'USD')));
    assert.ok(isNegative(fromMajor('-1', 'USD')));
    assert.ok(!isNegative(fromMajor('1', 'USD')));
  });
});

describe('fromMinor', () => {
  test('treats the input as already denominated in minor units', () => {
    assert.equal(fromMinor(12999, 'USD').minor, 12999n);
    assert.equal(toMajorString(fromMinor(12999, 'USD')), '129.99');
  });

  test('rejects values that are not safe integers', () => {
    assert.throws(() => fromMinor(1.5, 'USD'), /safe integer/);
  });
});

describe('serialisation', () => {
  test('round-trips through the JSON shape', () => {
    const original = fromMajor('129.99', 'USD');
    const restored = deserialize(serialize(original));
    assert.equal(restored.minor, original.minor);
    assert.equal(restored.currency, original.currency);
  });

  test('serialised amount is a string, never a float', () => {
    const wire = serialize(fromMajor('142.85', 'USD'));
    assert.equal(typeof wire.amount, 'string');
    assert.equal(wire.amount, '142.85');
  });

  test('preserves negative amounts for ledger entries', () => {
    assert.equal(toMajorString(negate(fromMajor('5.00', 'USD'))), '-5.00');
  });
});

describe('money', () => {
  test('uppercases the currency code', () => {
    assert.equal(money(100n, 'usd').currency, 'USD');
  });
});
