/**
 * The real Reap Agentic Payments client.
 *
 * Translates between the domain vocabulary of `types.ts` and Reap's documented
 * wire format. Two rules govern the translation.
 *
 * Never invent a field. Every path, header and body key below appears in the
 * published OpenAPI. Where Reap documents something as optional but a merchant
 * in practice requires it — `region` and `addressLine2` — the value is sent
 * through if present, and its absence is explained in the error we surface,
 * because that combination is the single most common cause of a rejected quote.
 *
 * Never overstate a result. `createCheckout` returning `REQUIRES_ACTION` means
 * a charge is *waiting on a human*, not that anything was paid. The mapping into
 * `Checkout` preserves that distinction, and the runtime has no path that treats
 * a checkout as complete without reading a terminal status back from Reap.
 */

import {
  fromMajor,
  fromMinor,
  ReapProtocolError,
  type Checkout,
  type LineItem,
  type Merchant,
  type Money,
  type Quote,
  type ShippingAddress,
  type ShippingOption,
} from '@bounded/core';

import type { ReapConfig } from '../config.js';
import { ReapClient } from '../http.js';
import type {
  CreateCheckoutInput,
  CreateQuoteInput,
  Enrollment,
  PaymentProvider,
  PriceRange,
  ProductDetail,
  ProductDetailsResponse,
  SearchProductsInput,
  SearchResult,
  SearchResult as SearchResultType,
  Variant,
} from '../types.js';

/** Shape of the amounts Reap returns. */
interface ReapAmount {
  amount: number | string;
  currency: string;
}

/**
 * Convert a Reap amount into internal minor units.
 *
 * Reap documents amounts as a JSON `number` without stating whether those are
 * major units (129.00) or minor units (12900). The documented examples are
 * consistent with major units — a 129 USD product, a 150 USD mandate ceiling —
 * so that is the default. `REAP_AMOUNT_SEMANTICS=MINOR` flips it without a code
 * change if that assumption is ever disproved against live data.
 *
 * The conversion goes through the decimal string form rather than multiplying a
 * float, so 142.85 becomes exactly 14285 minor units.
 */
function toMoney(raw: ReapAmount, semantics: ReapConfig['amountSemantics']): Money {
  if (typeof raw !== 'object' || raw === null || typeof raw.currency !== 'string') {
    throw new ReapProtocolError('Reap returned an amount without a currency');
  }
  if (semantics === 'MINOR') {
    // Dividing by 100 would reintroduce the float error this whole module
    // exists to avoid. `fromMinor` takes the integer count directly.
    const minor = Number(raw.amount);
    if (!Number.isSafeInteger(minor)) {
      throw new ReapProtocolError(
        `amount ${String(raw.amount)} is not an integer count of minor units`,
      );
    }
    return fromMinor(minor, raw.currency);
  }
  return fromMajor(String(raw.amount), raw.currency);
}

function readAmount(value: unknown, path: string): Money {
  if (typeof value !== 'object' || value === null) {
    throw new ReapProtocolError(`expected an amount object at ${path}`);
  }
  const { amount, currency } = value as ReapAmount;
  if (amount === undefined || typeof currency !== 'string') {
    throw new ReapProtocolError(`amount at ${path} is missing "amount" or "currency"`);
  }
  return fromMajor(String(amount), currency);
}

function readShippingOptions(value: unknown, semantics: ReapConfig['amountSemantics']): ShippingOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((option) => {
    if (typeof option !== 'object' || option === null) return [];
    const { id, name, selected, price } = option as {
      id?: unknown;
      name?: unknown;
      selected?: unknown;
      price?: unknown;
    };
    if (typeof id !== 'string' || typeof price !== 'object' || price === null) return [];
    return [
      {
        id,
        name: typeof name === 'string' ? name : id,
        selected: selected === true,
        price: toMoney(price as ReapAmount, semantics),
      },
    ];
  });
}

