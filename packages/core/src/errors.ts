/**
 * The Reap Agentic Payments error taxonomy, transcribed from the published
 * OpenAPI description of `POST /agentic/quotes` and the surrounding endpoints.
 *
 * Every code below is one Reap actually documents. Nothing here is inferred.
 * The point of encoding them is to separate the two questions a payment runtime
 * must answer on every failure:
 *
 *   1. Is this our fault (a request we must correct) or theirs (a transient
 *      condition worth a fresh attempt)?
 *   2. May we try again, and if so, when?
 *
 * Guessing wrong in either direction is expensive. Retrying a request Reap
 * already rejected with `QUOTE_UNFULFILLABLE` burns a merchant round trip and
 * changes nothing. Failing to retry `AGENTIC_SERVICE_UNAVAILABLE` turns a blip
 * into a failed purchase.
 */

/** Error codes Reap documents for the agentic surface. */
export const REAP_ERROR_CODES = [
  // 400 — the request must change before it can succeed.
  'AGENTIC_REQUEST_REJECTED',
  'CHECKOUT_URL_INVALID',
  'CARD_PAYMENT_UNAVAILABLE',
  'OFFER_CODE_INVALID',
  'OFFER_CODE_EXPIRED',
  'QUOTE_UNFULFILLABLE',
  // 403 — configuration, not request. Fixing the request will never help.
  'AGENTIC_PAYMENTS_NOT_ENABLED',
  // 404 — the referenced resource does not exist.
  'AGENTIC_RESOURCE_NOT_FOUND',
  // 409 — state moved on. A fresh quote is required.
  'QUOTE_EXPIRED',
  'VARIANT_UNAVAILABLE',
  // 503 — transient. The only codes where a retry is meaningful.
  'AGENTIC_SERVICE_UNAVAILABLE',
  'QUOTE_TEMPORARILY_UNAVAILABLE',
] as const;

export type ReapErrorCode = (typeof REAP_ERROR_CODES)[number];

/** `detail.reason` values documented under `QUOTE_UNFULFILLABLE`. */
export const QUOTE_UNFULFILLABLE_REASONS = [
  'INVALID_PHONE',
  'STATE_OR_PROVINCE_REQUIRED',
  'ITEMS_UNSHIPPABLE',
  'ADDRESS_LINE_2_REQUIRED',
] as const;

export type QuoteUnfulfillableReason = (typeof QUOTE_UNFULFILLABLE_REASONS)[number];

/** `detail.reason` values documented under `CHECKOUT_URL_INVALID`. */
export const CHECKOUT_URL_INVALID_REASONS = [
  'NOT_FOUND',
  'EXPIRED',
  'INVALID',
  'MERCHANT_CONTEXT_UNVERIFIED',
] as const;

export type CheckoutUrlInvalidReason = (typeof CHECKOUT_URL_INVALID_REASONS)[number];

/**
 * Whether a fresh attempt can succeed.
 *
 * `CORRECT_REQUEST` means Reap will reject an identical retry forever; the
 * caller must change something first. `RETRY_SAME_INPUT` is reserved for the
 * two 503 codes, and even then Reap documents that it makes a single merchant
 * request per quote attempt — so a retry means a brand new quote, not a replay
 * of the same one.
 */
export type RecoveryPath = 'CORRECT_REQUEST' | 'FRESH_RESOURCE' | 'RETRY_SAME_INPUT' | 'OPERATOR_ACTION';

const RECOVERY: Readonly<Record<ReapErrorCode, RecoveryPath>> = {
  AGENTIC_REQUEST_REJECTED: 'CORRECT_REQUEST',
  CHECKOUT_URL_INVALID: 'CORRECT_REQUEST',
  CARD_PAYMENT_UNAVAILABLE: 'CORRECT_REQUEST',
  OFFER_CODE_INVALID: 'CORRECT_REQUEST',
  OFFER_CODE_EXPIRED: 'CORRECT_REQUEST',
  QUOTE_UNFULFILLABLE: 'CORRECT_REQUEST',

  AGENTIC_PAYMENTS_NOT_ENABLED: 'OPERATOR_ACTION',
  AGENTIC_RESOURCE_NOT_FOUND: 'CORRECT_REQUEST',

  // Both 409s mean the thing we priced no longer exists in that shape.
  QUOTE_EXPIRED: 'FRESH_RESOURCE',
  VARIANT_UNAVAILABLE: 'FRESH_RESOURCE',

  AGENTIC_SERVICE_UNAVAILABLE: 'RETRY_SAME_INPUT',
  QUOTE_TEMPORARILY_UNAVAILABLE: 'RETRY_SAME_INPUT',
};

