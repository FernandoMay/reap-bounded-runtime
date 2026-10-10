import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { REDACTED, redactHeaders, redactString, redactValue } from '../src/index.ts';

/**
 * Build a Luhn-valid card number from a partial, so the suite never has to
 * paste a real card number — not even a publicly documented sandbox one.
 */
function withLuhnCheckDigit(partial: string): string {
  const sum = (() => {
    let total = 0;
    let double = true;
    for (let i = partial.length - 1; i >= 0; i -= 1) {
      let v = partial.charCodeAt(i) - 48;
      if (double) {
        v *= 2;
        if (v > 9) v -= 9;
      }
      total += v;
      double = !double;
    }
    return total;
  })();
  return partial + String((10 - (sum % 10)) % 10);
}

const PAN = withLuhnCheckDigit('462294312313779');
assert.match(PAN, /^\d{16}$/); // guard: if this ever breaks, the tests below lie

describe('redactString', () => {
  test('removes bearer tokens whatever their shape', () => {
    const out = redactString('Authorization: Bearer sk_sbx_abc123def456');
    assert.ok(!out.includes('abc123def456'));
    assert.ok(out.includes('Bearer [REDACTED]'));
  });

  test('removes Reap-shaped API keys', () => {
    const out = redactString('key is sk_sbx_01HZY8QWERTYUIOPASDF');
    assert.ok(!out.includes('01HZY8QWERTYUIOPASDF'));
  });

  test('removes a card number and keeps only the last four digits', () => {
    const out = redactString(`card ${PAN}`);
    assert.ok(!out.includes(PAN.slice(0, 12)));
    assert.ok(out.endsWith(PAN.slice(-4)));
    assert.ok(out.includes(REDACTED));
  });

  test('handles grouped card numbers', () => {
    const grouped = PAN.replace(/(.{4})(?=.)/g, '$1 ');
    const out = redactString(`card ${grouped}`);
    assert.ok(!redactString(grouped).includes(PAN.replace(/(.{4})/g, '$1 ').slice(0, 12)));
    assert.ok(out.includes(REDACTED));
  });

  test('leaves non-card digit runs alone', () => {
    // Order references, quote ids and timestamps must survive redaction.
    // Redacting them would make logs unreadable and train reviewers to ignore
    // the redaction markers.
    for (const value of ['ord_01M4HWYGR6SK4RZ4NJZGR98WH5', '1234567890123', '20261010T024512Z']) {
      assert.equal(redactString(value), value);
    }
  });

  test('leaves ordinary prose untouched', () => {
    const text = 'checkout 7bb5e367-7501-47e6-9826-c8c7f44bf1c1 reached COMPLETED';
    assert.equal(redactString(text), text);
  });
});

describe('redactValue', () => {
  test('redacts secret-shaped keys regardless of value', () => {
    const out = redactValue({
      apiKey: 'anything',
      api_key: 'anything',
      authorization: 'anything',
      password: 'anything',
      clientSecret: 'anything',
    }) as Record<string, unknown>;
    for (const value of Object.values(out)) assert.equal(value, REDACTED);
  });

  test('redacts CVV and OTP fields', () => {
    const out = redactValue({ cvv: '640', cvc: '640', otp: '456789', securityCode: '640' }) as Record<
      string,
      unknown
    >;
    for (const value of Object.values(out)) assert.equal(value, REDACTED);
  });

  test('redacts secrets nested in objects and arrays', () => {
    const out = redactValue({
      request: { headers: { Authorization: 'Bearer sk_sbx_x' }, body: { cvv: '123' } },
      attempts: [{ token: 'abc' }],
    }) as Record<string, Record<string, unknown>>;
    assert.equal(out['request']?.['headers']?.['Authorization'], REDACTED);
    assert.equal((out['request']?.['body'] as Record<string, unknown>)['cvv'], REDACTED);
    assert.equal(
      ((out['attempts'] as unknown[])[0] as Record<string, unknown>)['token'],
      REDACTED,
    );
  });

  test('leaves harmless operational fields intact', () => {
    const out = redactValue({ quoteId: 'qte_123', variantId: 'var_abc', status: 'COMPLETED' }) as Record<
      string,
      unknown
    >;
    assert.equal(out['quoteId'], 'qte_123');
    assert.equal(out['variantId'], 'var_abc');
    assert.equal(out['status'], 'COMPLETED');
  });

  test('survives a cyclic structure instead of throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic['self'] = cyclic;
    const out = redactValue(cyclic) as Record<string, unknown>;
    assert.equal(out['name'], 'root');
    assert.equal(out['self'], '[Circular]');
  });

  test('preserves non-string primitives', () => {
    assert.deepEqual(redactValue({ n: 1, b: true, z: null }), { n: 1, b: true, z: null });
  });
});

describe('redactHeaders', () => {
  test('redacts authorization but keeps debugging headers', () => {
    const out = redactHeaders({
      Authorization: 'Bearer sk_sbx_secret',
      'Idempotency-Key': '56B86D75-49EC-462C-B365-20009D554FAC',
      'Reap-Version': '2025-02-14',
      'Content-Type': 'application/json',
    });
    assert.equal(out['Authorization'], REDACTED);
    // Replay debugging is impossible without these, and neither carries authority.
    assert.equal(out['Idempotency-Key'], '56B86D75-49EC-462C-B365-20009D554FAC');
    assert.equal(out['Reap-Version'], '2025-02-14');
  });

  test('redacts cookies', () => {
    assert.equal(redactHeaders({ Cookie: 'session=abc' })['Cookie'], REDACTED);
  });
});
