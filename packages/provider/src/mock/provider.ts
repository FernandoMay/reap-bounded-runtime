/**
 * The fixture provider.
 *
 * This exists so the runtime can be developed, tested and demoed with no
 * network and no credentials — and, more importantly, so that nobody mistakes
 * fixture behaviour for provider behaviour.
 *
 * Two properties make that distinction enforceable rather than aspirational:
 *
 * Every fixture is transcribed from a documented Reap response. The shapes,
 * field names and status values come from the published OpenAPI, so code
 * written against this provider is written against the real contract.
 *
 * Every provider method is labelled `mock`, and the runtime surfaces that label
 * in the dashboard. A response coming from here can never be presented as a
 * real sandbox result.
 *
 * The fixtures deliberately include the awkward cases — a quote that a merchant
 * refuses, a checkout that expires without approval, an enrollment sitting in
 * REQUIRES_ACTION — so that policy and lifecycle handling get exercised rather
 * than just the happy path.
 */

import {
  fromMajor,
  UNRESOLVED_MERCHANT,
  type Checkout,
  type Merchant,
  type Money,
  type Quote,
  type ShippingAddress,
} from '@bounded/core';

import type {
  CreateCheckoutInput,
  CreateQuoteInput,
  Enrollment,
  PaymentProvider,
  ProductDetailsResponse,
  SearchProductsInput,
  SearchResult,
  Variant,
} from '../types.js';

/** How a scenario should behave, chosen per purchase by the caller. */
export type MockScenario =
  | 'happy' // quote prices, checkout completes after approval
  | 'approval_pending' // checkout stays in REQUIRES_ACTION until confirmed
  | 'merchant_refuses' // quote fails with QUOTE_UNFULFILLABLE
  | 'checkout_expires' // quote expires before a checkout can be opened
  | 'checkout_fails' // charge is attempted and fails
  | 'not_enabled'; // 403, Agentic Payments is off for the key

export class MockProviderError extends Error {
  override readonly name = 'MockProviderError';
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    readonly detail?: Record<string, unknown>,
    /** Present on the 503 code, mirroring Reap's documented header. */
    readonly retryAfterSeconds?: number,
    /** Human-readable explanation, so a failure is not just a code. */
    message?: string,
  ) {
    super(message ?? code);
  }
}

interface MockProduct {
  readonly id: string;
  readonly name: string;
  readonly merchant: string;
  readonly price: string;
  readonly currency: string;
  readonly variantId: string;
  readonly requiresShipping: boolean;
}

/** Transcribed from the documented `POST /agentic/products/search` response. */
const CATALOG: readonly MockProduct[] = [
  {
    id: 'prd_mock_coffee',
    name: 'Café de tueste medio 500g',
    merchant: 'Blend Station',
    price: '18.50',
    currency: 'USD',
    variantId: 'var_mock_coffee',
    requiresShipping: true,
  },
  {
    id: 'prd_mock_notebook',
    name: 'Cuaderno de tapa dura, A5',
    merchant: 'Blend Station',
    price: '12.00',
    currency: 'USD',
    variantId: 'var_mock_notebook',
    requiresShipping: true,
  },
  {
    id: 'prd_mock_mug',
    name: 'Taza de cerámica 350ml',
    merchant: 'Acteck',
    price: '9.99',
    currency: 'USD',
    variantId: 'var_mock_mug',
    requiresShipping: true,
  },
  {
    id: 'prd_mock_usb',
    name: 'Cable USB-C 2m',
    merchant: 'Acteck',
    price: '14.25',
    currency: 'USD',
    variantId: 'var_mock_usb',
    requiresShipping: false,
  },
];

const MOCK_ADDRESS_CURRENCY = 'USD';

export interface MockProviderOptions {
  /** How long a mock quote stays valid, in ms. */
  readonly quoteTtlMs?: number;
  /** Clock injection point, so tests do not sleep. */
  readonly now?: () => number;
  readonly scenario?: MockScenario;
}

export class MockProvider implements PaymentProvider {
  readonly kind = 'mock' as const;
  readonly description = 'Mock provider — fixtures transcribed from Reap documentation. No network, no real charges.';

  private readonly quoteTtlMs: number;
  private readonly now: () => number;

  /**
   * Merchant provenance, mirroring the Reap client's behaviour.
   *
   * The mock resolves provenance from its own catalog rather than only
   * populating it during search, so a caller can quote a known variant directly
   * — exactly as a real integration would after a discovery step, and for the
   * same reason: the merchant allowlist has nothing to check without it.
   */
  private readonly provenance = new Map<string, string>();

