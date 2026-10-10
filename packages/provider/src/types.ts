/**
 * The provider boundary.
 *
 * Everything above this interface — the policy engine, the API, the dashboard —
 * is written against domain vocabulary and has no idea a payment provider
 * exists. That is the point. If Reap's wire format changed tomorrow, or a second
 * provider were added, nothing in the economic authority layer would change.
 *
 * The interface is also where the product's central claim is enforced by types:
 * there is no method that takes a card number, a CVC, or an OTP, because the
 * runtime has no business accepting one.
 */

import type { Checkout, LineItem, Money, Quote, ShippingAddress } from '@bounded/core';

export interface SearchContext {
  /** ISO 3166-1 alpha-2. Sets the country for pricing. */
  readonly country: string;
  readonly currency: string;
}

export interface PriceRange {
  readonly min: Money;
  readonly max: Money;
}

export interface Variant {
  readonly id: string;
  readonly name: string;
  readonly price: Money;
  readonly available: boolean;
  /** When true, a quote for this variant requires a shipping address. */
  readonly requiresShipping: boolean;
}

export interface SearchResult {
  readonly id: string;
  readonly merchantName: string;
  readonly name: string;
  readonly imageUrl?: string;
  readonly priceRange?: PriceRange;
  readonly available: boolean;
  readonly previewVariant?: Variant;
}

export interface SearchProductsInput {
  readonly query: string;
  readonly context: SearchContext;
  readonly limit?: number;
  /** Bias results toward a named merchant without restricting to it. */
  readonly merchantPreference?: string;
  readonly availability?: 'AVAILABLE_ONLY' | 'ANY';
}

export interface ProductSearchResponse {
  readonly searchId: string;
  readonly results: readonly SearchResult[];
  readonly warnings: readonly string[];
}

export interface OptionValue {
  readonly optionId: string;
  readonly label: string;
  readonly available: boolean;
}

export interface OptionGroup {
  readonly name: string;
  readonly values: readonly OptionValue[];
}

export interface ProductDetail {
  readonly id: string;
  readonly name: string;
  readonly options: readonly OptionGroup[];
  readonly defaultVariant?: Variant;
}

/** Reap reports failures per product rather than failing the whole call. */
export interface ProductDetailsResponse {
  readonly products: readonly ProductDetail[];
  readonly errors: readonly { readonly productId: string; readonly message: string }[];
}

export interface CreateQuoteInput {
  readonly items: readonly Pick<LineItem, 'variantId' | 'quantity'>[];
  readonly email: string;
  readonly shippingAddress?: ShippingAddress;
  readonly offerCode?: string;
  /** Required by Reap. Replaying a key returns the first response for 24h. */
  readonly idempotencyKey: string;
}

export interface CreateCheckoutInput {
  readonly quoteId: string;
  /** Must be an `ACTIVE` enrollment. Reap rejects anything else. */
  readonly enrollmentId: string;
  /** HTTPS URL the user returns to after the hosted approval page. */
  readonly returnUrl: string;
  readonly idempotencyKey: string;
}

export type EnrollmentStatus = 'REQUIRES_ACTION' | 'ACTIVE' | 'REVOKED' | 'FAILED' | 'EXPIRED';

export interface Enrollment {
  readonly id: string;
  readonly status: EnrollmentStatus;
  readonly ownerEmail?: string;
  /** Last four digits only. Reap never discloses more, and neither do we. */
  readonly last4?: string;
  readonly network?: string;
  readonly expiryMonth?: number;
  readonly expiryYear?: number;
  /** Hosted step the user still owes, when one is outstanding. */
  readonly nextActionUrl?: string;
  readonly nextActionExpiresAt?: string;
}

/**
 * A provider the runtime can spend through.
 *
 * There is no `approve` method. Advancing a charge is the user's decision, made
 * on the provider's hosted page, and this interface only allows the runtime to
 * read back what happened.
 */
export interface PaymentProvider {
  /** `sandbox` talks to a real Reap sandbox. `mock` serves fixtures. */
  readonly kind: 'sandbox' | 'mock';
  /** Human-readable provenance, surfaced in the dashboard. */
  readonly description: string;

  searchProducts(input: SearchProductsInput): Promise<ProductSearchResponse>;
  getProductDetails(productIds: readonly string[]): Promise<ProductDetailsResponse>;
  resolveVariant(productId: string, optionIds: readonly string[]): Promise<Variant>;

  createQuote(input: CreateQuoteInput): Promise<Quote>;
  getQuote(quoteId: string): Promise<Quote>;
  selectShippingOption(quoteId: string, shippingOptionId: string): Promise<Quote>;

  createCheckout(input: CreateCheckoutInput): Promise<Checkout>;
  getCheckout(checkoutId: string): Promise<Checkout>;

  getEnrollment(enrollmentId: string): Promise<Enrollment>;
  revokeEnrollment(enrollmentId: string): Promise<Enrollment>;
}
