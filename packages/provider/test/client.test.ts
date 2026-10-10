import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ReapApiError, ReapProtocolError, ReapTransportError, toMajorString } from '@bounded/core';
import { defineReapConfig, isProductionHost, type ReapConfig } from '../src/config.ts';
import { ReapClient, ReapTimeoutError } from '../src/http.ts';
import { ReapAgenticProvider } from '../src/reap/client.ts';

/**
 * Every response body below is transcribed from the published Reap OpenAPI, so
 * these tests fail if the client stops matching the real contract — not merely
 * if it stops matching itself.
 */

const CONFIG: ReapConfig = defineReapConfig({
  baseUrl: 'https://sandbox.api.reap.global',
  apiKey: 'sk_sbx_test_key_not_real',
  version: '2025-02-14',
  timeoutMs: 500,
  amountSemantics: 'MAJOR',
  mode: 'sandbox',
});

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function stubFetch(
  responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!response) throw new Error('no stub response configured');
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'Content-Type': 'application/json', ...(response.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function providerWith(fetchImpl: typeof fetch, config: ReapConfig = CONFIG): ReapAgenticProvider {
  return new ReapAgenticProvider(config, new ReapClient(config, undefined, fetchImpl));
}

const QUOTE_RESPONSE = {
  id: 'qte_abc123',
  shippingOptions: [
    { id: 'shp_standard', name: 'Standard', selected: true, price: { amount: 5, currency: 'USD' } },
    { id: 'shp_express', name: 'Express', selected: false, price: { amount: 13, currency: 'USD' } },
  ],
  amountBreakdown: {
    itemsSubtotal: { amount: 18.5, currency: 'USD' },
    shipping: { amount: 5, currency: 'USD' },
    tax: { amount: { amount: 1.35, currency: 'USD' }, includedInPrices: false },
    discounts: [],
    additionalCharges: [],
    finalAmount: { amount: 24.85, currency: 'USD' },
  },
  expiresAt: '2026-10-10T03:00:00.000Z',
};

const CHECKOUT_PENDING = {
  id: 'cko_abc123',
  status: 'REQUIRES_ACTION',
  quoteId: 'qte_abc123',
  enrollmentId: 'enr_abc123',
  amount: { amount: 24.85, currency: 'USD' },
  nextAction: { type: 'REDIRECT', url: 'https://prava.reap.global/approve/cko_abc123', expiresAt: '2026-10-10T03:30:00.000Z' },
};

describe('request shape', () => {
  test('sends auth, version and idempotency headers', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: QUOTE_RESPONSE }]);
    await providerWith(fetchImpl).createQuote({
      items: [{ variantId: 'var_1', quantity: 1 }],
      email: 'buyer@example.com',
      idempotencyKey: '56B86D75-49EC-462C-B365-20009D554FAC',
    });

    const headers = calls[0]?.init?.headers as Record<string, string>;
    assert.equal(headers['Reap-Version'], '2025-02-14');
    assert.equal(headers['Idempotency-Key'], '56B86D75-49EC-462C-B365-20009D554FAC');
    assert.equal(headers['Content-Type'], 'application/json');
    assert.match(headers['Authorization'] ?? '', /^Bearer sk_/);
  });

  test('targets the documented quote path', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: QUOTE_RESPONSE }]);
    await providerWith(fetchImpl).createQuote({
      items: [{ variantId: 'var_1', quantity: 1 }],
      email: 'b@example.com',
      idempotencyKey: 'k1',
    });
    assert.equal(calls[0]?.url, 'https://sandbox.api.reap.global/agentic/quotes');
  });

  test('omits the idempotency header on reads, where Reap does not want one', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: CHECKOUT_PENDING }]);
    await providerWith(fetchImpl).getCheckout('cko_abc123');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    assert.equal(headers['Idempotency-Key'], undefined);
  });

  test('never sends the simulation header when it is not configured', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: CHECKOUT_PENDING }]);
    await providerWith(fetchImpl).getCheckout('cko_abc123');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    assert.equal(headers['X-Simulate-Checkout'], undefined);
  });

  test('sends the simulation header when sandbox simulation is configured', async () => {
    const config = defineReapConfig({ ...CONFIG, simulateCheckout: 'COMPLETED' });
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: CHECKOUT_PENDING }]);
    await providerWith(fetchImpl, config).getCheckout('cko_abc123');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    assert.equal(headers['X-Simulate-Checkout'], 'COMPLETED');
  });
});

