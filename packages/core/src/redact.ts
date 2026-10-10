/**
 * Secret redaction.
 *
 * Everything this runtime logs, stores in the audit trail, or returns over the
 * API passes through here. The runtime never legitimately handles a card number
 * — Reap's hosted pages collect those — so any PAN-shaped string that turns up
 * is either a bug or an injection attempt, and both deserve to be destroyed
 * rather than written down.
 *
 * The digit heuristic is Luhn-checked rather than length-based on purpose.
 * Matching any 13-19 digit run would redact Reap's own identifiers (quote ids,
 * variant ids, idempotency keys are hex, but order references are not) and train
 * whoever reads the logs to ignore redaction markers. Redacting only what is
 * actually card-shaped keeps the signal.
 */

/** Keys whose values are secret regardless of shape. */
const SECRET_KEY_PATTERN =
  /(authorization|api[-_]?key|secret|passwo?rd|token|credential|private[-_]?key|bearer)/i;

/** Keys holding a one-time password. */
const OTP_KEY_PATTERN = /(otp|one[-_]?time[-_]?(code|password)|verification[-_]?code)/i;

/** Keys holding a card verification value. */
const CVV_KEY_PATTERN = /(cvv|cvc2|cvc|security[-_]?code|card[-_]?verification)/i;

export const REDACTED = '[REDACTED]';

/**
 * Strip every digit of a PAN except the last four.
 *
 * The last four are what a receipt legitimately shows and what an operator needs
 * to identify which stored card an enrollment refers to. Reap itself exposes
 * only `last4`, so keeping four digits leaks nothing the provider does not
 * already.
 */
function redactPan(digits: string): string {
  return `${REDACTED}:${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

/** Standard Luhn checksum. Used to tell a real card number from a random digit run. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (value < 0 || value > 9) return false;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Digit runs of 13-19, optionally grouped by spaces or dashes. */
const PAN_CANDIDATE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;

function redactPanCandidates(text: string): string {
  return text.replace(PAN_CANDIDATE, (match) => {
    const digits = match.replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19) return match;
    if (!passesLuhn(digits)) return match;
    return redactPan(digits);
  });
}

/** `sk_sbx_...`, `sk_live_...`, and the general `sk_`/`pk_` key shapes. */
const API_KEY_CANDIDATE =
  /\b(?:sk|pk|rk)_(?:[a-z]{2,4}_)?[A-Za-z0-9_-]{8,}\b/g;

/** `Bearer <anything>` regardless of token shape. */
const BEARER_CANDIDATE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

/**
 * Redact secrets from a free-text string.
 *
 * Order matters: bearer tokens are matched before the generic key shapes so
 * that `Bearer sk_sbx_abc123` does not become `Bearer [REDACTED]` while leaving
 * a recoverable tail behind.
 */
export function redactString(input: string): string {
  return input
    .replace(BEARER_CANDIDATE, `Bearer ${REDACTED}`)
    .replace(API_KEY_CANDIDATE, REDACTED)
    .replace(PAN_CANDIDATE, (match) => {
      const digits = match.replace(/[ -]/g, '');
      if (digits.length < 13 || digits.length > 19) return match;
      if (!passesLuhn(digits)) return match;
      return redactPan(digits);
    });
}

/**
 * Deep-redact an arbitrary JSON-ish value.
 *
 * Cycles are tolerated because this runs on error paths, and an error path that
 * throws while redacting is an error path that leaks.
 */
export function redactValue(input: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof input === 'string') return redactString(input);
  if (input === null || typeof input !== 'object') return input;

  if (seen.has(input as object)) return '[Circular]';
  seen.add(input as object);

  if (Array.isArray(input)) {
    return input.map((item) => redactValue(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (CVV_KEY_PATTERN.test(key)) {
      out[key] = REDACTED;
    } else if (OTP_KEY_PATTERN.test(key)) {
      out[key] = REDACTED;
    } else if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = redactValue(value, seen);
    }
  }
  return out;
}

/**
 * Redact the headers of an outbound or inbound HTTP message.
 *
 * `Idempotency-Key` and `Reap-Version` survive deliberately: they are needed to
 * debug a replayed request and carry no authority on their own.
 */
export function redactHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = /(authorization|api[-_]?key|cookie)/i.test(key) ? REDACTED : redactString(value);
  }
  return out;
}