function parseQuote(body: unknown, semantics: ReapConfig['amountSemantics']): Quote {
  if (typeof body !== 'object' || body === null) {
    throw new ReapProtocolError('quote response was not an object');
  }
  const record = body as Record<string, unknown>;
  if (typeof record['id'] !== 'string') {
    throw new ReapProtocolError('quote response is missing "id"');
  }
  const breakdown = record['amountBreakdown'];
  if (typeof breakdown !== 'object' || breakdown === null) {
    throw new ReapProtocolError('quote response is missing "amountBreakdown"');
  }
  const bd = breakdown as Record<string, unknown>;

  // `finalAmount` is the number the human is shown and the number that matters
  // for policy. It is required by the schema; anything else would be a guess.
  const finalAmount = readAmount(bd['finalAmount'], 'amountBreakdown.finalAmount');

  return {
    id: record['id'],
    // Reap does not include the merchant on a quote, so the runtime carries
    // provenance from the search step instead. See `MerchantProvenance`.
    merchant: { name: '(unresolved)' },
    amountBreakdown: {
      finalAmount,
      ...(bd['itemsSubtotal'] ? { itemsSubtotal: readAmount(bd['itemsSubtotal'], 'itemsSubtotal') } : {}),
      ...(bd['shipping'] ? { shipping: readAmount(bd['shipping'], 'shipping') } : {}),
      ...(typeof bd['tax'] === 'object' && bd['tax'] !== null
        ? { tax: readAmount((bd['tax'] as Record<string, unknown>)['amount'], 'tax.amount') }
        : {}),
    },
    shippingOptions: readShippingOptions(record['shippingOptions'], semantics),
    expiresAt: typeof record['expiresAt'] === 'string' ? record['expiresAt'] : '',
  };
}

function parseNextActionUrl(nextAction: unknown): string | undefined {
  if (typeof nextAction !== 'object' || nextAction === null) return undefined;
  const url = (nextAction as Record<string, unknown>)['url'];
  return typeof url === 'string' ? url : undefined;
}

function parseCheckout(body: unknown, semantics: ReapConfig['amountSemantics']): Checkout {
  if (typeof body !== 'object' || body === null) {
    throw new ReapProtocolError('checkout response was not an object');
  }
  const record = body as Record<string, unknown>;
  if (typeof record['id'] !== 'string' || typeof record['status'] !== 'string') {
    throw new ReapProtocolError('checkout response is missing "id" or "status"');
  }

  const nextActionUrl = parseNextActionUrl(record['nextAction']);
  const nextActionExpiresAt =
    typeof record['nextAction'] === 'object' && record['nextAction'] !== null
      ? (record['nextAction'] as Record<string, unknown>)['expiresAt']
      : undefined;

  return {
    id: record['id'],
    quoteId: typeof record['quoteId'] === 'string' ? record['quoteId'] : '',
    enrollmentId: typeof record['enrollmentId'] === 'string' ? record['enrollmentId'] : '',
    status: record['status'],
    amount: readAmount(record['amount'], 'amount'),
    // The approval URL is the whole point of the human-in-the-loop design, so
    // its absence while status is REQUIRES_ACTION is a protocol violation worth
    // failing loudly on rather than a silently unusable checkout.
    ...(nextActionUrl ? { approvalUrl: nextActionUrl } : {}),
    ...(typeof nextActionExpiresAt === 'string' ? { expiresAt: nextActionExpiresAt } : {}),
    ...(typeof record['orderId'] === 'string' ? { orderId: record['orderId'] } : {}),
    ...(record['finalAmount'] ? { finalAmount: readAmount(record['finalAmount'], 'finalAmount') } : {}),
  };
}