  private readonly quotes = new Map<
    string,
    { quote: Quote; items: CreateQuoteInput['items']; scenario: MockScenario; merchant: string }
  >();
  private readonly checkouts = new Map<
    string,
    { checkout: Checkout; scenario: MockScenario; approved: boolean; finalAmount?: Money; orderId?: string }
  >();
  private readonly enrollments = new Map<string, Enrollment>();

  private sequence = 0;

  constructor(private readonly options: MockProviderOptions = {}) {
    this.quoteTtlMs = options.quoteTtlMs ?? 15 * 60 * 1000;
    this.now = options.now ?? (() => Date.now());
    // Seeded from the catalog so provenance exists before any search runs.
    for (const product of CATALOG) {
      this.provenance.set(product.variantId, product.merchant);
    }
    // An ACTIVE enrollment exists so the checkout path is reachable without
    // first walking the hosted card-entry flow.
    this.enrollments.set('enr_mock_active', {
      id: 'enr_mock_active',
      status: 'ACTIVE',
      ownerEmail: 'demo@example.test',
      last4: '4242',
      network: 'VISA',
      expiryMonth: 11,
      expiryYear: 2029,
    });
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_mock_${String(this.sequence).padStart(6, '0')}`;
  }

  /**
   * Provenance lookup, matching the Reap client's shape.
   *
   * The runtime resolves the merchant this way before evaluating the merchant
   * allowlist, so the mock has to expose it too — otherwise a mock run would
   * deny every purchase for a reason a sandbox run would not hit.
   */
  merchantForVariant(variantId: string): Merchant | undefined {
    const name = this.provenance.get(variantId);
    return name ? { name } : undefined;
  }

  merchantForVariants(variantIds: readonly string[]): Map<string, Merchant> {
    const out = new Map<string, Merchant>();
    for (const id of variantIds) {
      const merchant = this.merchantForVariant(id);
      if (merchant) out.set(id, merchant);
    }
    return out;
  }

  async searchProducts(input: SearchProductsInput): Promise<{
    searchId: string;
    results: SearchResult[];
    warnings: string[];
  }> {
    const needle = input.query.trim().toLowerCase();
    const matches = CATALOG.filter(
      (product) =>
        needle === '' ||
        product.name.toLowerCase().includes(needle) ||
        product.merchant.toLowerCase().includes(needle),
    ).filter(
      (product) =>
        input.context.currency === undefined || product.currency === input.context.currency,
    );

    const results = matches.map((product): SearchResult => {
      const price = fromMajor(product.price, product.currency);
      const variant: Variant = {
        id: product.variantId,
        name: product.name,
        price,
        available: true,
        requiresShipping: product.requiresShipping,
      };
      this.provenance.set(variant.id, product.merchant);
      return {
        id: product.id,
        merchantName: product.merchant,
        name: product.name,
        priceRange: { min: price, max: price },
        available: true,
        previewVariant: variant,
      };
    });

    return { searchId: this.nextId('qry'), results, warnings: [] };
  }

  async getProductDetails(productIds: readonly string[]): Promise<ProductDetailsResponse> {
    const products = CATALOG.filter((p) => productIds.includes(p.id)).map((p) => ({
      id: p.id,
      name: p.name,
      options: [],
      defaultVariant: {
        id: p.variantId,
        name: p.name,
        price: fromMajor(p.price, p.currency),
        available: true,
        requiresShipping: p.requiresShipping,
      },
    }));
    const errors = productIds
      .filter((id) => !CATALOG.some((p) => p.id === id))
      .map((productId) => ({ productId, message: 'product not found in the mock catalog' }));
    return { products, errors };
  }

  async resolveVariant(productId: string): Promise<Variant> {
    const product = CATALOG.find((p) => p.id === productId || p.variantId === productId);
    if (!product) {
      throw new MockProviderError('AGENTIC_RESOURCE_NOT_FOUND', 404);
    }
    return {
      id: product.variantId,
      name: product.name,
      price: fromMajor(product.price, product.currency),
      available: true,
      requiresShipping: product.requiresShipping,
    };
  }

  async createQuote(input: CreateQuoteInput): Promise<Quote> {
    const scenario = input.items.length === 0 ? 'merchant_refuses' : (this.options.scenario ?? 'happy');

    if (scenario === 'not_enabled') {
      throw new MockProviderError('AGENTIC_PAYMENTS_NOT_ENABLED', 403);
    }
    if (scenario === 'merchant_refuses') {
      // The failure real deployments hit most: a merchant that will not price
      // the cart for the address given.
      throw new MockProviderError('QUOTE_UNFULFILLABLE', 400, {
        reason: 'STATE_OR_PROVINCE_REQUIRED',
      });
    }

    const catalogItems = input.items.map((item) => {
      const product = CATALOG.find((p) => p.variantId === item.variantId);
      if (!product) {
        throw new MockProviderError('AGENTIC_RESOURCE_NOT_FOUND', 404, {
          message: `unknown variant ${item.variantId}`,
        });
      }
      return { product, quantity: item.quantity };
    });

    const subtotalMinor = catalogItems.reduce(
      (sum, { product, quantity }) => sum + Number(fromMajor(product.price, product.currency).minor) * quantity,
      0,
    );
    const currency = catalogItems[0]?.product.currency ?? MOCK_ADDRESS_CURRENCY;
    const itemsSubtotal = fromMajor(String(subtotalMinor / 100), currency);

    const shipping = fromMajor('5.00', currency);
    const tax = fromMajor('1.35', currency);
    const finalAmount = fromMajor(
      String((subtotalMinor + Number(shipping.minor) + Number(tax.minor)) / 100),
      currency,
    );

    const quote: Quote = {
      id: this.nextId('qte'),
      merchant: { name: this.provenance.get(catalogItems[0]?.product.variantId ?? '') ?? UNRESOLVED_MERCHANT },
      amountBreakdown: { itemsSubtotal, shipping, tax, finalAmount },
      shippingOptions: [
        { id: 'shp_standard', name: 'Standard', selected: true, price: shipping },
        { id: 'shp_express', name: 'Express', selected: false, price: fromMajor('12.00', currency) },
      ],
      expiresAt: new Date(this.now() + this.quoteTtlMs).toISOString(),
    };

    this.quotes.set(quote.id, {
      quote,
      items: input.items,
      scenario,
      merchant: catalogItems[0]?.product.merchant ?? UNRESOLVED_MERCHANT,
    });
    return quote;
  }

  async getQuote(quoteId: string): Promise<Quote> {
    const entry = this.quotes.get(quoteId);
    if (!entry) throw new MockProviderError('AGENTIC_RESOURCE_NOT_FOUND', 404);
    if (this.now() > Date.parse(entry.quote.expiresAt)) {
      throw new MockProviderError('QUOTE_EXPIRED', 409);
    }
    return entry.quote;
  }

  async selectShippingOption(quoteId: string, shippingOptionId: string): Promise<Quote> {
    const entry = this.quotes.get(quoteId);
    if (!entry) throw new MockProviderError('AGENTIC_RESOURCE_NOT_FOUND', 404);

    const option = entry.quote.shippingOptions.find((o) => o.id === shippingOptionId);
    if (!option) throw new MockProviderError('AGENTIC_REQUEST_REJECTED', 400);

    const items = entry.quote.amountBreakdown.itemsSubtotal;
    if (!items) throw new MockProviderError('AGENTIC_REQUEST_REJECTED', 400);

    const tax = entry.quote.amountBreakdown.tax ?? fromMajor('0', items.currency);
    const finalAmount = fromMajor(
      String(
        (Number(items.minor) + Number(option.price.minor) + Number(tax.minor)) / 100,
      ),
      items.currency,
    );

    const updated: Quote = {
      ...entry.quote,
      amountBreakdown: { ...entry.quote.amountBreakdown, finalAmount },
      shippingOptions: entry.quote.shippingOptions.map((o) => ({
        ...o,
        selected: o.id === shippingOptionId,
      })),
    };
    this.quotes.set(quoteId, { ...entry, quote: updated });
    return updated;
  }

  async createCheckout(input: CreateCheckoutInput): Promise<Checkout> {
    const entry = this.quotes.get(input.quoteId);
    if (!entry) throw new MockProviderError('AGENTIC_RESOURCE_NOT_FOUND', 404);
    if (this.now() > Date.parse(entry.quote.expiresAt)) {
      throw new MockProviderError('QUOTE_EXPIRED', 409);
    }

    const enrollment = this.enrollments.get(input.enrollmentId);
    if (!enrollment) throw new MockProviderError('AGENTIC_RESOURCE_NOT_FOUND', 404);
    if (enrollment.status !== 'ACTIVE') {
      // Reap only charges an ACTIVE enrollment; anything else is a bug in the
      // caller that should surface before a quote is even priced.
      throw new MockProviderError(
        'AGENTIC_REQUEST_REJECTED',
        400,
        { message: `enrollment ${input.enrollmentId} is ${enrollment.status}, not ACTIVE` },
        undefined,
        `enrollment ${input.enrollmentId} is ${enrollment.status}, not ACTIVE. Read the enrollment before opening a checkout.`,
      );
    }

    const amount = entry.quote.amountBreakdown.finalAmount;
    const expiresAt = new Date(this.now() + 30 * 60 * 1000).toISOString();

    const checkout: Checkout = {
      id: this.nextId('cko'),
      quoteId: input.quoteId,
      enrollmentId: input.enrollmentId,
      // Even the mock mirrors the real contract: a charge starts by waiting on
      // a human, never as already-paid.
      status: 'REQUIRES_ACTION',
      amount,
      approvalUrl: `https://example.invalid/mock/approval/${input.quoteId}`,
      expiresAt,
    };