export function recoveryPathFor(code: ReapErrorCode): RecoveryPath {
  return RECOVERY[code];
}

export function isRetryable(code: ReapErrorCode): boolean {
  return RECOVERY[code] === 'RETRY_SAME_INPUT';
}

/** HTTP status Reap documents for each code. */
const HTTP_STATUS: Readonly<Record<ReapErrorCode, number>> = {
  AGENTIC_REQUEST_REJECTED: 400,
  CHECKOUT_URL_INVALID: 400,
  CARD_PAYMENT_UNAVAILABLE: 400,
  OFFER_CODE_INVALID: 400,
  OFFER_CODE_EXPIRED: 400,
  QUOTE_UNFULFILLABLE: 400,
  AGENTIC_PAYMENTS_NOT_ENABLED: 403,
  AGENTIC_RESOURCE_NOT_FOUND: 404,
  QUOTE_EXPIRED: 409,
  VARIANT_UNAVAILABLE: 409,
  AGENTIC_SERVICE_UNAVAILABLE: 503,
  QUOTE_TEMPORARILY_UNAVAILABLE: 503,
};

export interface ReapFieldError {
  /** Dot-separated path, e.g. `items.0.variantId`. */
  readonly field: string;
  readonly message: string;
}

export interface ReapErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly detail?: unknown;
  };
}

/**
 * A failed call to Reap, normalised.
 *
 * Carries enough structure for a caller to branch without string-matching, and
 * enough provenance for the audit log to explain the failure later.
 */
export class ReapApiError extends Error {
  override readonly name = 'ReapApiError';

