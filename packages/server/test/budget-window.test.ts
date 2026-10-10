import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { fromMajor } from '@bounded/core';

import { Store, windowStart } from '../src/store.ts';

/**
 * Budget windows.
 *
 * The behaviour under test is that spending stops counting when its window
 * rolls over. Without that, a MONTH budget accumulates every purchase the
 * agent has ever made and stops being a limit.
 */

const AGENT = 'window-agent';

function seed(store: Store, policy: Record<string, unknown>, at: string): void {
  store.upsertAgent({ id: AGENT, name: 'window agent', policy: policy as never }, at);
}

/** Write a completed purchase directly, so the test controls its timestamp. */
function insertCompleted(store: Store, amount: string, createdAt: string): void {
  store.insertPurchase({
    id: `p-${createdAt}-${Math.random().toString(36).slice(2)}`,
    idempotencyKey: `k-${createdAt}-${Math.random().toString(36).slice(2)}`,
    agentId: AGENT,
    state: 'COMPLETED',
    intent: { items: [{ variantId: 'var_1', productId: 'p', productName: 'n', quantity: 1 }], email: 'b@e.com' },
    decision: { allowed: true, outcomes: [] },
    reservedAmount: fromMajor(amount, 'USD'),
    createdAt,
    updatedAt: createdAt,
  });
}

describe('windowStart', () => {
  test('a lifetime budget has no start', () => {
    assert.equal(windowStart('LIFETIME', new Date('2026-03-15T12:00:00Z')), undefined);
  });

  test('a day starts at UTC midnight', () => {
    assert.equal(
      windowStart('DAY', new Date('2026-03-15T23:59:59Z'))?.toISOString(),
      '2026-03-15T00:00:00.000Z',
    );
  });

  test('a month starts on the first, not the current day', () => {
    assert.equal(
      windowStart('MONTH', new Date('2026-03-15T12:00:00Z'))?.toISOString(),
      '2026-03-01T00:00:00.000Z',
    );
  });

  test('a month rolls over at the boundary', () => {
    assert.equal(
      windowStart('MONTH', new Date('2026-04-01T00:00:00Z'))?.toISOString(),
      '2026-04-01T00:00:00.000Z',
    );
  });

  test('a week starts on Monday, not Sunday', () => {
    // 2026-03-15 is a Sunday. An ISO week began on Monday the 9th.
    assert.equal(
      windowStart('WEEK', new Date('2026-03-15T12:00:00Z'))?.toISOString(),
      '2026-03-09T00:00:00.000Z',
    );
    // A Monday returns itself.
    assert.equal(
      windowStart('WEEK', new Date('2026-03-09T06:00:00Z'))?.toISOString(),
      '2026-03-09T00:00:00.000Z',
    );
  });

  test('handles a year boundary', () => {
    assert.equal(
      windowStart('MONTH', new Date('2026-01-05T00:00:00Z'))?.toISOString(),
      '2026-01-01T00:00:00.000Z',
    );
  });
});

describe('budgetUsage window scoping', () => {
  test('a lifetime budget counts everything', () => {
    const store = new Store(':memory:');
    seed(store, {}, '2020-01-01T00:00:00Z');
    insertCompleted(store, '40.00', '2020-06-01T00:00:00Z');

    const usage = store.budgetUsage(AGENT, 'USD', 'LIFETIME', new Date('2026-10-10T00:00:00Z'));
    assert.equal(usage.settled.minor, 4000n);
    assert.equal(usage.since, null);
  });

  test('a monthly budget excludes last month', () => {
    const store = new Store(':memory:');
    seed(store, {}, '2020-01-01T00:00:00Z');
    insertCompleted(store, '40.00', '2026-09-10T00:00:00Z'); // last month
    insertCompleted(store, '10.00', '2026-10-02T00:00:00Z'); // this month

    const usage = store.budgetUsage(AGENT, 'USD', 'MONTH', new Date('2026-10-10T00:00:00Z'));
    assert.equal(usage.settled.minor, 1000n);
    assert.equal(usage.since, '2026-10-01T00:00:00.000Z');
  });

  test('a daily budget excludes yesterday', () => {
    const store = new Store(':memory:');
    seed(store, {}, '2020-01-01T00:00:00Z');
    insertCompleted(store, '40.00', '2026-10-09T23:00:00Z'); // yesterday
    insertCompleted(store, '5.00', '2026-10-10T01:00:00Z'); // today

    const usage = store.budgetUsage(AGENT, 'USD', 'DAY', new Date('2026-10-10T12:00:00Z'));
    assert.equal(usage.settled.minor, 500n);
  });

  test('a weekly budget excludes last week', () => {
    const store = new Store(':memory:');
    seed(store, {}, '2020-01-01T00:00:00Z');
    insertCompleted(store, '40.00', '2026-03-01T12:00:00Z'); // previous ISO week
    insertCompleted(store, '7.00', '2026-03-11T12:00:00Z'); // this ISO week

    const usage = store.budgetUsage(AGENT, 'USD', 'WEEK', new Date('2026-03-15T12:00:00Z'));
    assert.equal(usage.settled.minor, 700n);
  });

  test('reservations expire with the window too', () => {
    const store = new Store(':memory:');
    seed(store, {}, '2020-01-01T00:00:00Z');
    // An in-flight purchase from last month must not hold this month's budget.
    store.insertPurchase({
      id: 'old-pending',
      idempotencyKey: 'old-pending',
      agentId: AGENT,
      state: 'CHECKOUT_PENDING',
      intent: { items: [{ variantId: 'v', productId: 'p', productName: 'n', quantity: 1 }], email: 'b@e.com' },
      decision: { allowed: true, outcomes: [] },
      reservedAmount: fromMajor('90.00', 'USD'),
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    });

    const usage = store.budgetUsage(AGENT, 'USD', 'MONTH', new Date('2026-10-10T00:00:00Z'));
    assert.equal(usage.reserved.minor, 0n);
  });

  test('still scoped to the agent', () => {
    const store = new Store(':memory:');
    seed(store, {}, '2020-01-01T00:00:00Z');
    insertCompleted(store, '40.00', '2026-10-02T00:00:00Z');

    const other = store.budgetUsage('someone-else', 'USD', 'MONTH', new Date('2026-10-10T00:00:00Z'));
    assert.equal(other.settled.minor, 0n);
  });

  test('defaults to a lifetime window when none is given', () => {
    const store = new Store(':memory:');
    seed(store, {}, '2020-01-01T00:00:00Z');
    insertCompleted(store, '40.00', '2020-06-01T00:00:00Z');

    const usage = store.budgetUsage(AGENT, 'USD');
    assert.equal(usage.settled.minor, 4000n);
  });
});
