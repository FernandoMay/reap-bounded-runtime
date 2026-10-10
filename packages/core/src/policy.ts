/**
 * The economic authority layer.
 *
 * This engine runs on the server, before any provider call. It is the component
 * that makes the product's promise checkable: an agent can request a purchase,
 * but it cannot cause a charge it was not authorised to cause.
 *
 * Three properties are load-bearing and should not be relaxed:
 *
 *   Fail closed. An absent or unreadable policy denies. It never permits.
 *   Integer money. Every comparison is on minor-unit integers. A policy that
 *   permits 10.00 USD never permits 10.005 USD because a float rounded it.
 *   Budget counts reservations. Amounts for purchases that are approved but not
 *   yet settled are still committed. Counting only settled purchases lets N
 *   concurrent in-flight purchases each pass the check and collectively overrun
 *   the budget — the classic race that turns a spending limit into a suggestion.
 */

import { add, compare, isNegative, type Money } from './money.js';
import { redactString } from './redact.js';
import type {
  DenialCode,
  LineItem,
  Merchant,
  Policy,
  PolicyDecision,
  PurchaseIntent,
  RuleOutcome,
} from './types.js';

/** Reap's documented caps, enforced before a quote is ever attempted. */
const MAX_ITEMS = 20;
const EMAIL_PATTERN =
  /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
/** From the documented `phone` schema: `^\+[1-9]\d{6,14}$`. */
const PHONE_PATTERN = /^\+[1-9]\d{6,14}$/;

export interface BudgetSnapshot {
  /** Settled spend inside the window. */
  readonly settled: Money;
  /** Amounts for purchases approved but not yet settled. */
  readonly reserved: Money;
}

export interface PolicyContext {
  readonly policy: Policy;
  /** Total the purchase will cost, from a real quote. */
  readonly requestedAmount: Money;
  /**
   * The items being purchased. Needed for `variantAllowlist`, which is the only
   * check that does not depend on a merchant name the provider may rebrand.
   */
  readonly items: readonly LineItem[];
  /** Merchant the quote came from. Absent means we cannot check the allowlist. */
  readonly merchant?: Merchant;
  /**
   * Current budget usage. Required whenever `policy.budget` is set. If it is
   * missing the engine denies with `POLICY_UNAVAILABLE` rather than skipping
   * the check.
   */
  readonly budget?: BudgetSnapshot;
}

interface RuleFailure {
  readonly code: DenialCode;
  readonly message: string;
}

/**
 * Structural validation of an intent.
 *
 * Runs before policy limits because a malformed request has no coherent amount
 * to compare against a ceiling, and "you exceeded your budget" is a misleading
 * way to report "you sent a quantity of zero".
 */
export function validateIntent(intent: PurchaseIntent): RuleFailure | null {
  if (!Array.isArray(intent.items) || intent.items.length === 0) {
    return { code: 'INVALID_REQUEST', message: 'a purchase needs at least one item' };
  }
  if (intent.items.length > MAX_ITEMS) {
    return {
      code: 'INVALID_REQUEST',
      message: `a quote accepts at most ${MAX_ITEMS} items, received ${intent.items.length}`,
    };
  }

  for (const [index, item] of intent.items.entries()) {
    if (!item.variantId || item.variantId.trim() === '') {
      return { code: 'INVALID_REQUEST', message: `items.${index}.variantId is required` };
    }
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      return {
        code: 'INVALID_REQUEST',
        message: `items.${index}.quantity must be a positive integer, received ${item.quantity}`,
      };
    }
  }

  if (!intent.email || !EMAIL_PATTERN.test(intent.email)) {
    return { code: 'INVALID_REQUEST', message: 'a valid purchaser email is required' };
  }

  const address = intent.shippingAddress;
  if (address) {
    if (!PHONE_PATTERN.test(address.phone)) {
      return {
        code: 'INVALID_REQUEST',
        message:
          `shippingAddress.phone must match ^\\+[1-9]\\d{6,14}$, received "${address.phone}"`,
      };
    }
    if (!address.addressLine1 || !address.city || !address.country) {
      return {
        code: 'INVALID_REQUEST',
        message: 'shippingAddress requires addressLine1, city and country',
      };
    }
    if (!/^[A-Z]{2}$/.test(address.country)) {
      return {
        code: 'INVALID_REQUEST',
        message: `shippingAddress.country must be an ISO 3166-1 alpha-2 code, received "${address.country}"`,
      };
    }
  }

  return null;
}

/** Normalise a domain for allowlist comparison: lowercase, no `www.`. */
export function canonicalDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^www\./, '');
}

/**
 * Normalise a merchant name for allowlist comparison.
 *
 * Whitespace is collapsed and case is dropped so that "Blend  Station" and
 * "blend station" are the same merchant. Dots are significant here: an entry
 * containing one is treated as a domain, which is why `canonicalName` keeps
 * them intact rather than stripping them.
 */