describe('shipping address serialisation', () => {
  test('uses "region" and never "state"', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: QUOTE_RESPONSE }]);
    await providerWith(fetchImpl).createQuote({
      items: [{ variantId: 'var_1', quantity: 1 }],
      email: 'b@example.com',
      idempotencyKey: 'k1',
      shippingAddress: {
        firstName: 'Ana',
        lastName: 'Lopez',
        phone: '+525555555555',
        addressLine1: 'Av. Reforma 222',
        addressLine2: 'Interior 4',
        city: 'Ciudad de Mexico',
        region: 'CMX',
        postalCode: '06600',
        country: 'MX',
      },
    });

    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      shippingAddress: Record<string, unknown>;
    };
    assert.equal(body.shippingAddress['region'], 'CMX');
    assert.equal(body.shippingAddress['state'], undefined);
    assert.equal(body.shippingAddress['addressLine2'], 'Interior 4');
  });

  test('omits optional address lines rather than sending empty strings', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: QUOTE_RESPONSE }]);
    await providerWith(fetchImpl).createQuote({
      items: [{ variantId: 'var_1', quantity: 1 }],
      email: 'b@example.com',
      idempotencyKey: 'k1',
      shippingAddress: {
        firstName: 'A',
        lastName: 'B',
        phone: '+14155550123',
        addressLine1: '1 Market St',
        city: 'San Francisco',
        country: 'US',
      },
    });
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      shippingAddress: Record<string, unknown>;
    };
    assert.equal(body.shippingAddress['addressLine2'], undefined);
    assert.equal(body.shippingAddress['region'], undefined);
  });

  test('never sends an address when none was given', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: QUOTE_RESPONSE }]);
    await providerWith(fetchImpl).createQuote({
      items: [{ variantId: 'var_1', quantity: 1 }],
      email: 'b@example.com',
      idempotencyKey: 'k1',
    });
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    assert.equal(body['shippingAddress'], undefined);
  });
});

describe('amount parsing', () => {
  test('reads a major-unit amount without float error', async () => {
    const { fetchImpl } = stubFetch([{ status: 200, body: QUOTE_RESPONSE }]);
    const quote = await providerWith(fetchImpl).createQuote({
      items: [{ variantId: 'var_1', quantity: 1 }],
      email: 'b@example.com',
      idempotencyKey: 'k1',
    });
    assert.equal(toMajorString(quote.amountBreakdown.finalAmount), '24.85');
    assert.equal(quote.amountBreakdown.finalAmount.minor, 2485n);
  });

  test('reads a minor-unit amount when configured that way', async () => {
    const config = defineReapConfig({ ...CONFIG, amountSemantics: 'MINOR' });
    const { fetchImpl } = stubFetch([{ status: 200, body: QUOTE_RESPONSE }]);
    const quote = await providerWith(fetchImpl, config).createQuote({
      items: [{ variantId: 'var_1', quantity: 1 }],
      email: 'b@example.com',
      idempotencyKey: 'k1',
    });
    assert.equal(quote.amountBreakdown.finalAmount.minor, 2485n);
  });

  test('rejects a quote whose finalAmount is missing', async () => {
    const broken = { ...QUOTE_RESPONSE, amountBreakdown: { itemsSubtotal: { amount: 1, currency: 'USD' } } };
    const { fetchImpl } = stubFetch([{ status: 200, body: broken }]);
    await assert.rejects(
      providerWith(fetchImpl).createQuote({ items: [{ variantId: 'v', quantity: 1 }], email: 'b@e.com', idempotencyKey: 'k' }),
      ReapProtocolError,
    );
  });
});

