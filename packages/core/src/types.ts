/**
 * Domain vocabulary for the runtime.
 *
 * Statuses mirror Reap's own lifecycle rather than inventing a parallel set, so
 * that a runtime state and a provider state can be compared without a lookup
 * table. See `lifecycle.ts` for the transition rules and docs/reap-contract.md
 * for the mapping back to the provider's vocabulary.
 */

import type { Money } from './money.js';

/**
 * Placeholder used when a provider does not disclose the merchant for a quote.
 *
 * Reap's quote response contains no merchant field at all. Rather than leave
 * the field empty — where an empty string and a real merchant name are hard to
 * tell apart — the value is set to this explicit sentinel. It must never reach
 * the policy engine as though it were a merchant name: that would turn "we do
 * not know which merchant this is" into a passing allowlist check.
 */
export const UNRESOLVED_MERCHANT = '(unresolved)';

/**
 * A merchant, as far as the provider discloses it.
 *
 * Reap's discovery responses expose only `merchant.name`. The quote response
 * exposes no merchant at all. `domain` is therefore populated only when the
 * runtime already knows it — which, today, is only for merchants the operator
 * configured by hand. Treating a name as if it were a verified domain would make
 * an allowlist look enforced while an untrusted party could imitate it.
 */
export interface Merchant {
  readonly name: string;
  /** Canonical DNS domain, when known. Never inferred from a name. */
  readonly domain?: string;
  /** ISO 3166-1 alpha-2, when known. */
  readonly country?: string;
}

/** One requested line item, already resolved to a purchasable variant. */
export interface LineItem {
  readonly variantId: string;
  readonly productId: string;
  readonly productName: string;
  readonly variantName?: string;
  readonly quantity: number;
  /** Unit price as quoted by the merchant, when a quote exists. */
  readonly unitPrice?: Money;
}

export interface ShippingAddress {
  readonly firstName: string;
  readonly lastName: string;
  /** E.164. Reap documents the pattern `^\+[1-9]\d{6,14}$`. */
  readonly phone: string;
  readonly addressLine1: string;
  /** Colonia, interior, floor. Required by some merchants despite being optional. */
  readonly addressLine2?: string;
  readonly city: string;
  /** Subdivision code. The field is `region`; `state` is not accepted by Reap. */
  readonly region?: string;
  readonly postalCode?: string;
  /** ISO 3166-1 alpha-2, e.g. `US`, `MX`. */
  readonly country: string;
}

/**
 * A purchase an agent wants to make.
 *
 * This is intent, not authorisation. It carries no authority over funds and no
 * payment credential, by construction.
 */
export interface PurchaseIntent {
  readonly items: readonly LineItem[];
  readonly email: string;
  readonly shippingAddress?: ShippingAddress;
  readonly merchantHint?: string;
  readonly offerCode?: string;
  /** Free-text justification, surfaced to the human approver. */
  readonly rationale?: string;
}

/**
 * The economic limits an operator grants an agent.
 *
 * Every field is a ceiling, never a target. A policy grants permission; it does
 * not instruct a purchase.
 */
/**
 * LIMITATION — merchant names are not authenticated.
 *
 * A merchant name arrives as an unsigned string from a provider response. Two
 * different merchants can present the same name, and a compromised or confused
 * catalog can present any name. Matching an allowlist entry against a name is
 * therefore a usability control that stops ordinary mistakes, not a security
 * boundary. Treat it as such: it will stop an agent from wandering into an
 * unrelated shop, and it will not stop a determined impersonation.
 *
 * `variantAllowlist` is the control to reach for when the distinction matters.
 * Variant ids are opaque provider-issued identifiers that cannot be re-spelled
 * by a merchant, so pinning them is a genuine constraint on what may be bought.
 *
 * The same reasoning applies to `domain`: it is only populated when the
 * operator configured it, never inferred from a name.
 */