    this.checkouts.set(checkout.id, { checkout, scenario: entry.scenario, approved: false });
    return checkout;
  }

  /**
   * Simulate the user approving on the hosted page.
   *
   * This is the fixture equivalent of a human clicking "approve", and it is
   * deliberately a separate, explicit call. The runtime never invokes it on its
   * own initiative.
   */
  async approveCheckout(checkoutId: string): Promise<Checkout> {
    const entry = this.checkouts.get(checkoutId);
    if (!entry) throw new MockProviderError('AGENTIC_RESOURCE_NOT_FOUND', 404);
    if (entry.scenario === 'checkout_expires') {
      const expired: Checkout = { ...entry.checkout, status: 'EXPIRED' };
      this.checkouts.set(checkoutId, { ...entry, checkout: expired });
      return expired;
    }
    if (entry.scenario === 'checkout_fails') {
      const failed: Checkout = { ...entry.checkout, status: 'FAILED' };
      this.checkouts.set(checkoutId, { ...entry, checkout: failed });
      return failed;
    }

    const completed: Checkout = {
      ...entry.checkout,
      status: 'COMPLETED',
      approvalUrl: undefined,
      orderId: this.nextId('ord'),
      finalAmount: entry.checkout.amount,
    };
    this.checkouts.set(checkoutId, {
      ...entry,
      checkout: completed,
      approved: true,
      finalAmount: entry.checkout.amount,
      orderId: completed.orderId,
    });
    return completed;
  }

  async getCheckout(checkoutId: string): Promise<Checkout> {
    const entry = this.checkouts.get(checkoutId);
    if (!entry) throw new MockProviderError('AGENTIC_RESOURCE_NOT_FOUND', 404);
    if (entry.approved) {
      return { ...entry.checkout, finalAmount: entry.finalAmount, orderId: entry.orderId };
    }
    return entry.checkout;
  }

  async getEnrollment(enrollmentId: string): Promise<Enrollment> {
    const enrollment = this.enrollments.get(enrollmentId);
    if (!enrollment) throw new MockProviderError('AGENTIC_RESOURCE_NOT_FOUND', 404);
    return enrollment;
  }

  async revokeEnrollment(enrollmentId: string): Promise<Enrollment> {
    const enrollment = this.enrollments.get(enrollmentId);
    if (!enrollment) throw new MockProviderError('AGENTIC_RESOURCE_NOT_FOUND', 404);
    const revoked: Enrollment = { ...enrollment, status: 'REVOKED' };
    this.enrollments.set(enrollmentId, revoked);
    return revoked;
  }

  /** Put an enrollment back into the pre-approval state, for lifecycle demos. */
  async putEnrollmentRequiresAction(enrollmentId: string): Promise<Enrollment> {
    const enrollment = this.enrollments.get(enrollmentId) ?? {
      id: enrollmentId,
      status: 'REQUIRES_ACTION' as const,
    };
    const pending: Enrollment = {
      ...enrollment,
      status: 'REQUIRES_ACTION',
      last4: undefined,
      network: undefined,
      nextActionUrl: `https://example.invalid/mock/card-entry/${enrollmentId}`,
      nextActionExpiresAt: new Date(this.now() + 30 * 60 * 1000).toISOString(),
    };
    this.enrollments.set(enrollmentId, pending);
    return pending;
  }
}

export type { ShippingAddress };