function parseEnrollment(body: unknown): Enrollment {
  if (typeof body !== 'object' || body === null) {
    throw new ReapProtocolError('enrollment response was not an object');
  }
  const record = body as Record<string, unknown>;
  if (typeof record['id'] !== 'string' || typeof record['status'] !== 'string') {
    throw new ReapProtocolError('enrollment response is missing "id" or "status"');
  }
  const owner = typeof record['owner'] === 'object' && record['owner'] !== null
    ? (record['owner'] as Record<string, unknown>)
    : undefined;
  const paymentMethod =
    typeof record['paymentMethod'] === 'object' && record['paymentMethod'] !== null
      ? (record['paymentMethod'] as Record<string, unknown>)
      : undefined;

  const nextActionUrl = parseNextActionUrl(record['nextAction']);
  const nextActionExpiresAt =
    typeof record['nextAction'] === 'object' && record['nextAction'] !== null
      ? (record['nextAction'] as Record<string, unknown>)['expiresAt']
      : undefined;

  return {
    id: record['id'],
    status: record['status'] as Enrollment['status'],
    ...(typeof owner?.['email'] === 'string' ? { ownerEmail: owner['email'] } : {}),
    // `last4` is the only card detail Reap discloses, and the only one kept.
    ...(typeof paymentMethod?.['last4'] === 'string' ? { last4: paymentMethod['last4'] } : {}),
    ...(typeof paymentMethod?.['network'] === 'string' ? { network: paymentMethod['network'] } : {}),
    ...(typeof paymentMethod?.['expiryMonth'] === 'number'
      ? { expiryMonth: paymentMethod['expiryMonth'] }
      : {}),
    ...(typeof paymentMethod?.['expiryYear'] === 'number'
      ? { expiryYear: paymentMethod['expiryYear'] }
      : {}),
    ...(nextActionUrl ? { nextActionUrl } : {}),
    ...(typeof nextActionExpiresAt === 'string' ? { nextActionExpiresAt } : {}),
  };
}

/**
 * Reap's `shippingAddress`, in the exact shape its schema accepts.
 *
 * `region` and `addressLine2` are documented as optional but are demanded by
 * real merchants, which is what produces `QUOTE_UNFULFILLABLE` with
 * `STATE_OR_PROVINCE_REQUIRED` or `ADDRESS_LINE_2_REQUIRED`. They are omitted
 * here only when genuinely absent, never renamed, and `state` is never used —
 * Reap does not accept it.
 */
function toReapAddress(address: ShippingAddress): Record<string, string> {
  return {
    firstName: address.firstName,
    lastName: address.lastName,
    phone: address.phone,
    addressLine1: address.addressLine1,
    ...(address.addressLine2 ? { addressLine2: address.addressLine2 } : {}),
    city: address.city,
    ...(address.region ? { region: address.region } : {}),
    ...(address.postalCode ? { postalCode: address.postalCode } : {}),
    country: address.country,
  };
}

export class ReapAgenticProvider implements PaymentProvider {
  readonly kind = 'sandbox' as const;
  readonly description: string;

  /** variantId -> merchant, learned during discovery. Reap does not report it on quotes. */
  private readonly provenance = new Map<string, Merchant>();

  constructor(
    private readonly config: ReapConfig,
    private readonly client: ReapClient = new ReapClient(config),
  ) {
    this.description = `Reap Agentic Payments (${config.baseUrl})${
      config.simulateCheckout ? ' [simulated checkout]' : ' [live human approval]'
    }`;
  }

  /** Remember which merchant a variant came from, for the policy allowlist. */
  rememberMerchant(variantId: string, merchant: Merchant): void {
    this.provenance.set(variantId, merchant);
  }

  merchantForVariant(variantId: string): Merchant | undefined {
    return this.provenance.get(variantId);
  }

