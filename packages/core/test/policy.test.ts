import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalDomain,
  evaluatePolicy,
  fromMajor,
  validateIntent,
  type PolicyContext,
} from '../src/index.ts';
import type { Merchant, Policy, PurchaseIntent } from '../src/types.ts';

const merchant: Merchant = { name: 'Blend Station', domain: 'shop.blendstation.com', country: 'MX' };

const intent = (overrides: Partial<PurchaseIntent> = {}): PurchaseIntent => ({
  items: [{ variantId: 'var_1', productId: 'prd_1', productName: 'Coffee', quantity: 1 }],
  email: 'buyer@example.com',
  ...overrides,
});

const policy = (overrides: Partial<Policy> = {}): Policy => ({
  maxAmountPerPurchase: fromMajor('50.00', 'USD'),
  allowedCurrencies: ['USD'],
  merchantAllowlist: ['shop.blendstation.com'],
  ...overrides,
});

const context = (overrides: Partial<PolicyContext> = {}): PolicyContext => ({
  policy: policy(),
  requestedAmount: fromMajor('12.31', 'USD'),
  merchant,
  ...overrides,
});

describe('validateIntent', () => {
  test('accepts a well-formed intent', () => {
    assert.equal(validateIntent(intent()), null);
  });

  test('rejects an empty cart', () => {
    assert.equal(validateIntent(intent({ items: [] }))?.code, 'INVALID_REQUEST');
  });

  test("enforces Reap's documented 20-item cap", () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      variantId: `var_${i}`,
      productId: `prd_${i}`,
      productName: 'Item',
      quantity: 1,
    }));
    assert.match(validateIntent(intent({ items: many }))?.message ?? '', /at most 20 items/);
  });

  test('rejects non-integer and non-positive quantities', () => {
    const bad = (quantity: number) =>
      validateIntent(
        intent({ items: [{ variantId: 'v', productId: 'p', productName: 'n', quantity }] }),
      );
    assert.equal(bad(0)?.code, 'INVALID_REQUEST');
    assert.equal(bad(-1)?.code, 'INVALID_REQUEST');
    assert.equal(bad(1.5)?.code, 'INVALID_REQUEST');
    assert.equal(bad(1), null);
  });

  test("enforces Reap's documented email pattern", () => {
    assert.equal(validateIntent(intent({ email: 'nope' }))?.code, 'INVALID_REQUEST');
    assert.equal(validateIntent(intent({ email: 'a..b@example.com' }))?.code, 'INVALID_REQUEST');
    assert.equal(validateIntent(intent({ email: 'buyer@example.com' })), null);
  });

  test("enforces Reap's documented E.164 phone pattern", () => {
    const withPhone = (phone: string) =>
      validateIntent(
        intent({
          shippingAddress: {
            firstName: 'Ana',
            lastName: 'Lopez',
            phone,
            addressLine1: 'Av. Reforma 222',
            city: 'Ciudad de Mexico',
            country: 'MX',
          },
        }),
      );
    assert.equal(withPhone('+525555555555'), null);
    assert.equal(withPhone('5551234567')?.code, 'INVALID_REQUEST'); // no plus sign
    assert.equal(withPhone('+0525555555')?.code, 'INVALID_REQUEST'); // leading zero
  });

  test('requires an ISO alpha-2 country', () => {
    const withCountry = (country: string) =>
      validateIntent(
        intent({
          shippingAddress: {
            firstName: 'Ana',
            lastName: 'Lopez',
            phone: '+525555555555',
            addressLine1: 'Av. Reforma 222',
            city: 'Ciudad de Mexico',
            country,
          },
        }),
      );
    // ISO 3166-1 alpha-2 is two letters. "MEX" is the alpha-3 code and is wrong.
    assert.equal(withCountry('MX'), null);
    assert.equal(withCountry('US'), null);
    assert.equal(withCountry('MEX')?.code, 'INVALID_REQUEST');
    assert.equal(withCountry('Mexico')?.code, 'INVALID_REQUEST');
  });
});

