/**
 * The purchase state machine.
 *
 * Two rules govern this file.
 *
 * First, `CHECKOUT_PENDING` can only be left by reading the provider back. The
 * runtime never advances a purchase on its own authority; it records what Reap
 * reports. That is the whole point of the product, and it is why there is no
 * `approve()` transition here.
 *
 * Second, every terminal state is terminal. `COMPLETED`, `FAILED`, `EXPIRED` and
 * `POLICY_DENIED` have no outgoing edges, so a settled purchase can never be
 * resurrected into a second charge.
 */

import type { PurchaseState } from './types.js';

const TRANSITIONS: Readonly<Record<PurchaseState, readonly PurchaseState[]>> = {
  RECEIVED: ['POLICY_DENIED', 'QUOTED'],
  POLICY_DENIED: [],
  QUOTED: ['CHECKOUT_PENDING', 'EXPIRED', 'FAILED'],
  CHECKOUT_PENDING: ['PROCESSING', 'EXPIRED', 'FAILED'],
  PROCESSING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  EXPIRED: [],
};

export const TERMINAL_STATES: readonly PurchaseState[] = [
  'POLICY_DENIED',
  'COMPLETED',
  'FAILED',
  'EXPIRED',
] as const;

export function isTerminal(state: PurchaseState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function canTransition(from: PurchaseState, to: PurchaseState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  override readonly name = 'InvalidTransitionError';
  constructor(
    readonly from: PurchaseState,
    readonly to: PurchaseState,
  ) {
    super(`illegal purchase transition ${from} -> ${to}`);
  }
}

/**
 * Map a provider checkout status onto a runtime purchase state.
 *
 * Only statuses Reap documents are accepted. An unknown status throws rather
 * than defaulting to PROCESSING, because guessing "still in flight" for
 * something actually new would leave a purchase hanging forever with no way to
 * reconcile it.
 */
export function stateFromCheckoutStatus(status: string): PurchaseState {
  switch (status) {
    case 'REQUIRES_ACTION':
      return 'CHECKOUT_PENDING';
    case 'PROCESSING':
      return 'PROCESSING';
    case 'COMPLETED':
      return 'COMPLETED';
    case 'FAILED':
      return 'FAILED';
    case 'EXPIRED':
      return 'EXPIRED';
    default:
      throw new Error(`undocumented checkout status: ${status}`);
  }
}

/** Guard used by the persistence layer on every write. */
export function assertTransition(from: PurchaseState, to: PurchaseState): void {
  if (from === to) return;
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
