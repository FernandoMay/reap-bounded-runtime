/**
 * The demo agent.
 *
 * Seeded on startup so the runtime is immediately usable, and deliberately
 * configured to refuse more than it allows. A default policy that permits
 * everything would undercut the product on first contact: the safe path has to
 * be the easy one.
 */

import { fromMajor } from '@bounded/core';

import type { Store } from './store.js';

export const DEMO_AGENT_ID = 'demo-procurement-agent';

export function seedDemoAgent(store: Store): void {
  store.upsertAgent(
    {
      id: DEMO_AGENT_ID,
      name: 'Demo procurement agent',
      policy: {
        maxAmountPerPurchase: fromMajor('50.00', 'USD'),
        budget: fromMajor('150.00', 'USD'),
        budgetWindow: 'MONTH',
        allowedCurrencies: ['USD'],
        merchantAllowlist: ['Blend Station', 'Acteck'],
        providerTimeoutMs: 15_000,
      },
    },
    new Date().toISOString(),
  );
}