describe('evaluatePolicy — allowing', () => {
  test('allows a purchase inside every limit', () => {
    const decision = evaluatePolicy(context());
    assert.equal(decision.allowed, true);
    assert.ok(decision.outcomes.length >= 3);
  });

  test('allows an amount exactly equal to the ceiling', () => {
    const decision = evaluatePolicy(
      context({ requestedAmount: fromMajor('50.00', 'USD') }),
    );
    assert.equal(decision.allowed, true);
  });

  test('compares on integers, so a hair over the limit is refused', () => {
    const decision = evaluatePolicy(
      context({ requestedAmount: fromMajor('50.01', 'USD') }),
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, 'AMOUNT_EXCEEDS_LIMIT');
  });

  test('normalises the merchant domain before comparing', () => {
    const decision = evaluatePolicy(
      context({ merchant: { name: 'X', domain: 'WWW.Shop.BlendStation.com' } }),
    );
    assert.equal(decision.allowed, true);
  });
});

describe('evaluatePolicy — refusing', () => {
  test('refuses an over-limit amount', () => {
    const decision = evaluatePolicy(context({ requestedAmount: fromMajor('500.00', 'USD') }));
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, 'AMOUNT_EXCEEDS_LIMIT');
  });

  test('refuses a merchant that is not on the allowlist', () => {
    const decision = evaluatePolicy(
      context({ merchant: { name: 'Elsewhere', domain: 'evil.example.com' } }),
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, 'MERCHANT_NOT_ALLOWED');
  });

  test('fails closed when the merchant is unknown', () => {
    const decision = evaluatePolicy(context({ merchant: undefined }));
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, 'MERCHANT_NOT_ALLOWED');
  });

  test('fails closed when the allowlist is empty', () => {
    const decision = evaluatePolicy(context({ policy: policy({ merchantAllowlist: [] }) }));
    assert.equal(decision.allowed, false);
  });

  test('refuses a currency outside the permitted set', () => {
    const decision = evaluatePolicy(context({ requestedAmount: fromMajor('10.00', 'EUR') }));
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, 'CURRENCY_NOT_ALLOWED');
  });

  test('refuses a negative amount', () => {
    const decision = evaluatePolicy(context({ requestedAmount: fromMajor('-1.00', 'USD') }));
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, 'INVALID_REQUEST');
  });
});

describe('evaluatePolicy — cumulative budget', () => {
  // The per-purchase ceiling is raised so that the cumulative budget is the only
  // binding constraint; otherwise these cases would trip AMOUNT_EXCEEDS_LIMIT
  // first and prove nothing about budget accounting.
  const withBudget = (overrides: Partial<PolicyContext> = {}) =>
    context({
      policy: policy({
        maxAmountPerPurchase: fromMajor('1000.00', 'USD'),
        budget: fromMajor('100.00', 'USD'),
        budgetWindow: 'MONTH',
      }),
      budget: { settled: fromMajor('0.00', 'USD'), reserved: fromMajor('0.00', 'USD') },
      ...overrides,
    });

  test('allows a purchase that fits the budget', () => {
    const decision = evaluatePolicy(withBudget());
    assert.equal(decision.allowed, true);
  });

  test('allows a purchase that lands exactly on the budget', () => {
    const decision = evaluatePolicy(
      withBudget({
        requestedAmount: fromMajor('100.00', 'USD'),
        budget: { settled: fromMajor('0.00', 'USD'), reserved: fromMajor('0.00', 'USD') },
      }),
    );
    assert.equal(decision.allowed, true);
  });

  test('refuses a purchase that would overrun the budget', () => {
    const decision = evaluatePolicy(
      withBudget({
        requestedAmount: fromMajor('60.00', 'USD'),
        budget: { settled: fromMajor('50.00', 'USD'), reserved: fromMajor('0.00', 'USD') },
      }),
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, 'BUDGET_EXCEEDED');
  });

  test('counts in-flight reservations as committed spend', () => {
    // This is the concurrency case. Two purchases each of 60 against a 100
    // budget: both would pass a settled-only check and together overrun it.
    const decision = evaluatePolicy(
      withBudget({
        requestedAmount: fromMajor('60.00', 'USD'),
        budget: { settled: fromMajor('0.00', 'USD'), reserved: fromMajor('50.00', 'USD') },
      }),
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, 'BUDGET_EXCEEDED');
  });

  test('denies by default when a budget is set but usage cannot be read', () => {
    const decision = evaluatePolicy(
      context({ policy: policy({ budget: fromMajor('100.00', 'USD') }), budget: undefined }),
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, 'POLICY_UNAVAILABLE');
  });
});