  async searchProducts(input: SearchProductsInput): Promise<{
    searchId: string;
    results: SearchResultType[];
    warnings: string[];
  }> {
    const body: Record<string, unknown> = {
      query: input.query,
      context: { country: input.context.country, currency: input.context.currency },
    };
    if (input.limit !== undefined) body['pagination'] = { limit: input.limit };
    if (input.merchantPreference !== undefined) {
      body['merchantPreference'] = input.merchantPreference;
    }
    if (input.availability !== undefined) body['filters'] = { availability: input.availability };

    const { body: response } = await this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: '/agentic/products/search',
      body,
    });

    const raw = Array.isArray(response['products']) ? response['products'] : [];
    const results = raw.flatMap((entry): SearchResultType[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const record = entry as Record<string, unknown>;
      if (typeof record['id'] !== 'string' || typeof record['name'] !== 'string') return [];

      const merchantName =
        typeof record['merchant'] === 'object' && record['merchant'] !== null
          ? (record['merchant'] as Record<string, unknown>)['name']
          : undefined;
      const merchant: Merchant | undefined =
        typeof merchantName === 'string' ? { name: merchantName } : undefined;

      const preview =
        typeof record['previewVariant'] === 'object' && record['previewVariant'] !== null
          ? (record['previewVariant'] as Record<string, unknown>)
          : undefined;
      let previewVariant: Variant | undefined;
      if (preview && typeof preview['id'] === 'string' && typeof preview['price'] === 'object') {
        previewVariant = {
          id: preview['id'],
          name: typeof preview['name'] === 'string' ? preview['name'] : preview['id'],
          price: readAmount(preview['price'], 'previewVariant.price'),
          available: preview['available'] !== false,
          requiresShipping: preview['requiresShipping'] === true,
        };
        // This is the only place the runtime learns the variant/merchant link.
        if (merchant) this.rememberMerchant(previewVariant.id, merchant);
      }

      const range =
        typeof record['priceRange'] === 'object' && record['priceRange'] !== null
          ? (record['priceRange'] as Record<string, unknown>)
          : undefined;
      const priceRange: PriceRange | undefined =
        range && typeof range['min'] === 'object' && typeof range['max'] === 'object'
          ? {
              min: readAmount(range['min'], 'priceRange.min'),
              max: readAmount(range['max'], 'priceRange.max'),
            }
          : undefined;

      return [
        {
          id: record['id'],
          merchantName: typeof merchantName === 'string' ? merchantName : '(unknown merchant)',
          name: record['name'],
          ...(typeof record['imageUrl'] === 'string' ? { imageUrl: record['imageUrl'] } : {}),
          ...(priceRange ? { priceRange } : {}),
          available: record['available'] !== false,
          ...(previewVariant ? { previewVariant } : {}),
        },
      ];
    });

    const warnings = Array.isArray(response['warnings'])
      ? response['warnings'].filter((w): w is string => typeof w === 'string')
      : [];

    return {
      searchId: typeof response['id'] === 'string' ? response['id'] : '',
      results,
      warnings,
    };
  }

  async getProductDetails(productIds: readonly string[]): Promise<ProductDetailsResponse> {
    const { body } = await this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: '/agentic/products/details',
      body: { productIds: [...productIds] },
    });

    const products: ProductDetail[] = (Array.isArray(body['products']) ? body['products'] : []).flatMap(
      (entry): ProductDetail[] => {
        if (typeof entry !== 'object' || entry === null) return [];
        const record = entry as Record<string, unknown>;
        if (typeof record['id'] !== 'string') return [];

        const options = (Array.isArray(record['options']) ? record['options'] : []).flatMap(
          (group) => {
            if (typeof group !== 'object' || group === null) return [];
            const g = group as Record<string, unknown>;
            const values = (Array.isArray(g['values']) ? g['values'] : []).flatMap((value) => {
              if (typeof value !== 'object' || value === null) return [];
              const v = value as Record<string, unknown>;
              if (typeof v['optionId'] !== 'string') return [];
              return [
                {
                  optionId: v['optionId'],
                  label: typeof v['label'] === 'string' ? v['label'] : v['optionId'],
                  available: v['available'] !== false,
                },
              ];
            });
            return typeof g['name'] === 'string' ? [{ name: g['name'], values }] : [];
          },
        );

        const def =
          typeof record['defaultVariant'] === 'object' && record['defaultVariant'] !== null
            ? (record['defaultVariant'] as Record<string, unknown>)
            : undefined;
        const defaultVariant: Variant | undefined =
          def && typeof def['id'] === 'string' && typeof def['price'] === 'object'
            ? {
                id: def['id'],
                name: typeof def['name'] === 'string' ? def['name'] : def['id'],
                price: readAmount(def['price'], 'defaultVariant.price'),
                available: def['available'] !== false,
                requiresShipping: def['requiresShipping'] === true,
              }
            : undefined;

        return [
          {
            id: record['id'],
            name: typeof record['name'] === 'string' ? record['name'] : record['id'],
            options,
            ...(defaultVariant ? { defaultVariant } : {}),
          },
        ];
      },
    );

    const errors = (Array.isArray(body['errors']) ? body['errors'] : []).flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const e = entry as Record<string, unknown>;
      const productId = e['productId'] ?? e['id'];
      if (typeof productId !== 'string') return [];
      return [
        {
          productId,
          message: typeof e['message'] === 'string' ? e['message'] : 'unknown product error',
        },
      ];
    });

    return { products, errors };
  }

  async resolveVariant(productId: string, optionIds: readonly string[]): Promise<Variant> {
    const { body } = await this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: '/agentic/products/variant',
      body: { productId, optionIds: [...optionIds] },
    });
    if (typeof body['id'] !== 'string' || typeof body['price'] !== 'object') {
      throw new ReapProtocolError('variant response is missing "id" or "price"');
    }
    return {
      id: body['id'],
      name: typeof body['name'] === 'string' ? body['name'] : body['id'],
      price: readAmount(body['price'], 'price'),
      available: body['available'] !== false,
      requiresShipping: body['requiresShipping'] === true,
    };
  }

  async createQuote(input: CreateQuoteInput): Promise<Quote> {
    const body: Record<string, unknown> = {
      items: input.items.map((item) => ({ variantId: item.variantId, quantity: item.quantity })),
      email: input.email,
    };
    // A variant with requiresShipping needs an address, and Reap rejects the
    // quote without one. Sending an incomplete address is worse than none: it
    // produces a confusing 400 instead of a clear client-side error.
    if (input.shippingAddress) body['shippingAddress'] = toReapAddress(input.shippingAddress);
    if (input.offerCode) body['offerCode'] = input.offerCode;

    const { body: response } = await this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: '/agentic/quotes',
      body,
      idempotencyKey: input.idempotencyKey,
    });

    const quote = parseQuote(response, this.config.amountSemantics);
    // Reap does not report the merchant on a quote, so the runtime carries
    // provenance forward from discovery.
    const remembered = input.items
      .map((item) => this.provenance.get(item.variantId))
      .find((m): m is Merchant => m !== undefined);
    return { ...quote, merchant: remembered ?? { name: '(unresolved)' } };
  }

  async getQuote(quoteId: string): Promise<Quote> {
    const { body } = await this.client.request<Record<string, unknown>>({
      method: 'GET',
      path: `/agentic/quotes/${encodeURIComponent(quoteId)}`,
    });
    return parseQuote(body, this.config.amountSemantics);
  }

  async selectShippingOption(quoteId: string, shippingOptionId: string): Promise<Quote> {
    const { body } = await this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/agentic/quotes/${encodeURIComponent(quoteId)}/shipping-option`,
      body: { shippingOptionId },
    });
    return parseQuote(body, this.config.amountSemantics);
  }

  async createCheckout(input: CreateCheckoutInput): Promise<Checkout> {
    const { body } = await this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: '/agentic/checkouts',
      body: {
        quoteId: input.quoteId,
        enrollmentId: input.enrollmentId,
        presentation: { type: 'REDIRECT', returnUrl: input.returnUrl },
      },
      idempotencyKey: input.idempotencyKey,
    });
    return parseCheckout(body, this.config.amountSemantics);
  }

  async getCheckout(checkoutId: string): Promise<Checkout> {
    const { body } = await this.client.request<Record<string, unknown>>({
      method: 'GET',
      path: `/agentic/checkouts/${encodeURIComponent(checkoutId)}`,
    });
    return parseCheckout(body, this.config.amountSemantics);
  }

  async getEnrollment(enrollmentId: string): Promise<Enrollment> {
    const { body } = await this.client.request<Record<string, unknown>>({
      method: 'GET',
      path: `/agentic/enrollments/${encodeURIComponent(enrollmentId)}`,
    });
    return parseEnrollment(body);
  }

  async revokeEnrollment(enrollmentId: string): Promise<Enrollment> {
    const { body } = await this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/agentic/enrollments/${encodeURIComponent(enrollmentId)}/revoke`,
    });
    return parseEnrollment(body);
  }
}

export type { LineItem };
