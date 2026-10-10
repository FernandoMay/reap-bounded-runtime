import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { fromMajor, toMajorString } from '@bounded/core';
import { MockProvider, MockProviderError } from '../src/mock/provider.ts';
import { createProvider } from '../src/index.ts';
import { defineReapConfig, ConfigurationError, loadReapConfig, loadRuntimeSettings } from '../src/config.ts';

const ADDRESS = {
  firstName: 'Ana',
  lastName: 'Lopez',
  phone: '+525555555555',
  addressLine1: 'Av. Reforma 222',
  addressLine2: 'Interior 4',
  city: 'Ciudad de Mexico',
  region: 'CMX',
  postalCode: '06600',
  country: 'MX',
};

describe('MockProvider — happy path', () => {
  test('searches and returns a usable variant', async () => {
    const provider = new MockProvider();
    const response = await provider.searchProducts({
      query: 'café',
      context: { country: 'MX', currency: 'USD' },
    });
    assert.ok(response.results.length > 0);
    assert.ok(response.results.every((r) => r.previewVariant));
    assert.equal(response.results[0]?.merchantName, 'Blend Station');
  });

  test('prices a quote from the catalog', async () => {
    const provider = new MockProvider();
    const quote = await provider.createQuote({
      items: [{ variantId: 'var_mock_coffee', quantity: 2 }],
      email: 'b@example.com',
      shippingAddress: ADDRESS,
      idempotencyKey: 'k1',
    });
    // 18.50 x 2 + 5.00 shipping + 1.35 tax = 43.35
    assert.equal(toMajorString(quote.amountBreakdown.finalAmount), '43.35');
  });

  test('a checkout starts by waiting on a human, never as paid', async () => {
    const provider = new MockProvider();
    const quote = await provider.createQuote({
      items: [{ variantId: 'var_mock_coffee', quantity: 1 }],
      email: 'b@example.com',
      shippingAddress: ADDRESS,
      idempotencyKey: 'k1',
    });
    const checkout = await provider.createCheckout({
      quoteId: quote.id,
      enrollmentId: 'enr_mock_active',
      returnUrl: 'https://app.example.com/done',
      idempotencyKey: 'k2',
    });
    assert.equal(checkout.status, 'REQUIRES_ACTION');
    assert.ok(checkout.approvalUrl);
    assert.equal(checkout.orderId, undefined);
  });

  test('completes only after an explicit approval', async () => {
    const provider = new MockProvider();
    const quote = await provider.createQuote({
      items: [{ variantId: 'var_mock_coffee', quantity: 1 }],
      email: 'b@example.com',
      shippingAddress: ADDRESS,
      idempotencyKey: 'k1',
    });
    const checkout = await provider.createCheckout({
      quoteId: quote.id,
      enrollmentId: 'enr_mock_active',
      returnUrl: 'https://app.example.com/done',
      idempotencyKey: 'k2',
    });

    const pending = await provider.getCheckout(checkout.id);
    assert.equal(pending.status, 'REQUIRES_ACTION');

    const approved = await provider.approveCheckout(checkout.id);
    assert.equal(approved.status, 'COMPLETED');
    assert.ok(approved.orderId);
    assert.equal(approved.finalAmount?.minor, quote.amountBreakdown.finalAmount.minor);

    const readBack = await provider.getCheckout(checkout.id);
    assert.equal(readBack.status, 'COMPLETED');
  });
});

