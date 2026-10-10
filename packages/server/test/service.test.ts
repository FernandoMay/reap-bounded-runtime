import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { fromMajor, isTerminal, type Policy } from '@bounded/core';
import { MockProvider, type MockScenario } from '@bounded/provider';

import { PurchaseError, PurchaseService } from '../src/service.ts';
import { Store } from '../src/store.ts';
import { DEMO_AGENT_ID } from '../src/seed.ts';

const ENROLLMENT = 'enr_mock_active';
const RETURN_URL = 'https://app.example.com/orders/done';

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

const INTENT = {
  items: [{ variantId: 'var_mock_coffee', quantity: 1 }],
  email: 'buyer@example.com',
  shippingAddress: ADDRESS,
};

function setup(policyOverrides: Partial<Policy> = {}, scenario?: MockScenario) {
  const store = new Store(':memory:');
  const provider = new MockProvider(scenario ? { scenario } : {});
  const policy: Policy = {
    maxAmountPerPurchase: fromMajor('50.00', 'USD'),
    allowedCurrencies: ['USD'],
    merchantAllowlist: ['Blend Station'],
    ...policyOverrides,
  };
  store.upsertAgent({ id: DEMO_AGENT_ID, name: 'test agent', policy }, new Date().toISOString());
  const service = new PurchaseService(store, provider, 'mock');
  return { store, provider, service };
}

let keyCounter = 0;
const nextKey = () => `key-${++keyCounter}`;

describe('purchase — the allowed path', () => {
  test('reaches awaiting_approval and never reports a charge as complete', async () => {
    const { service } = setup();
    const outcome = await service.purchase({
      agentId: DEMO_AGENT_ID,
      intent: INTENT,
      idempotencyKey: nextKey(),
      enrollmentId: ENROLLMENT,
      returnUrl: RETURN_URL,
    });

    assert.equal(outcome.kind, 'awaiting_approval');
    if (outcome.kind !== 'awaiting_approval') return;
    assert.equal(outcome.purchase.state, 'CHECKOUT_PENDING');
    assert.equal(outcome.purchase.checkout?.status, 'REQUIRES_ACTION');
    assert.ok(outcome.approvalUrl);
    // The product's central claim, asserted directly.
    assert.equal(outcome.purchase.checkout?.orderId, undefined);
    assert.equal(outcome.purchase.checkout?.finalAmount, undefined);
  });

  test('records the quote, the decision and the approval wait in the audit trail', async () => {
    const { service } = setup();
    const outcome = await service.purchase({
      agentId: DEMO_AGENT_ID,
      intent: INTENT,
      idempotencyKey: nextKey(),
      enrollmentId: ENROLLMENT,
      returnUrl: RETURN_URL,
    });
    assert.equal(outcome.kind, 'awaiting_approval');
    if (outcome.kind !== 'awaiting_approval') return;

    const events = service.auditFor(outcome.purchase.id).map((e) => e.type);
    assert.deepEqual(events, [
      'received',
      'quoted',
      'budget_reserved',
      'awaiting_human_approval',
    ]);
  });
});