export function canonicalName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Sum two amounts, or report that they are not commensurable. */
function tryAdd(a: Money, b: Money): Money | null {
  return a.currency === b.currency ? add(a, b) : null;
}

/**
 * Evaluate a policy against a concrete purchase.
 *
 * This wrapper never throws and never lets a request through to the provider.
 * An unexpected fault — a corrupted budget row, a malformed amount — becomes a
 * `POLICY_UNAVAILABLE` denial, because the only safe response to "the limit
 * check did not run" is to not spend.
 */
export function evaluatePolicy(context: PolicyContext): PolicyDecision {
  try {
    return evaluatePolicyUnsafe(context);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    return {
      allowed: false,
      code: 'POLICY_UNAVAILABLE',
      message: `the policy could not be evaluated, so the request is denied by default: ${redactString(detail)}`,
      outcomes: [],
    };
  }
}

/**
 * The rules themselves.
 *
 * Rules run in a fixed order and all of them run, so the returned `outcomes`
 * always explain the full picture rather than just the first failure.
 */
function evaluatePolicyUnsafe(context: PolicyContext): PolicyDecision {
  const { policy, requestedAmount, merchant } = context;
  const outcomes: RuleOutcome[] = [];
  const failures: RuleFailure[] = [];

  const deny = (rule: string, passed: boolean, detail: string, failure?: RuleFailure) => {
    outcomes.push({ rule, passed, detail });
    if (!passed && failure) failures.push(failure);
  };

  // 1. The amount itself must be a usable, non-negative figure.
  const amountSane = !isNegative(requestedAmount);
  deny(
    'amount_is_valid',
    amountSane,
    amountSane ? 'amount is non-negative' : 'a negative amount is not a purchase',
    { code: 'INVALID_REQUEST', message: 'the requested amount is negative' },
  );

  // 2. Currency must be permitted. An empty allowlist permits nothing.
  const allowedCurrencies = policy.allowedCurrencies ?? [];
  const currencyAllowed = allowedCurrencies.some((c) => c.toUpperCase() === requestedAmount.currency);
  deny(
    'currency_allowed',
    currencyAllowed,
    currencyAllowed
      ? `${requestedAmount.currency} is permitted`
      : `${requestedAmount.currency} is not in the permitted currency set`,
    {
      code: 'CURRENCY_NOT_ALLOWED',
      message: `currency ${requestedAmount.currency} is not permitted`,
    },
  );

  // 3. What may be bought, and from whom. Two independent checks, because the
  //    provider discloses a merchant name but no domain, and a name alone is not
  //    a security boundary. Either one can be pinned; both run when configured.

  const variantAllowlist = policy.variantAllowlist;
  if (variantAllowlist !== undefined) {
    const requestedIds = context.items.map((item) => item.variantId);
    const permitted = new Set(variantAllowlist);
    const offending = requestedIds.filter((id) => !permitted.has(id));
    const allAllowed = offending.length === 0;
    deny(
      'variant_allowed',
      allAllowed,
      allAllowed
        ? `all ${requestedIds.length} variant(s) are on the allowlist`
        : `variant(s) not on the allowlist: ${offending.join(', ')}`,
      allAllowed
        ? undefined
        : {
            code: 'VARIANT_NOT_ALLOWED',
            message: `the agent may not purchase variant(s): ${offending.join(', ')}`,
          },
    );
  }

  const allowlist = policy.merchantAllowlist;
  const merchantName = merchant?.name ? canonicalName(merchant.name) : undefined;
  const merchantDomain = merchant?.domain ? canonicalDomain(merchant.domain) : undefined;

  if (allowlist === undefined) {
    // No merchant allowlist configured at all is a deliberate operator choice.
    deny('merchant_allowed', true, 'no merchant allowlist configured');
  } else if (merchantName === undefined && merchantDomain === undefined) {
    deny(
      'merchant_allowed',
      false,
      'the merchant of this purchase is unknown, so it cannot be checked against the allowlist',
      {
        code: 'MERCHANT_NOT_ALLOWED',
        message: 'the merchant of this purchase could not be determined',
      },
    );
  } else {
    const permittedEntries = allowlist.map((entry) =>
      entry.includes('.') ? canonicalDomain(entry) : canonicalName(entry),
    );
    const merchantAllowed =
      (merchantName !== undefined && permittedEntries.includes(merchantName)) ||
      (merchantDomain !== undefined && permittedEntries.includes(merchantDomain));
    deny(
      'merchant_allowed',
      merchantAllowed,
      merchantAllowed
        ? `merchant ${merchantName ?? merchantDomain} is permitted`
        : `merchant ${merchantName ?? merchantDomain} is not on the allowlist`,
      merchantAllowed
        ? undefined
        : {
            code: 'MERCHANT_NOT_ALLOWED',
            message: `merchant ${merchantName ?? merchantDomain} is not on the allowlist`,
          },
    );
  }

  // 4. Per-purchase ceiling. An omitted ceiling means no per-purchase limit,
  //    which is only safe when a cumulative budget is also configured; the
  //    budget rule below is what actually bounds spend in that case.
  const maxPer = policy.maxAmountPerPurchase;
  if (maxPer === undefined) {
    deny('max_amount_per_purchase', true, 'no per-purchase ceiling configured');
  } else if (maxPer.currency !== requestedAmount.currency) {
    // The ceiling is denominated in another currency, so there is no way to say
    // whether this purchase fits inside it. Refuse rather than assume.
    deny(
      'max_amount_per_purchase',
      false,
      `the per-purchase ceiling is in ${maxPer.currency} but the purchase is in ${requestedAmount.currency}`,
      {
        code: 'CURRENCY_NOT_ALLOWED',
        message: `the per-purchase ceiling is denominated in ${maxPer.currency} and cannot bound a ${requestedAmount.currency} purchase`,
      },
    );
  } else {
    const withinMax = compare(requestedAmount, maxPer) <= 0;
    deny(
      'max_amount_per_purchase',
      withinMax,
      withinMax
        ? `within the per-purchase ceiling of ${maxPer.currency} ${maxPer.minor}`
        : `requested amount exceeds the per-purchase ceiling of ${maxPer.currency} ${maxPer.minor}`,
      withinMax
        ? undefined
        : {
            code: 'AMOUNT_EXCEEDS_LIMIT',
            message: `amount exceeds the per-purchase limit of ${maxPer.currency} ${maxPer.minor} minor units`,
          },
    );
  }

  // 5. Cumulative budget, counting in-flight reservations as committed spend.
  if (policy.budget !== undefined) {
    const snapshot = context.budget;
    if (!snapshot) {
      deny(
        'cumulative_budget',
        false,
        'a budget is configured but current usage could not be read',
        {
          code: 'POLICY_UNAVAILABLE',
          message: 'budget usage is unavailable, so the request is denied by default',
        },
      );
    } else {
      // Comparing money across currencies is meaningless, so a mismatch is a
      // refusal rather than an exception. Letting `add` throw here would turn a
      // policy decision into a 500 and, worse, let a crash path stand in for a
      // decision the engine was supposed to make.
      const committed = tryAdd(snapshot.settled, snapshot.reserved);
      if (committed === null) {
        deny(
          'cumulative_budget',
          false,
          'budget snapshot mixes currencies and cannot be totalled',
          {
            code: 'POLICY_UNAVAILABLE',
            message: 'budget usage could not be totalled, so the request is denied by default',
          },
        );
      } else if (committed.currency !== requestedAmount.currency) {
        deny(
          'cumulative_budget',
          false,
          `budget is denominated in ${policy.budget.currency} but the purchase is in ${requestedAmount.currency}`,
          {
            code: 'CURRENCY_NOT_ALLOWED',
            message: `the ${policy.budgetWindow ?? 'configured'} budget is denominated in ${policy.budget.currency} and cannot bound a ${requestedAmount.currency} purchase`,
          },
        );
      } else {
        const projected = add(committed, requestedAmount);
        const fits = compare(projected, policy.budget) <= 0;
        deny(
          'cumulative_budget',
          fits,
          fits
            ? `within budget: committed ${committed.currency} ${committed.minor} + requested ${requestedAmount.minor} = ${projected.minor} of ${policy.budget.minor}`
            : `requested amount would exceed the budget: committed ${committed.currency} ${committed.minor}, requested ${requestedAmount.minor}, budget ${policy.budget.minor}`,
          fits
            ? undefined
            : {
                code: 'BUDGET_EXCEEDED',
                message: `this purchase would exceed the ${policy.budgetWindow ?? 'configured'} budget`,
              },
        );
      }
    }
  }

  if (failures.length === 0) {
    return { allowed: true, outcomes };
  }

  // Report the most specific failure first so the operator sees the actionable
  // reason rather than a downstream symptom.
  const priority: readonly DenialCode[] = [
    'INVALID_REQUEST',
    'POLICY_UNAVAILABLE',
    'CURRENCY_NOT_ALLOWED',
    'VARIANT_NOT_ALLOWED',
    'MERCHANT_NOT_ALLOWED',
    'AMOUNT_EXCEEDS_LIMIT',
    'BUDGET_EXCEEDED',
  ];
  const primary = failures.reduce((best, f) =>
    priority.indexOf(f.code) < priority.indexOf(best.code) ? f : best,
  );

  return {
    allowed: false,
    code: primary.code,
    message: primary.message,
    outcomes,
  };
}

/** True when the policy declares no limits at all — used only by diagnostics. */
export function isPolicyUnbounded(policy: Policy): boolean {
  return (
    policy.maxAmountPerPurchase === undefined &&
    policy.budget === undefined &&
    (policy.allowedCurrencies?.length ?? 0) === 0
  );
}