describe('evaluatePolicy — reporting', () => {
  test('reports every rule, not just the failing one', () => {
    const decision = evaluatePolicy(
      context({
        requestedAmount: fromMajor('500.00', 'EUR'),
        merchant: { name: 'X', domain: 'other.example.com' },
      }),
    );
    assert.equal(decision.allowed, false);
    const rules = decision.outcomes.map((o) => o.rule);
    assert.ok(rules.includes('currency_allowed'));
    assert.ok(rules.includes('merchant_allowed'));
    assert.ok(rules.includes('max_amount_per_purchase'));
    assert.ok(decision.outcomes.some((o) => !o.passed));
  });

  test('reports the most actionable denial first', () => {
    // Currency and merchant are both wrong; currency is the more fundamental
    // problem and is what the operator should fix first.
    const decision = evaluatePolicy(
      context({
        requestedAmount: fromMajor('10.00', 'EUR'),
        merchant: { name: 'X', domain: 'other.example.com' },
      }),
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, 'CURRENCY_NOT_ALLOWED');
  });

  test('every denial carries a machine-readable code and a message', () => {
    const decision = evaluatePolicy(context({ requestedAmount: fromMajor('999.00', 'USD') }));
    assert.equal(decision.allowed, false);
    if (!decision.allowed) {
      assert.match(decision.code, /^[A-Z_]+$/);
      assert.ok(decision.message.length > 0);
    }
  });
});

describe('evaluatePolicy — never throws', () => {
  // A policy engine that raises instead of deciding hands the request to
  // whatever catches it, and nothing catches it. Every path must terminate in a
  // structured allow or deny.

  test('denies when the budget ceiling is in another currency', () => {
    const decision = evaluatePolicy(
      context({ requestedAmount: fromMajor('10.00', 'EUR') }),
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, 'CURRENCY_NOT_ALLOWED');
  });

  test('denies when the budget snapshot mixes currencies', () => {
    const decision = evaluatePolicy(
      context({
        policy: policy({
          maxAmountPerPurchase: fromMajor('1000.00', 'USD'),
          budget: fromMajor('100.00', 'USD'),
        }),
        requestedAmount: fromMajor('10.00', 'USD'),
        budget: { settled: fromMajor('1.00', 'USD'), reserved: fromMajor('1.00', 'EUR') },
      }),
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, 'POLICY_UNAVAILABLE');
  });

  test('denies rather than throwing on a structurally broken context', () => {
    // A policy that survived deserialisation with a non-string domain: the
    // allowlist comparison cannot run, so the engine must deny.
    const decision = evaluatePolicy({
      policy: policy(),
      requestedAmount: fromMajor('1.00', 'USD'),
      merchant: { name: 'X', domain: null as unknown as string },
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, 'POLICY_UNAVAILABLE');
  });

  test('the fail-closed message does not leak the raw fault', () => {
    const decision = evaluatePolicy({
      policy: { maxAmountPerPurchase: fromMajor('10.00', 'USD') },
      requestedAmount: fromMajor('1.00', 'USD'),
      merchant: undefined,
    });
    const text = JSON.stringify(decision);
    assert.ok(!text.includes('sk_'));
  });
});

describe('canonicalDomain', () => {
  test('lowercases and strips a leading www', () => {
    assert.equal(canonicalDomain('  WWW.Example.COM '), 'example.com');
    assert.equal(canonicalDomain('shop.example.com'), 'shop.example.com');
  });
});