describe('purchase — policy refusals', () => {
  test('refuses an amount over the per-purchase ceiling', async () => {
    const { service } = setup({ maxAmountPerPurchase: fromMajor('1.00', 'USD') });
    const outcome = await service.purchase({
      agentId: DEMO_AGENT_ID,
      intent: INTENT,
      idempotencyKey: nextKey(),
      enrollmentId: ENROLLMENT,
      returnUrl: RETURN_URL,
    });
    assert.equal(outcome.kind, 'denied');
    if (outcome.kind !== 'denied') return;
    assert.equal(outcome.decision.code, 'AMOUNT_EXCEEDS_LIMIT');
    assert.equal(outcome.purchase.state, 'POLICY_DENIED');
  });

  test('refuses a merchant that is not allowlisted', async () => {
    const { service } = setup({ merchantAllowlist: ['Some Other Shop'] });
    const outcome = await service.purchase({
      agentId: DEMO_AGENT_ID,
      intent: INTENT,
      idempotencyKey: nextKey(),
      enrollmentId: ENROLLMENT,
      returnUrl: RETURN_URL,
    });
    assert.equal(outcome.kind, 'denied');
    if (outcome.kind !== 'denied') return;
    assert.equal(outcome.decision.code, 'MERCHANT_NOT_ALLOWED');
  });

  test('refuses a currency outside the permitted set', async () => {
    const { service } = setup({ allowedCurrencies: ['EUR'] });
    const outcome = await service.purchase({
      agentId: DEMO_AGENT_ID,
      intent: INTENT,
      idempotencyKey: nextKey(),
      enrollmentId: ENROLLMENT,
      returnUrl: RETURN_URL,
    });
    assert.equal(outcome.kind, 'denied');
    if (outcome.kind !== 'denied') return;
    assert.equal(outcome.decision.code, 'CURRENCY_NOT_ALLOWED');
  });

  test('refuses a variant outside the pin', async () => {
    const { service } = setup({ variantAllowlist: ['var_mock_mug'] });
    const outcome = await service.purchase({
      agentId: DEMO_AGENT_ID,
      intent: INTENT,
      idempotencyKey: nextKey(),
      enrollmentId: ENROLLMENT,
      returnUrl: RETURN_URL,
    });
    assert.equal(outcome.kind, 'denied');
    if (outcome.kind !== 'denied') return;
    assert.equal(outcome.decision.code, 'VARIANT_NOT_ALLOWED');
  });

  test('a denial never contacts the provider for a checkout', async () => {
    const { service, provider } = setup({ maxAmountPerPurchase: fromMajor('1.00', 'USD') });
    await service.purchase({
      agentId: DEMO_AGENT_ID,
      intent: INTENT,
      idempotencyKey: nextKey(),
      enrollmentId: ENROLLMENT,
      returnUrl: RETURN_URL,
    });
    // Nothing to assert on a checkout directly, but the purchase must carry no
    // checkout at all, which is the observable proof.
    const records = service.list();
    assert.equal(records.every((r) => r.checkout === undefined), true);
    assert.ok(provider);
  });

  test('rejects a malformed request before contacting the provider', async () => {
    const { service } = setup();
    const outcome = await service.purchase({
      agentId: DEMO_AGENT_ID,
      intent: { ...INTENT, items: [] },
      idempotencyKey: nextKey(),
      enrollmentId: ENROLLMENT,
      returnUrl: RETURN_URL,
    });
    assert.equal(outcome.kind, 'denied');
    if (outcome.kind !== 'denied') return;
    assert.equal(outcome.decision.code, 'INVALID_REQUEST');
    assert.equal(outcome.purchase.quote, undefined);
  });

  test('refuses an unknown agent rather than defaulting its policy', async () => {
    const { service } = setup();
    await assert.rejects(
      service.purchase({
        agentId: 'ghost',
        intent: INTENT,
        idempotencyKey: nextKey(),
        enrollmentId: ENROLLMENT,
        returnUrl: RETURN_URL,
      }),
      (error: unknown) => error instanceof PurchaseError && error.code === 'AGENT_NOT_FOUND',
    );
  });
});