export interface Policy {
  /** Maximum total for a single purchase, inclusive of shipping and tax. */
  readonly maxAmountPerPurchase?: Money;
  /** Currencies the agent may operate in. */
  readonly allowedCurrencies?: readonly string[];
  /**
   * Merchants the agent may buy from, matched against the merchant name and,
   * when known, its canonical domain. An empty list means no merchant is
   * permitted — fail closed, not fail open.
   *
   * Names are compared case-insensitively. Reap discloses merchant names but not
   * domains, so a name-only allowlist is the strongest check available against
   * provider data; see `variantAllowlist` for a stricter alternative.
   */
  readonly merchantAllowlist?: readonly string[];
  /**
   * Exact variant ids the agent may purchase. When present, a purchase must
   * consist solely of these variants, regardless of the merchant allowlist.
   *
   * This exists because a merchant name is not a security boundary: nothing in
   * the provider's response authenticates that "Blend Station" is the same
   * merchant across two calls. Pinning the exact purchasable artifacts an agent
   * may buy removes the question.
   */
  readonly variantAllowlist?: readonly string[];
  /** Cumulative ceiling across all purchases in `budgetWindow`. */
  readonly budget?: Money;
  readonly budgetWindow?: 'DAY' | 'WEEK' | 'MONTH' | 'LIFETIME';
  /** Longest edge to edge a single provider call may take. */
  readonly providerTimeoutMs?: number;
}

/** Why a request was refused before any provider call was attempted. */
export type DenialCode =
  | 'AMOUNT_EXCEEDS_LIMIT'
  | 'CURRENCY_NOT_ALLOWED'
  | 'MERCHANT_NOT_ALLOWED'
  | 'VARIANT_NOT_ALLOWED'
  | 'BUDGET_EXCEEDED'
  | 'INVALID_REQUEST'
  | 'POLICY_UNAVAILABLE';

export interface RuleOutcome {
  readonly rule: string;
  readonly passed: boolean;
  readonly detail: string;
}

/**
 * The result of evaluating a policy.
 *
 * A denial always carries a `DenialCode`. A reason that a downstream system
 * could not parse is not a reason.
 */
export type PolicyDecision =
  | { readonly allowed: true; readonly outcomes: readonly RuleOutcome[] }
  | {
      readonly allowed: false;
      readonly code: DenialCode;
      readonly message: string;
      readonly outcomes: readonly RuleOutcome[];
    };

/**
 * Runtime-side purchase lifecycle.
 *
 * `CHECKOUT_PENDING` means the charge exists at the provider and is waiting on
 * a human. Nothing in this runtime can move it forward: only a completed hosted
 * approval at Reap can, and the runtime learns about that by reading the
 * checkout back.
 */
export type PurchaseState =
  | 'RECEIVED'
  | 'POLICY_DENIED'
  | 'QUOTED'
  | 'CHECKOUT_PENDING'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'EXPIRED';

/** Where the money came from, from the runtime's point of view. */
export type RuntimeMode = 'sandbox' | 'mock';

export interface AmountBreakdown {
  readonly itemsSubtotal?: Money;
  readonly shipping?: Money;
  readonly tax?: Money;
  readonly finalAmount: Money;
}

/** A provider quote, normalised. */
export interface Quote {
  readonly id: string;
  readonly merchant: Merchant;
  readonly amountBreakdown: AmountBreakdown;
  readonly shippingOptions: readonly ShippingOption[];
  readonly expiresAt: string;
}

export interface ShippingOption {
  readonly id: string;
  readonly name: string;
  readonly selected: boolean;
  readonly price: Money;
}

/** A provider checkout, normalised. */
export interface Checkout {
  readonly id: string;
  readonly quoteId: string;
  readonly enrollmentId: string;
  /** `REQUIRES_ACTION`, `PROCESSING`, `COMPLETED`, `FAILED` or `EXPIRED`. */
  readonly status: string;
  readonly amount: Money;
  /** Hosted approval URL. Present only while the charge awaits human approval. */
  readonly approvalUrl?: string;
  readonly expiresAt?: string;
  /** Merchant order reference. Present only once `COMPLETED`. */
  readonly orderId?: string;
  /** Amount actually charged. Differs from the quote once settled. */
  readonly finalAmount?: Money;
}

/**
 * The runtime's own record of a purchase.
 *
 * This is what the dashboard reads and what the audit trail is derived from. It
 * never contains a card number, CVC, OTP, or any other payment secret.
 */
export interface PurchaseRecord {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly agentId: string;
  readonly state: PurchaseState;
  readonly intent: PurchaseIntent;
  readonly decision: PolicyDecision;
  readonly quote?: Quote;
  readonly checkout?: Checkout;
  /** Amount reserved against the budget at policy time. */
  readonly reservedAmount?: Money;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** An append-only, human-readable trace of everything that happened. */
export interface AuditEvent {
  readonly id: string;
  readonly purchaseId: string;
  readonly at: string;
  readonly type: string;
  readonly summary: string;
  /** Structured, already-redacted payload. */
  readonly data?: Readonly<Record<string, unknown>>;
}