describe('checkout mapping', () => {
  test('preserves the approval URL and REQUIRES_ACTION status', async () => {
    const { fetchImpl } = stubFetch([{ status: 200, body: CHECKOUT_PENDING }]);
    const checkout = await providerWith(fetchImpl).getCheckout('cko_abc123');
    assert.equal(checkout.status, 'REQUIRES_ACTION');
    assert.equal(checkout.approvalUrl, 'https://prava.reap.global/approve/cko_abc123');
    assert.equal(checkout.orderId, undefined);
    assert.equal(checkout.finalAmount, undefined);
  });

  test('surfaces orderId and finalAmount only once completed', async () => {
    const completed = {
      ...CHECKOUT_PENDING,
      status: 'COMPLETED',
      orderId: 'ord_01M4HWYGR6SK4RZ4NJZGR98WH5',
      finalAmount: { amount: 24.85, currency: 'USD' },
      nextAction: null,
    };
    const { fetchImpl } = stubFetch([{ status: 200, body: completed }]);
    const checkout = await providerWith(fetchImpl).getCheckout('cko_abc123');
    assert.equal(checkout.status, 'COMPLETED');
    assert.equal(checkout.orderId, 'ord_01M4HWYGR6SK4RZ4NJZGR98WH5');
    assert.equal(toMajorString(checkout.finalAmount!), '24.85');
    assert.equal(checkout.approvalUrl, undefined);
  });

  test('sends the enrollment and return URL on create', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: CHECKOUT_PENDING }]);
    await providerWith(fetchImpl).createCheckout({
      quoteId: 'qte_abc123',
      enrollmentId: 'enr_abc123',
      returnUrl: 'https://app.example.com/orders/done',
      idempotencyKey: 'cko-key-1',
    });
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    assert.equal(body['enrollmentId'], 'enr_abc123');
    assert.deepEqual(body['presentation'], {
      type: 'REDIRECT',
      returnUrl: 'https://app.example.com/orders/done',
    });
  });
});

describe('error mapping', () => {
  test('maps a 400 QUOTE_UNFULFILLABLE with its reason and remedy', async () => {
    const { fetchImpl } = stubFetch([
      {
        status: 400,
        body: {
          error: {
            code: 'QUOTE_UNFULFILLABLE',
            message: 'The merchant cannot fulfill this quote as requested',
            detail: { reason: 'STATE_OR_PROVINCE_REQUIRED', message: 'Select a state / province' },
          },
        },
      },
    ]);

    await assert.rejects(
      providerWith(fetchImpl).createQuote({ items: [{ variantId: 'v', quantity: 1 }], email: 'b@e.com', idempotencyKey: 'k' }),
      (error: unknown) => {
        assert.ok(error instanceof ReapApiError);
        assert.equal(error.code, 'QUOTE_UNFULFILLABLE');
        assert.equal(error.retryable, false);
        assert.equal(error.recovery, 'CORRECT_REQUEST');
        assert.match(error.remedy, /shippingAddress\.region/);
        return true;
      },
    );
  });

  test('maps a 503 with Retry-After as retryable', async () => {
    const { fetchImpl } = stubFetch([
      {
        status: 503,
        headers: { 'Retry-After': '30' },
        body: {
          error: { code: 'QUOTE_TEMPORARILY_UNAVAILABLE', message: "We couldn't complete this quote right now.", detail: null },
        },
      },
    ]);

    await assert.rejects(
      providerWith(fetchImpl).createQuote({ items: [{ variantId: 'v', quantity: 1 }], email: 'b@e.com', idempotencyKey: 'k' }),
      (error: unknown) => {
        assert.ok(error instanceof ReapApiError);
        assert.equal(error.retryable, true);
        assert.equal(error.retryAfterSeconds, 30);
        return true;
      },
    );
  });

  test('rejects an undocumented error code loudly', async () => {
    const { fetchImpl } = stubFetch([
      { status: 400, body: { error: { code: 'NEW_THING', message: 'x', detail: null } } },
    ]);
    await assert.rejects(
      providerWith(fetchImpl).createQuote({ items: [{ variantId: 'v', quantity: 1 }], email: 'b@e.com', idempotencyKey: 'k' }),
      ReapProtocolError,
    );
  });

  test('turns a network failure into a transport error without leaking the key', async () => {
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED using key sk_sbx_supersecret');
    }) as typeof fetch;

    await assert.rejects(
      providerWith(fetchImpl).createQuote({ items: [{ variantId: 'v', quantity: 1 }], email: 'b@e.com', idempotencyKey: 'k' }),
      (error: unknown) => {
        assert.ok(error instanceof ReapTransportError);
        assert.ok(!(error as Error).message.includes('supersecret'));
        return true;
      },
    );
  });

  test('turns a stalled request into a timeout error', async () => {
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;

    await assert.rejects(
      providerWith(fetchImpl).createQuote({ items: [{ variantId: 'v', quantity: 1 }], email: 'b@e.com', idempotencyKey: 'k' }),
      ReapTimeoutError,
    );
  });

  test('rejects a non-JSON body rather than guessing', async () => {
    const fetchImpl = (async () =>
      new Response('<html>gateway timeout</html>', {
        status: 504,
        headers: { 'Content-Type': 'text/html' },
      })) as typeof fetch;

    await assert.rejects(
      providerWith(fetchImpl).createQuote({ items: [{ variantId: 'v', quantity: 1 }], email: 'b@e.com', idempotencyKey: 'k' }),
      ReapProtocolError,
    );
  });
});