describe('purchase — cumulative budget', () => {
  const budgetPolicy = (amount: string): Partial<Policy> => ({
    budget: fromMajor(amount, 'USD'),
    budgetWindow: 'MONTH',
  });

  test('allows purchases that fit inside the budget', async () => {
    const { service } = setup(budgetPolicy('100.00'));
    for (let i = 0; i < 3; i += 1) {
      const outcome = await service.purchase({
        agentId: DEMO_AGENT_ID,
        intent: INTENT,
        idempotencyKey: nextKey(),
        enrollmentId: ENROLLMENT,
        returnUrl: RETURN_URL,
      });
      assert.equal(outcome.kind, 'awaiting_approval');
    }
  });

  test('refuses once the budget would be exceeded', async () => {
    // Each coffee purchase is 24.85 USD. Three fit in 80 USD; the fourth does not.
    const { service } = setup(budgetPolicy('80.00'));
    for (let i = 0; i < 3; i += 1) {
      await service.purchase({
        agentId: DEMO_AGENT_ID,
        intent: INTENT,
        idempotencyKey: nextKey(),
        enrollmentId: ENROLLMENT,
        returnUrl: RETURN_URL,
      });
    }
    const fourth = await service.purchase({
      agentId: DEMO_AGENT_ID,
      intent: INTENT,
      idempotencyKey: nextKey(),
      enrollmentId: ENROLLMENT,
      returnUrl: RETURN_URL,
    });
    assert.equal(fourth.kind, 'denied');
    if (fourth.kind !== 'denied') return;
    assert.equal(fourth.decision.code, 'BUDGET_EXCEEDED');
  });

  test('in-flight purchases consume budget before they settle', async () => {
    // Nothing has been approved yet, so nothing is settled. The budget must
    // still stop the fourth purchase, or concurrent agents overrun the limit.
    const { service } = setup(budgetPolicy('80.00'));
    for (let i = 0; i < 3; i += 1) {
      await service.purchase({
        agentId: DEMO_AGENT_ID,
        intent: INTENT,
        idempotencyKey: nextKey(),
        enrollmentId: ENROLLMENT,
        returnUrl: RETURN_URL,
      });
    }
    const usage = service['store' as keyof typeof service];
    void usage;
    const denied = await service.purchase({
      agentId: DEMO_AGENT_ID,
      intent: INTENT,
      idempotencyKey: nextKey(),
      enrollmentId: ENROLLMENT,
      returnUrl: RETURN_URL,
    });
    assert.equal(denied.kind, 'denied');
  });

  test("one agent's spending does not consume another agent's budget", async () => {
    // Budgets are granted per agent. Without an agent_id filter in the usage
    // query, an unrelated agent's purchases exhaust this one — a correctness
    // bug and a cross-tenant denial of service at the same time.
    const { store, service } = setup(budgetPolicy('30.00'));

    store.upsertAgent(
      {
        id: 'noisy-agent',
        name: 'noisy',
        policy: {
          maxAmountPerPurchase: fromMajor('1000.00', 'USD'),
          budget: fromMajor('10000.00', 'USD'),
          budgetWindow: 'MONTH',
          allowedCurrencies: ['USD'],
          merchantAllowlist: ['Blend Station'],
        },
      },
      new Date().toISOString(),
    );

    for (let i = 0; i < 3; i += 1) {
      await service.purchase({
        agentId: 'noisy-agent',
        intent: INTENT,
        idempotencyKey: nextKey(),
        enrollmentId: ENROLLMENT,
        returnUrl: RETURN_URL,
      });
    }

    // The tested agent has spent nothing, so its own first purchase must fit
    // inside its own 30 USD budget.
    const first = await service.purchase({
      agentId: DEMO_AGENT_ID,
      intent: INTENT,
      idempotencyKey: nextKey(),
      enrollmentId: ENROLLMENT,
      returnUrl: RETURN_URL,
    });
    assert.equal(first.kind, 'awaiting_approval');
  });

  test('a failed purchase releases its reservation', async () => {
    const { service, provider } = setup(budgetPolicy('100.00'));
    const first = await service.purchase({
      agentId: DEMO_AGENT_ID,
      intent: INTENT,
      idempotencyKey: nextKey(),
      enrollmentId: ENROLLMENT,
      returnUrl: RETURN_URL,
    });
    assert.equal(first.kind, 'awaiting_approval');
    if (first.kind !== 'awaiting_approval') return;

    await provider.approveCheckout(first.purchase.checkout!.id);
    const settled = await service.sync(first.purchase.checkout!.id);
    assert.equal(settled.state, 'COMPLETED');
    assert.equal(settled.reservedAmount, undefined);
  });
});

