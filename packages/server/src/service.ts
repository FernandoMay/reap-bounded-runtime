/**
 * The purchase orchestration service.
 *
 * This is where the ordering that makes the product's promise true is enforced:
 *
 *   validate -> quote -> POLICY -> reserve -> checkout -> await human
 *
 * Policy sits after the quote and before the checkout on purpose. Before the
 * quote there is no real amount to check, because prices come from the merchant
 * and only a quote reveals them. After the checkout the charge already exists.
 * The window where we know the true amount and nothing has been committed is
 * exactly here, and it is narrow.
 *
 * Nothing in this file advances a purchase on its own authority. The only way
 * out of `CHECKOUT_PENDING` is reading the provider back, which is what makes
 * "the agent cannot approve its own purchase" a structural property rather than
 * a promise in a README.
 */

import { randomUUID } from 'node:crypto';

import {
  assertTransition,
  evaluatePolicy,
  redactString,
  redactValue,
  stateFromCheckoutStatus,
  UNRESOLVED_MERCHANT,
  validateIntent,
  type AuditEvent,
  type LineItem,
  type Merchant,
  type PolicyDecision,
  type PurchaseIntent,
  type PurchaseRecord,
  type PurchaseState,
  type RuntimeMode,
  type ShippingAddress,
} from '@bounded/core';
import type { PaymentProvider } from '@bounded/provider';

import type { Agent, Store } from './store.js';

export interface ServiceLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const NOOP_LOGGER: ServiceLogger = { info: () => {}, warn: () => {}, error: () => {} };

export interface PurchaseRequest {
  readonly agentId: string;
  readonly intent: PurchaseIntent;
  /**
   * Stable key for this purchase intent. Reusing it returns the original
   * purchase instead of creating a second one.
   */
  readonly idempotencyKey: string;
  readonly enrollmentId: string;
  readonly returnUrl: string;
}

export type PurchaseOutcome =
  | { readonly kind: 'created'; readonly purchase: PurchaseRecord }
  /** The idempotency key was already used; nothing new was created. */
  | { readonly kind: 'duplicate'; readonly purchase: PurchaseRecord }
  | {
      readonly kind: 'denied';
      readonly purchase: PurchaseRecord;
      readonly decision: PolicyDecision;
    }
  | {
      readonly kind: 'awaiting_approval';
      readonly purchase: PurchaseRecord;
      /** Hosted page where the human approves or declines. */
      readonly approvalUrl: string;
    };

export class PurchaseError extends Error {
  override readonly name = 'PurchaseError';
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface ServiceOptions {
  /** Injected clock, so lifecycle tests do not depend on wall time. */
  readonly now?: () => Date;
  readonly id?: () => string;
}

export class PurchaseService {
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(
    private readonly store: Store,
    private readonly provider: PaymentProvider,
    private readonly mode: RuntimeMode,
    private readonly logger: ServiceLogger = NOOP_LOGGER,
    options: ServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? (() => randomUUID());
  }