describe('MockProvider — failure scenarios', () => {
  test('refuses a quote the merchant will not fulfil', async () => {
    const provider = new MockProvider({ scenario: 'merchant_refuses' });
    await assert.rejects(
      provider.createQuote({
        items: [{ variantId: 'var_mock_coffee', quantity: 1 }],
        email: 'b@example.com',
        shippingAddress: ADDRESS,
        idempotencyKey: 'k1',
      }),
      (error: unknown) => {
        assert.ok(error instanceof MockProviderError);
        assert.equal(error.code, 'QUOTE_UNFULFILLABLE');
        assert.equal(error.detail?.['reason'], 'STATE_OR_PROVINCE_REQUIRED');
        return true;
      },
    );
  });

  test('reports 403 when agentic payments is off for the key', async () => {
    const provider = new MockProvider({ scenario: 'not_enabled' });
    await assert.rejects(
      provider.createQuote({ items: [{ variantId: 'var_mock_coffee', quantity: 1 }], email: 'b@e.com', idempotencyKey: 'k' }),
      (error: unknown) => error instanceof MockProviderError && error.httpStatus === 403,
    );
  });

  test('an expired checkout settles as EXPIRED, not FAILED', async () => {
    const provider = new MockProvider({ scenario: 'checkout_expires' });
    const quote = await provider.createQuote({
      items: [{ variantId: 'var_mock_coffee', quantity: 1 }],
      email: 'b@example.com',
      shippingAddress: ADDRESS,
      idempotencyKey: 'k1',
    });
    const checkout = await provider.createCheckout({
      quoteId: quote.id,
      enrollmentId: 'enr_mock_active',
      returnUrl: 'https://app.example.com/done',
      idempotencyKey: 'k2',
    });
    const settled = await provider.approveCheckout(checkout.id);
    assert.equal(settled.status, 'EXPIRED');
  });

  test('a failed charge settles as FAILED', async () => {
    const provider = new MockProvider({ scenario: 'checkout_fails' });
    const quote = await provider.createQuote({
      items: [{ variantId: 'var_mock_coffee', quantity: 1 }],
      email: 'b@example.com',
      shippingAddress: ADDRESS,
      idempotencyKey: 'k1',
    });
    const checkout = await provider.createCheckout({
      quoteId: quote.id,
      enrollmentId: 'enr_mock_active',
      returnUrl: 'https://app.example.com/done',
      idempotencyKey: 'k2',
    });
    const settled = await provider.approveCheckout(checkout.id);
    assert.equal(settled.status, 'FAILED');
  });

  test('an enrollment that is not ACTIVE cannot be charged', async () => {
    const provider = new MockProvider();
    await provider.putEnrollmentRequiresAction('enr_pending');
    const quote = await provider.createQuote({
      items: [{ variantId: 'var_mock_coffee', quantity: 1 }],
      email: 'b@example.com',
      shippingAddress: ADDRESS,
      idempotencyKey: 'k1',
    });
    await assert.rejects(
      provider.createCheckout({
        quoteId: quote.id,
        enrollmentId: 'enr_pending',
        returnUrl: 'https://app.example.com/done',
        idempotencyKey: 'k2',
      }),
      (error: unknown) =>
        error instanceof MockProviderError &&
        error.code === 'AGENTIC_REQUEST_REJECTED' &&
        /REQUIRES_ACTION/.test(error.message) &&
        /not ACTIVE/.test(error.message),
    );
  });

  test('a quote expires after its ttl', async () => {
    let now = 1_000_000;
    const provider = new MockProvider({ quoteTtlMs: 1000, now: () => now });
    const quote = await provider.createQuote({
      items: [{ variantId: 'var_mock_coffee', quantity: 1 }],
      email: 'b@example.com',
      shippingAddress: ADDRESS,
      idempotencyKey: 'k1',
    });
    now += 2000;
    await assert.rejects(
      provider.getQuote(quote.id),
      (error: unknown) => error instanceof MockProviderError && error.code === 'QUOTE_EXPIRED',
    );
  });
});

