import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  isRetryable,
  parseReapError,
  REAP_ERROR_CODES,
  ReapApiError,
  ReapProtocolError,
  recoveryPathFor,
  type ReapErrorCode,
} from '../src/index.ts';

const headers = (init: Record<string, string> = {}) => new Headers(init);

function parseError(body: unknown, init: Record<string, string> = {}, status = 400): ReapApiError {
  return parseReapError(status, body, headers(init));
}

describe('parseReapError', () => {
  test('recognises every documented error code', () => {
    for (const code of REAP_ERROR_CODES) {
      const error = parseError({ error: { code, message: 'x', detail: null } });
      assert.equal(error.code, code);
      assert.ok(error.remedy.length > 0);
    }
  });

  test('refuses an undocumented code instead of downgrading it', () => {
    // A code we do not know means the integration assumptions are stale. That
    // has to be loud, not silently flattened into "some error".
    assert.throws(
      () => parseError({ error: { code: 'TOTALLY_NEW_CODE', message: 'x', detail: null } }),
      ReapProtocolError,
    );
  });

  test('refuses a body with no error envelope', () => {
    assert.throws(() => parseError({ nonsense: true }), /recognisable error envelope/);
    assert.throws(() => parseError(null), /recognisable error envelope/);
  });

  test("extracts QUOTE_UNFULFILLABLE's reason", () => {
    const error = parseError({
      error: { code: 'QUOTE_UNFULFILLABLE', message: 'no', detail: { reason: 'STATE_OR_PROVINCE_REQUIRED' } },
    });
    assert.equal(error.detail?.quoteUnfulfillableReason, 'STATE_OR_PROVINCE_REQUIRED');
    assert.equal(error.httpStatus, 400);
  });

  test("extracts AGENTIC_REQUEST_REJECTED's field errors", () => {
    const error = parseError({
      error: {
        code: 'AGENTIC_REQUEST_REJECTED',
        message: 'The request was rejected',
        detail: { errors: [{ field: 'shippingAddress', message: 'Host must match the merchant domain' }] },
      },
    });
    assert.equal(error.detail?.fieldErrors?.[0]?.field, 'shippingAddress');
    assert.match(error.remedy, /shippingAddress/);
  });

  test('reads Retry-After on QUOTE_TEMPORARILY_UNAVAILABLE', () => {
    const error = parseError(
      { error: { code: 'QUOTE_TEMPORARILY_UNAVAILABLE', message: 'later', detail: null } },
      { 'Retry-After': '7' },
      503,
    );
    assert.equal(error.retryAfterSeconds, 7);
    assert.match(error.remedy, /7s/);
  });

  test('ignores Retry-After on codes that do not document it', () => {
    const error = parseError(
      { error: { code: 'QUOTE_UNFULFILLABLE', message: 'no', detail: null } },
      { 'Retry-After': '7' },
    );
    assert.equal(error.retryAfterSeconds, undefined);
  });

  test('tolerates a malformed Retry-After', () => {
    const error = parseError(
      { error: { code: 'QUOTE_TEMPORARILY_UNAVAILABLE', message: 'x', detail: null } },
      { 'Retry-After': 'soon' },
      503,
    );
    assert.equal(error.retryAfterSeconds, undefined);
  });
});

describe('recovery classification', () => {
  test('only the two 503 codes are retryable', () => {
    const retryable = REAP_ERROR_CODES.filter(isRetryable);
    assert.deepEqual([...retryable].sort(), [
      'AGENTIC_SERVICE_UNAVAILABLE',
      'QUOTE_TEMPORARILY_UNAVAILABLE',
    ]);
  });

  test('every other code demands a corrected request or an operator', () => {
    for (const code of REAP_ERROR_CODES) {
      if (isRetryable(code)) continue;
      const path = recoveryPathFor(code);
      assert.notEqual(path, 'RETRY_SAME_INPUT');
    }
  });

  test('400-class errors are never retryable', () => {
    const fourHundreds: ReapErrorCode[] = [
      'AGENTIC_REQUEST_REJECTED',
      'CHECKOUT_URL_INVALID',
      'CARD_PAYMENT_UNAVAILABLE',
      'OFFER_CODE_INVALID',
      'OFFER_CODE_EXPIRED',
      'QUOTE_UNFULFILLABLE',
    ];
    for (const code of fourHundreds) assert.equal(isRetryable(code), false, code);
  });

  test('the 409s need a fresh resource, not a replay', () => {
    assert.equal(recoveryPathFor('QUOTE_EXPIRED'), 'FRESH_RESOURCE');
    assert.equal(recoveryPathFor('VARIANT_UNAVAILABLE'), 'FRESH_RESOURCE');
  });
});

describe('remedy guidance', () => {
  test('names the exact field to populate for a missing state or province', () => {
    const error = parseError({
      error: { code: 'QUOTE_UNFULFILLABLE', message: 'no', detail: { reason: 'STATE_OR_PROVINCE_REQUIRED' } },
    });
    assert.match(error.remedy, /shippingAddress\.region/);
    assert.match(error.remedy, /not `state`/);
  });

  test('names the exact field for a missing address line 2', () => {
    const error = parseError({
      error: { code: 'QUOTE_UNFULFILLABLE', message: 'no', detail: { reason: 'ADDRESS_LINE_2_REQUIRED' } },
    });
    assert.match(error.remedy, /addressLine2/);
  });

  test('warns that an invalid phone is usually a reserved range', () => {
    const error = parseError({
      error: { code: 'QUOTE_UNFULFILLABLE', message: 'no', detail: { reason: 'INVALID_PHONE' } },
    });
    assert.match(error.remedy, /real reachable number/);
  });

  test('tells the operator that configuration is the problem for 403', () => {
    const error = parseError(
      { error: { code: 'AGENTIC_PAYMENTS_NOT_ENABLED', message: 'x', detail: null } },
      {},
      403,
    );
    assert.match(error.remedy, /enabled/);
    assert.equal(error.recovery, 'OPERATOR_ACTION');
  });
});