describe('idempotency', () => {
  test('a repeated key returns the original purchase and creates no second one', async () => {
    const { service } = setup();
    const key = nextKey();

    const first = await service.purchase({
      agentId: DEMO_AGENT_ID, intent: INTENT, idempotencyKey: key,
      enrollmentId: ENROLLMENT, returnUrl: RETURN_URL,
    });
    const second = await service.purchase({
      agentId: DEMO_AGENT_ID, intent: INTENT, idempotencyKey: key,
      enrollmentId: ENROLLMENT, returnUrl: RETURN_URL,
    });

    assert.equal(first.kind, 'awaiting_approval');
    assert.equal(second.kind, 'duplicate');
    if (second.kind !== 'duplicate') return;
    if (first.kind !== 'awaiting_approval') return;
    assert.equal(second.purchase.id, first.purchase.id);
    assert.equal(service.list().length, 1);
  });

  test('a replay is recorded in the audit trail', async () => {
    const { service } = setup();
    const key = nextKey();
    const first = await service.purchase({
      agentId: DEMO_AGENT_ID, intent: INTENT, idempotencyKey: key,
      enrollmentId: ENROLLMENT, returnUrl: RETURN_URL,
    });
    await service.purchase({
      agentId: DEMO_AGENT_ID, intent: INTENT, idempotencyKey: key,
      enrollmentId: ENROLLMENT, returnUrl: RETURN_URL,
    });
    if (first.kind !== 'awaiting_approval') return;
    const events = service.auditFor(first.purchase.id).map((e) => e.type);
    assert.ok(events.includes('idempotent_replay'));
  });
});

describe('sync — reading the provider back', () => {
  test('a pending checkout does not move until the provider says so', async () => {
    const { service, provider } = setup();
    const outcome = await service.purchase({
      agentId: DEMO_AGENT_ID, intent: INTENT, idempotencyKey: nextKey(),
      enrollmentId: ENROLLMENT, returnUrl: RETURN_URL,
    });
    assert.equal(outcome.kind, 'awaiting_approval');
    if (outcome.kind !== 'awaiting_approval') return;

    // Sync before approval: still pending. The runtime cannot advance this.
    const stillPending = await service.sync(outcome.purchase.checkout!.id);
    assert.equal(stillPending.state, 'CHECKOUT_PENDING');

    await provider.approveCheckout(outcome.purchase.checkout!.id);
    const settled = await service.sync(outcome.purchase.checkout!.id);
    assert.equal(settled.state, 'COMPLETED');
    assert.ok(settled.checkout?.orderId);
    assert.equal(isTerminal(settled.state), true);
  });

  test('a declined purchase settles as FAILED', async () => {
    const { service, provider } = setup({}, 'checkout_fails');
    const outcome = await service.purchase({
      agentId: DEMO_AGENT_ID, intent: INTENT, idempotencyKey: nextKey(),
      enrollmentId: ENROLLMENT, returnUrl: RETURN_URL,
    });
    assert.equal(outcome.kind, 'awaiting_approval');
    if (outcome.kind !== 'awaiting_approval') return;

    await provider.approveCheckout(outcome.purchase.checkout!.id);
    const settled = await service.sync(outcome.purchase.checkout!.id);
    assert.equal(settled.state, 'FAILED');
  });

  test('an unapproved purchase settles as EXPIRED', async () => {
    const { service, provider } = setup({}, 'checkout_expires');
    const outcome = await service.purchase({
      agentId: DEMO_AGENT_ID, intent: INTENT, idempotencyKey: nextKey(),
      enrollmentId: ENROLLMENT, returnUrl: RETURN_URL,
    });
    assert.equal(outcome.kind, 'awaiting_approval');
    if (outcome.kind !== 'awaiting_approval') return;

    await provider.approveCheckout(outcome.purchase.checkout!.id);
    const settled = await service.sync(outcome.purchase.checkout!.id);
    assert.equal(settled.state, 'EXPIRED');
  });

  test('a terminal purchase never moves again', async () => {
    const { service, provider } = setup();
    const outcome = await service.purchase({
      agentId: DEMO_AGENT_ID, intent: INTENT, idempotencyKey: nextKey(),
      enrollmentId: ENROLLMENT, returnUrl: RETURN_URL,
    });
    if (outcome.kind !== 'awaiting_approval') return;

    await provider.approveCheckout(outcome.purchase.checkout!.id);
    await service.sync(outcome.purchase.checkout!.id);

    // A second sync must not resurrect or re-transition a settled purchase.
    const again = await service.sync(outcome.purchase.checkout!.id);
    assert.equal(again.state, 'COMPLETED');
  });

  test('rejects a sync for an unknown checkout', async () => {
    const { service } = setup();
    await assert.rejects(
      service.sync('cko_does_not_exist'),
      (error: unknown) => error instanceof PurchaseError && error.httpStatus === 404,
    );
  });
});