describe('MockProvider — shipping option repricing', () => {
  test('re-prices when a different shipping option is chosen', async () => {
    const provider = new MockProvider();
    const quote = await provider.createQuote({
      items: [{ variantId: 'var_mock_coffee', quantity: 1 }],
      email: 'b@example.com',
      shippingAddress: ADDRESS,
      idempotencyKey: 'k1',
    });
    // Standard: 18.50 + 5.00 + 1.35 = 24.85
    assert.equal(toMajorString(quote.amountBreakdown.finalAmount), '24.85');

    const express = await provider.selectShippingOption(quote.id, 'shp_express');
    // Express: 18.50 + 12.00 + 1.35 = 31.85
    assert.equal(toMajorString(express.amountBreakdown.finalAmount), '31.85');
    assert.equal(express.shippingOptions.find((o) => o.selected)?.id, 'shp_express');
  });

  test('changes the charged amount, which is why repricing happens before checkout', async () => {
    const provider = new MockProvider();
    const quote = await provider.createQuote({
      items: [{ variantId: 'var_mock_coffee', quantity: 1 }],
      email: 'b@example.com',
      shippingAddress: ADDRESS,
      idempotencyKey: 'k1',
    });
    const express = await provider.selectShippingOption(quote.id, 'shp_express');
    const checkout = await provider.createCheckout({
      quoteId: quote.id,
      enrollmentId: 'enr_mock_active',
      returnUrl: 'https://app.example.com/done',
      idempotencyKey: 'k2',
    });
    assert.equal(checkout.amount.minor, express.amountBreakdown.finalAmount.minor);
  });
});

describe('createProvider', () => {
  test('returns the mock provider when no config is supplied', () => {
    const { provider, mode } = createProvider(undefined);
    assert.equal(provider.kind, 'mock');
    assert.equal(mode, 'mock');
  });

  test('returns the Reap provider when a config is supplied', () => {
    const { provider, mode } = createProvider(
      defineReapConfig({
        baseUrl: 'https://sandbox.api.reap.global',
        apiKey: 'sk_sbx_x',
        version: '2025-02-14',
        timeoutMs: 1000,
        amountSemantics: 'MAJOR',
        mode: 'sandbox',
      }),
    );
    assert.equal(provider.kind, 'sandbox');
    assert.equal(mode, 'sandbox');
  });
});

describe('configuration', () => {
  test('refuses to start without an API key', () => {
    assert.throws(
      () => loadReapConfig({ REAP_BASE_URL: 'https://sandbox.api.reap.global' } as NodeJS.ProcessEnv),
      ConfigurationError,
    );
  });

  test('refuses a simulation header against production', () => {
    assert.throws(
      () =>
        loadReapConfig({
          REAP_BASE_URL: 'https://prod.api.reap.global',
          REAP_API_KEY: 'sk_live_x',
          REAP_SIMULATE_CHECKOUT: 'COMPLETED',
        } as NodeJS.ProcessEnv),
      /must never run against a live environment/,
    );
  });

  test('rejects an unknown amount semantics value', () => {
    assert.throws(
      () =>
        loadReapConfig({
          REAP_BASE_URL: 'https://sandbox.api.reap.global',
          REAP_API_KEY: 'sk_sbx_x',
          REAP_AMOUNT_SEMANTICS: 'PENCE',
        } as NodeJS.ProcessEnv),
      /must be MAJOR or MINOR/,
    );
  });

  test('requires an API token for the runtime itself', () => {
    assert.throws(
      () => loadRuntimeSettings({ RUNTIME_MODE: 'mock' } as NodeJS.ProcessEnv),
      /RUNTIME_API_TOKEN is required/,
    );
  });

  test('refuses a short API token', () => {
    assert.throws(
      () => loadRuntimeSettings({ RUNTIME_MODE: 'mock', RUNTIME_API_TOKEN: 'short' } as NodeJS.ProcessEnv),
      /at least 16 characters/,
    );
  });

  test('sandbox mode requires a Reap key, and says so plainly', () => {
    assert.throws(
      () =>
        loadRuntimeSettings({
          RUNTIME_MODE: 'sandbox',
          RUNTIME_API_TOKEN: 'a'.repeat(32),
        } as NodeJS.ProcessEnv),
      /RUNTIME_MODE=sandbox requires REAP_API_KEY/,
    );
  });

  test('a full mock configuration loads', () => {
    const settings = loadRuntimeSettings({
      RUNTIME_MODE: 'mock',
      RUNTIME_API_TOKEN: 'a'.repeat(32),
    } as NodeJS.ProcessEnv);
    assert.equal(settings.mode, 'mock');
    assert.equal(settings.port, 3001);
  });
});