  /**
   * Run a purchase request through the full pipeline.
   *
   * Idempotency is claimed first, before any provider call. A retry with the
   * same key returns the existing purchase untouched, so a network hiccup on
   * the way back cannot produce a second charge.
   */
  async purchase(request: PurchaseRequest): Promise<PurchaseOutcome> {
    const agent = this.store.getAgent(request.agentId);
    if (!agent) {
      throw new PurchaseError(
        'AGENT_NOT_FOUND',
        `no agent "${request.agentId}" is configured. Create it with its policy before requesting a purchase.`,
        404,
      );
    }

    // One id, generated once, used for both the key claim and the record.
    // Generating a second id here would leave the claim pointing at an id that
    // no purchase ever uses, and the retry would then hit the unique constraint
    // on idempotency_key instead of being recognised as a replay.
    const purchaseId = this.id();

    const existingId = this.store.claimIdempotencyKey(
      request.idempotencyKey,
      purchaseId,
      this.now().toISOString(),
    );
    if (existingId) {
      const existing = this.store.getPurchase(existingId);
      if (existing) {
        this.audit(existing.id, 'idempotent_replay', 'Idempotency key reused; no new purchase created');
        return { kind: 'duplicate', purchase: existing };
      }
    }

    const created = this.now().toISOString();
    const record: PurchaseRecord = {
      id: purchaseId,
      idempotencyKey: request.idempotencyKey,
      agentId: request.agentId,
      state: 'RECEIVED',
      intent: request.intent,
      decision: { allowed: true, outcomes: [] },
      createdAt: created,
      updatedAt: created,
    };

    // A malformed request is denied without ever reaching the provider. There is
    // no amount to policy-check yet, and a bad payload should not cost a
    // merchant round trip.
    const invalid = validateIntent(request.intent);
    if (invalid) {
      const decision: PolicyDecision = {
        allowed: false,
        code: 'INVALID_REQUEST',
        message: invalid.message,
        outcomes: [{ rule: 'request_is_well_formed', passed: false, detail: invalid.message }],
      };
      const denied: PurchaseRecord = {
        ...record,
        state: 'POLICY_DENIED',
        decision,
        updatedAt: this.now().toISOString(),
      };
      this.store.insertPurchase(denied);
      this.audit(denied.id, 'policy_denied', `Rejected before contacting the provider: ${invalid.message}`, {
        code: decision.code,
      });
      return { kind: 'denied', purchase: denied, decision };
    }

    this.store.insertPurchase(record);
    this.audit(record.id, 'received', 'Purchase intent accepted', {
      // The purchaser's identity belongs in the audit trail: it is what a
      // reviewer needs to answer "who was this for", and it is not a secret.
      items: request.intent.items.map((item) => ({ variantId: item.variantId, quantity: item.quantity })),
      email: request.intent.email,
      ...(request.intent.rationale ? { rationale: request.intent.rationale } : {}),
    });

    // 1. Price it. Until this returns there is no real amount to judge.
    let quote;
    try {
      quote = await this.provider.createQuote({
        items: request.intent.items.map((item) => ({ variantId: item.variantId, quantity: item.quantity })),
        email: request.intent.email,
        ...(request.intent.shippingAddress
          ? { shippingAddress: request.intent.shippingAddress }
          : {}),
        ...(request.intent.offerCode ? { offerCode: request.intent.offerCode } : {}),
        // Derived from the purchase key so a replay at the provider level is
        // also idempotent, not just at ours.
        idempotencyKey: `${request.idempotencyKey}:quote`,
      });
    } catch (error) {
      const failed: PurchaseRecord = {
        ...record,
        state: 'FAILED',
        updatedAt: this.now().toISOString(),
      };
      this.store.updatePurchase(failed);
      this.audit(record.id, 'quote_failed', describeProviderError(error), {
        error: redactString(String(error)),
      });
      throw error;
    }

    const amount = quote.amountBreakdown.finalAmount;
    const quoted: PurchaseRecord = {
      ...record,
      state: 'QUOTED',
      quote,
      updatedAt: this.now().toISOString(),
    };
    this.store.updatePurchase(quoted);
    this.audit(quoted.id, 'quoted', `Merchant quoted ${amount.currency} ${amount.minor} minor units`, {
      quoteId: quote.id,
      expiresAt: quote.expiresAt,
    });

    // 2. Judge it, with the real amount and the merchant provenance.
    //
    //    Provenance has to be resolved from the requested variants, not read off
    //    the quote: Reap's quote response carries no merchant at all, and its
    //    search response carries only a name. A runtime that trusted the quote
    //    here would evaluate the allowlist against "(unresolved)" and refuse
    //    every legitimate purchase while appearing to enforce a limit.
    const merchant = this.resolveMerchant(request.intent.items, quote.merchant);
    const budget = agent.policy.budget
      ? this.store.budgetUsage(agent.id, agent.policy.budget.currency)
      : undefined;

    const decision = evaluatePolicy({
      policy: agent.policy,
      requestedAmount: amount,
      items: request.intent.items,
      ...(merchant ? { merchant } : {}),
      ...(budget ? { budget } : {}),
    });

    if (!decision.allowed) {
      const denied: PurchaseRecord = {
        ...quoted,
        state: 'POLICY_DENIED',
        decision,
        updatedAt: this.now().toISOString(),
      };
      this.store.updatePurchase(denied);
      this.audit(denied.id, 'policy_denied', `Policy refused the purchase: ${decision.message}`, {
        code: decision.code,
        outcomes: decision.outcomes,
      });
      this.logger.warn('purchase.denied', { purchaseId: quoted.id, code: decision.code });
      return { kind: 'denied', purchase: denied, decision };
    }

    // 3. Reserve the budget before opening a checkout, so the reservation is
    //    visible to any concurrent evaluation even if this one later fails.
    const reserved: PurchaseRecord = {
      ...quoted,
      decision,
      reservedAmount: amount,
      updatedAt: this.now().toISOString(),
    };
    this.store.updatePurchase(reserved);
    this.audit(reserved.id, 'budget_reserved', `Reserved ${amount.currency} ${amount.minor} against the agent budget`, {
      amount: amount.minor,
      currency: amount.currency,
    });

    // 4. Only now may we open a checkout. The enrollment must be ACTIVE; a
    //    REQUIRES_ACTION enrollment means the user still owes Reap a hosted
    //    step, and charging it is guaranteed to fail.
    const enrollment = await this.provider.getEnrollment(request.enrollmentId);
    if (enrollment.status !== 'ACTIVE') {
      const failed: PurchaseRecord = {
        ...reserved,
        state: 'FAILED',
        updatedAt: this.now().toISOString(),
      };
      this.store.updatePurchase(failed);
      this.audit(
        failed.id,
        'enrollment_not_active',
        `Enrollment ${enrollment.id} is ${enrollment.status}; an ACTIVE enrollment is required to charge`,
        { enrollmentId: enrollment.id, status: enrollment.status },
      );
      throw new PurchaseError(
        'ENROLLMENT_NOT_ACTIVE',
        `enrollment ${enrollment.id} is ${enrollment.status}. Complete the hosted step, then read it again before purchasing.`,
        409,
        { nextActionUrl: enrollment.nextActionUrl },
      );
    }

    let checkout;
    try {
      checkout = await this.provider.createCheckout({
        quoteId: quote.id,
        enrollmentId: enrollment.id,
        returnUrl: request.returnUrl,
        idempotencyKey: `${request.idempotencyKey}:checkout`,
      });
    } catch (error) {
      const failed: PurchaseRecord = { ...reserved, state: 'FAILED', updatedAt: this.now().toISOString() };
      this.store.updatePurchase(failed);
      this.audit(failed.id, 'checkout_failed', describeProviderError(error), {
        error: redactString(String(error)),
      });
      throw error;
    }

    const pending: PurchaseRecord = {
      ...reserved,
      state: 'CHECKOUT_PENDING',
      checkout,
      updatedAt: this.now().toISOString(),
    };
    this.store.updatePurchase(pending);

    if (!checkout.approvalUrl) {
      // A checkout in REQUIRES_ACTION with no approval URL cannot be approved.
      // Surfacing it as "awaiting approval" with no URL would hang the user.
      throw new PurchaseError(
        'APPROVAL_URL_MISSING',
        'the provider returned a checkout awaiting approval without an approval URL',
        502,
      );
    }

    this.audit(
      pending.id,
      'awaiting_human_approval',
      'Charge opened. Waiting for the human to approve on the provider page. The runtime cannot approve this itself.',
      { checkoutId: checkout.id, amount: checkout.amount.minor, currency: checkout.amount.currency },
    );

    return { kind: 'awaiting_approval', purchase: pending, approvalUrl: checkout.approvalUrl };
  }