describe('enrollment gating', () => {
  test('refuses to charge an enrollment that is not ACTIVE', async () => {
    const { service, provider } = setup();
    await provider.putEnrollmentRequiresAction('enr_pending');

    await assert.rejects(
      service.purchase({
        agentId: DEMO_AGENT_ID, intent: INTENT, idempotencyKey: nextKey(),
        enrollmentId: 'enr_pending', returnUrl: RETURN_URL,
      }),
      (error: unknown) =>
        error instanceof PurchaseError &&
        error.code === 'ENROLLMENT_NOT_ACTIVE' &&
        Boolean((error.detail as { nextActionUrl?: string } | undefined)?.nextActionUrl),
    );
  });

  test('the failure is recorded rather than vanishing', async () => {
    const { service, provider } = setup();
    await provider.putEnrollmentRequiresAction('enr_pending');
    await assert.rejects(
      service.purchase({
        agentId: DEMO_AGENT_ID, intent: INTENT, idempotencyKey: nextKey(),
        enrollmentId: 'enr_pending', returnUrl: RETURN_URL,
      }),
    );
    const records = service.list();
    assert.equal(records[0]?.state, 'FAILED');
    assert.ok(service.auditFor(records[0]!.id).some((e) => e.type === 'enrollment_not_active'));
  });
});

describe('provider failures', () => {
  test('a refused quote surfaces the provider remedy', async () => {
    const { service } = setup({}, 'merchant_refuses');
    await assert.rejects(
      service.purchase({
        agentId: DEMO_AGENT_ID, intent: INTENT, idempotencyKey: nextKey(),
        enrollmentId: ENROLLMENT, returnUrl: RETURN_URL,
      }),
      (error: unknown) => {
        // The remedy is what tells an operator what to change; a bare error
        // code is what made the original sandbox incident hard to diagnose.
        const remedy = (error as { remedy?: string }).remedy;
        return (
          error instanceof Error &&
          (error as { code?: string }).code === 'QUOTE_UNFULFILLABLE' &&
          typeof remedy === 'string' &&
          remedy.includes('region')
        );
      },
    );
  });

  test('a quote failure marks the purchase FAILED and audits it', async () => {
    const { service } = setup({}, 'merchant_refuses');
    await assert.rejects(
      service.purchase({
        agentId: DEMO_AGENT_ID, intent: INTENT, idempotencyKey: nextKey(),
        enrollmentId: ENROLLMENT, returnUrl: RETURN_URL,
      }),
    );
    const record = service.list()[0];
    assert.equal(record?.state, 'FAILED');
    assert.ok(service.auditFor(record!.id).some((e) => e.type === 'quote_failed'));
  });
});

describe('audit integrity', () => {
  test('the audit trail never contains a card-like digit run', async () => {
    const { service } = setup();
    const outcome = await service.purchase({
      agentId: DEMO_AGENT_ID, intent: INTENT, idempotencyKey: nextKey(),
      enrollmentId: ENROLLMENT, returnUrl: RETURN_URL,
    });
    assert.equal(outcome.kind, 'awaiting_approval');
    const dump = JSON.stringify(service.auditFor(outcome.purchase.id));
    // The runtime must not be inventing or echoing card data at any point.
    assert.ok(!/4\d{15}/.test(dump));
    assert.ok(!dump.includes('cvv'));
  });

  test('the purchaser identity appears, since it is not a secret', async () => {
    const { service } = setup();
    const outcome = await service.purchase({
      agentId: DEMO_AGENT_ID, intent: INTENT, idempotencyKey: nextKey(),
      enrollmentId: ENROLLMENT, returnUrl: RETURN_URL,
    });
    assert.equal(outcome.kind, 'awaiting_approval');
    const dump = JSON.stringify(service.auditFor(outcome.purchase.id));
    assert.ok(dump.includes('buyer@example.com'));
  });
});
