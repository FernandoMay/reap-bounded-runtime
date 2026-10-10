import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
  isTerminal,
  stateFromCheckoutStatus,
  TERMINAL_STATES,
} from '../src/index.ts';
import type { PurchaseState } from '../src/types.ts';

describe('canTransition', () => {
  test('permits the documented happy path', () => {
    assert.ok(canTransition('RECEIVED', 'QUOTED'));
    assert.ok(canTransition('QUOTED', 'CHECKOUT_PENDING'));
    assert.ok(canTransition('CHECKOUT_PENDING', 'PROCESSING'));
    assert.ok(canTransition('PROCESSING', 'COMPLETED'));
  });

  test('permits denial straight from RECEIVED', () => {
    assert.ok(canTransition('RECEIVED', 'POLICY_DENIED'));
  });

  test('refuses to skip the policy stage', () => {
    assert.equal(canTransition('RECEIVED', 'CHECKOUT_PENDING'), false);
    assert.equal(canTransition('RECEIVED', 'COMPLETED'), false);
  });

  test('refuses to move backwards', () => {
    assert.equal(canTransition('PROCESSING', 'QUOTED'), false);
    assert.equal(canTransition('CHECKOUT_PENDING', 'RECEIVED'), false);
  });

  test('permits a checkout that completes without PROCESSING being observed', () => {
    // Polling is not atomic. A purchase approved and settled between two reads
    // is reported COMPLETED without the runtime ever seeing PROCESSING, and
    // refusing that edge would strand it in CHECKOUT_PENDING forever.
    assert.ok(canTransition('CHECKOUT_PENDING', 'COMPLETED'));
  });

  test('treats every terminal state as final', () => {
    const all: PurchaseState[] = [
      'RECEIVED',
      'POLICY_DENIED',
      'QUOTED',
      'CHECKOUT_PENDING',
      'PROCESSING',
      'COMPLETED',
      'FAILED',
      'EXPIRED',
    ];
    for (const terminal of TERMINAL_STATES) {
      assert.ok(isTerminal(terminal));
      for (const target of all) {
        assert.equal(
          canTransition(terminal, target),
          false,
          `${terminal} must not be able to reach ${target}`,
        );
      }
    }
  });
});

describe('assertTransition', () => {
  test('allows a no-op write', () => {
    assert.doesNotThrow(() => assertTransition('QUOTED', 'QUOTED'));
  });

  test('throws with both states on an illegal move', () => {
    assert.throws(() => assertTransition('COMPLETED', 'PROCESSING'), InvalidTransitionError);
    try {
      assertTransition('COMPLETED', 'PROCESSING');
    } catch (error) {
      assert.match((error as Error).message, /COMPLETED -> PROCESSING/);
    }
  });
});

describe('stateFromCheckoutStatus', () => {
  test('maps every status Reap documents', () => {
    assert.equal(stateFromCheckoutStatus('REQUIRES_ACTION'), 'CHECKOUT_PENDING');
    assert.equal(stateFromCheckoutStatus('PROCESSING'), 'PROCESSING');
    assert.equal(stateFromCheckoutStatus('COMPLETED'), 'COMPLETED');
    assert.equal(stateFromCheckoutStatus('FAILED'), 'FAILED');
    assert.equal(stateFromCheckoutStatus('EXPIRED'), 'EXPIRED');
  });

  test('refuses to guess an undocumented status', () => {
    // Defaulting to PROCESSING here would strand a purchase in flight forever
    // with no terminal state to reconcile against.
    assert.throws(() => stateFromCheckoutStatus('SOMETHING_NEW'), /undocumented checkout status/);
  });
});