  /**
   * Read a checkout back and record what actually happened.
   *
   * This is the only way a purchase leaves `CHECKOUT_PENDING`. It runs after the
   * user returns from the hosted page, and it reports what the provider says
   * rather than what the user claimed.
   */
  async sync(checkoutId: string): Promise<PurchaseRecord> {
    const record = this.findByCheckout(checkoutId);
    if (!record.checkout) {
      throw new PurchaseError('CHECKOUT_NOT_FOUND', `no purchase has checkout ${checkoutId}`, 404);
    }

    const checkout = await this.provider.getCheckout(record.checkout.id);
    const next = stateFromCheckoutStatus(checkout.status);
    assertTransition(record.state, next);

    const updated: PurchaseRecord = {
      ...record,
      checkout,
      state: next,
      // The reservation is released once the purchase reaches a terminal state:
      // a completed charge moves to settled, and a failure or expiry frees the
      // budget for someone else.
      ...(next === 'COMPLETED' || next === 'FAILED' || next === 'EXPIRED'
        ? { reservedAmount: undefined }
        : {}),
      updatedAt: this.now().toISOString(),
    };
    this.store.updatePurchase(updated);

    this.audit(
      updated.id,
      `checkout_${checkout.status.toLowerCase()}`,
      `Provider reports the checkout is ${checkout.status}`,
      {
        checkoutId: checkout.id,
        orderId: checkout.orderId,
        finalAmount: checkout.finalAmount?.minor,
      },
    );

    return updated;
  }