  constructor(
    readonly code: ReapErrorCode,
    message: string,
    readonly httpStatus: number,
    readonly detail?: {
      readonly quoteUnfulfillableReason?: QuoteUnfulfillableReason;
      readonly checkoutUrlInvalidReason?: CheckoutUrlInvalidReason;
      readonly fieldErrors?: readonly ReapFieldError[];
    },
    /** Present only on `QUOTE_TEMPORARILY_UNAVAILABLE`. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }

  get recovery(): RecoveryPath {
    return recoveryPathFor(this.code);
  }

  get retryable(): boolean {
    return isRetryable(this.code);
  }

  /**
   * Operator-facing explanation of what to change.
   *
   * `STATE_OR_PROVINCE_REQUIRED` and `ADDRESS_LINE_2_REQUIRED` are by far the
   * most common real-world causes of a rejected quote, and both are caused by
   * the merchant demanding a field the request schema marks optional. They are
   * called out explicitly because "add region" is not obvious from a 400.
   */
  get remedy(): string {
    switch (this.code) {
      case 'QUOTE_UNFULFILLABLE':
        switch (this.detail?.quoteUnfulfillableReason) {
          case 'INVALID_PHONE':
            return 'The merchant rejected the phone number. Use a real reachable number in the destination country; reserved or invented ranges are refused.';
          case 'STATE_OR_PROVINCE_REQUIRED':
            return 'The merchant requires a state or province. Populate shippingAddress.region (not `state`) with the subdivision code for the destination country.';
          case 'ADDRESS_LINE_2_REQUIRED':
            return 'The merchant requires a second address line. Populate shippingAddress.addressLine2, for example the colonia or interior number.';
          case 'ITEMS_UNSHIPPABLE':
            return 'The merchant cannot ship these items to the destination address. Change the address or choose another product.';
          default:
            return 'The merchant cannot fulfil this quote as requested. Correct the request before retrying.';
        }
      case 'AGENTIC_REQUEST_REJECTED':
        return this.detail?.fieldErrors?.length
          ? `Request rejected at: ${this.detail.fieldErrors.map((f) => `${f.field} (${f.message})`).join(', ')}.`
          : 'The request was rejected. Correct the payload before retrying.';
      case 'CHECKOUT_URL_INVALID':
        return 'The checkout URL cannot be used. Verify the merchant domain is allowlisted for this integration and that the URL is a current cart permalink.';
      case 'CARD_PAYMENT_UNAVAILABLE':
        return 'Card payment is unavailable for this checkout. Choose another checkout or merchant; retrying the same one will not help.';
      case 'OFFER_CODE_INVALID':
        return 'The offer code is not recognised. Remove or correct it.';
      case 'OFFER_CODE_EXPIRED':
        return 'The offer code has expired. Remove it.';
      case 'AGENTIC_PAYMENTS_NOT_ENABLED':
        return 'Agentic Payments is not enabled for this project. This must be turned on by Reap for the API key in use.';
      case 'AGENTIC_RESOURCE_NOT_FOUND':
        return 'The referenced resource does not exist for this API key. Check the identifier.';
      case 'QUOTE_EXPIRED':
        return 'The quote expired. Create a new quote; prices come from the merchant and may have moved.';
      case 'VARIANT_UNAVAILABLE':
        return 'The selected variant is sold out. Resolve a new variant from the product details.';
      case 'AGENTIC_SERVICE_UNAVAILABLE':
        return 'Reap is temporarily unavailable. Retry after a short delay.';
      case 'QUOTE_TEMPORARILY_UNAVAILABLE':
        return this.retryAfterSeconds !== undefined
          ? `The merchant did not return pricing. Retry after ${this.retryAfterSeconds}s with a new quote.`
          : 'The merchant did not return pricing. Retry with a new quote after a short delay.';
      default:
        return 'Unexpected provider error.';
    }
  }
}

/** A network-level failure: DNS, TLS, connection reset, or our own timeout. */
export class ReapTransportError extends Error {
  override readonly name = 'ReapTransportError';
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/** The response did not match the documented schema. Never silently accepted. */
export class ReapProtocolError extends Error {
  override readonly name = 'ReapProtocolError';
  constructor(message: string) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parse a Reap error body into a typed error.
 *
 * An unrecognised code is surfaced as a protocol error rather than being
 * downgraded to a generic failure: an undocumented code means the integration
 * assumptions are stale, and that deserves to be loud.
 */
export function parseReapError(
  httpStatus: number,
  body: unknown,
  headers: { get(name: string): string | null },
): ReapApiError {
  if (!isRecord(body) || !isRecord(body.error) || typeof body.error.code !== 'string') {
    throw new ReapProtocolError(
      `Reap returned a ${httpStatus} without a recognisable error envelope`,
    );
  }

  const { code, message } = body.error as { code: string; message: string };
  if (!(REAP_ERROR_CODES as readonly string[]).includes(code)) {
    throw new ReapProtocolError(`Reap returned undocumented error code: ${code}`);
  }

  const detail = body.error.detail;
  const detailRecord = isRecord(detail) ? detail : undefined;
  const reason = detailRecord?.['reason'];

  const retryAfterHeader = headers.get('Retry-After');
  const retryAfter = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : Number.NaN;

  return new ReapApiError(
    code as ReapErrorCode,
    typeof message === 'string' ? message : code,
    HTTP_STATUS[code as ReapErrorCode] ?? httpStatus,
    {
      ...(code === 'QUOTE_UNFULFILLABLE' && typeof reason === 'string'
        ? { quoteUnfulfillableReason: reason as QuoteUnfulfillableReason }
        : {}),
      ...(code === 'CHECKOUT_URL_INVALID' && typeof reason === 'string'
        ? { checkoutUrlInvalidReason: reason as CheckoutUrlInvalidReason }
        : {}),
      ...(detailRecord && Array.isArray(detailRecord['errors'])
        ? {
            fieldErrors: (detailRecord['errors'] as unknown[]).flatMap((e) =>
              isRecord(e) && typeof e['field'] === 'string' && typeof e['message'] === 'string'
                ? [{ field: e['field'], message: e['message'] }]
                : [],
            ),
          }
        : {}),
    },
    code === 'QUOTE_TEMPORARILY_UNAVAILABLE' && Number.isFinite(retryAfter) ? retryAfter : undefined,
  );
}