describe('enrollment mapping', () => {
  test('keeps only the last four digits', async () => {
    const { fetchImpl } = stubFetch([
      {
        status: 200,
        body: {
          id: 'enr_1',
          status: 'ACTIVE',
          owner: { type: 'CLIENT_REFERENCE', id: 'cus_1', email: 'b@example.com' },
          paymentMethod: { type: 'CARD', network: 'VISA', last4: '4242', expiryMonth: 11, expiryYear: 2029 },
          nextAction: null,
        },
      },
    ]);
    const enrollment = await providerWith(fetchImpl).getEnrollment('enr_1');
    assert.equal(enrollment.status, 'ACTIVE');
    assert.equal(enrollment.last4, '4242');
    assert.equal(JSON.stringify(enrollment).includes('4622'), false);
  });

  test('surfaces the hosted step while REQUIRES_ACTION', async () => {
    const { fetchImpl } = stubFetch([
      {
        status: 200,
        body: {
          id: 'enr_1',
          status: 'REQUIRES_ACTION',
          nextAction: { type: 'REDIRECT', url: 'https://prava.reap.global/card/abc', expiresAt: '2026-10-10T03:00:00Z' },
        },
      },
    ]);
    const enrollment = await providerWith(fetchImpl).getEnrollment('enr_1');
    assert.equal(enrollment.nextActionUrl, 'https://prava.reap.global/card/abc');
  });
});

describe('production safety', () => {
  test('recognises production hosts', () => {
    assert.equal(isProductionHost('https://prod.api.reap.global'), true);
    assert.equal(isProductionHost('https://sg.prod.api.reap.global'), true);
    assert.equal(isProductionHost('https://mx.prod.api.reap.global'), true);
  });

  test('does not mistake sandbox hosts for production', () => {
    assert.equal(isProductionHost('https://sandbox.api.reap.global'), false);
    assert.equal(isProductionHost('https://sg.sandbox.api.reap.global'), false);
    assert.equal(isProductionHost('https://mx.sandbox.api.reap.global'), false);
  });

  test('refuses to build a config that simulates against production', () => {
    assert.throws(
      () => defineReapConfig({ ...CONFIG, baseUrl: 'https://prod.api.reap.global', simulateCheckout: 'COMPLETED' }),
      /must never run against a live environment/,
    );
  });
});