  get(id: string): PurchaseRecord | undefined {
    return this.store.getPurchase(id);
  }

  list(limit?: number): PurchaseRecord[] {
    return this.store.listPurchases(limit);
  }

  auditFor(purchaseId: string): AuditEvent[] {
    return this.store.listAudit(purchaseId);
  }

  private findByCheckout(checkoutId: string): PurchaseRecord {
    const found = this.store.listPurchases(1000).find((p) => p.checkout?.id === checkoutId);
    if (!found) {
      throw new PurchaseError('CHECKOUT_NOT_FOUND', `no purchase has checkout ${checkoutId}`, 404);
    }
    return found;
  }

  /**
   * Determine which merchant this purchase is from.
   *
   * Prefers provenance the runtime recorded from a provider response during
   * discovery, because that is the only merchant information the provider
   * actually vouched for. A quote that names its merchant is accepted as-is; a
   * quote that does not is never padded with a placeholder, because passing a
   * placeholder to the policy engine would look like a successful check against
   * a string nobody vouched for.
   *
   * When the cart spans several merchants the first known one is used. Mixed
   * carts are worth rejecting eventually, but the per-variant allowlist is the
   * control that handles it today, and inventing a composite rule here would be
   * a decision made in the wrong layer.
   */
  private resolveMerchant(items: readonly LineItem[], quoted: Merchant): Merchant | undefined {
    if (quoted.name && quoted.name !== UNRESOLVED_MERCHANT) {
      return quoted;
    }
    const lookup = (this.provider as { merchantForVariant?: (id: string) => Merchant | undefined })
      .merchantForVariant;
    if (typeof lookup !== 'function') return undefined;

    for (const item of items) {
      const known = lookup.call(this.provider, item.variantId);
      if (known && known.name !== UNRESOLVED_MERCHANT) return known;
    }
    return undefined;
  }

  private audit(
    purchaseId: string,
    type: string,
    summary: string,
    data?: Record<string, unknown>,
  ): void {
    const event: AuditEvent = {
      id: this.id(),
      purchaseId,
      at: this.now().toISOString(),
      type,
      summary,
      ...(data ? { data: redactValue(data) as Record<string, unknown> } : {}),
    };
    this.store.appendAudit(event);
  }
}

function describeProviderError(error: unknown): string {
  if (error && typeof error === 'object' && 'remedy' in error) {
    const remedy = (error as { remedy: string }).remedy;
    const message = error instanceof Error ? error.message : '';
    return `${message} ${remedy}`.trim();
  }
  if (error instanceof Error) return error.message;
  return 'unknown provider failure';
}

export type { Agent, PolicyDecision, PurchaseIntent, PurchaseRecord, PurchaseState, ShippingAddress };
