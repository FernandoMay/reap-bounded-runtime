# The Reap Agentic Payments contract, as implemented

Everything below was read from the published OpenAPI and guides at
<https://docs.reap.global> (Mintlify; the same content is served as Markdown by
appending `.md` to any documentation URL, and `https://docs.reap.global/llms.txt`
is the machine-readable index).

Nothing in this file was inferred from the buildathon group chat. Where the
group's folklore and the documentation disagree, the documentation wins and the
disagreement is called out.

## Base URL and headers

| Item | Value |
| --- | --- |
| Sandbox (Singapore) | `https://sandbox.api.reap.global` or `https://sg.sandbox.api.reap.global` |
| Sandbox (Mexico) | `https://mx.sandbox.api.reap.global` |
| Production | `https://prod.api.reap.global`, `https://sg.prod...`, `https://mx.prod...` |
| `Authorization` | `Bearer <api key>` |
| `Reap-Version` | `2025-02-14` — the schema enum currently allows exactly this one value |

`Idempotency-Key` is **required** on `POST /agentic/enrollments`,
`POST /agentic/quotes` and `POST /agentic/checkouts`. Responses are cached for
24h per key, so a retry with the same key replays the first response.

## Endpoints implemented

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/agentic/products/search` | Catalog search across merchants |
| POST | `/agentic/products/details` | Expand products into options and variants |
| POST | `/agentic/products/variant` | Resolve selected options into one variant |
| POST | `/agentic/quotes` | Price a cart from variants or a checkout URL |
| GET | `/agentic/quotes/:id` | Re-read a quote |
| POST | `/agentic/quotes/:id/shipping-option` | Change shipping and re-price |
| POST | `/agentic/checkouts` | Open a charge against an ACTIVE enrollment |
| GET | `/agentic/checkouts/:id` | Read a checkout and its status |
| GET | `/agentic/enrollments/:id` | Read an enrollment |
| POST | `/agentic/enrollments/:id/revoke` | Revoke a stored card |
| GET | `/agentic/enrollments` | List one owner's enrollments |

Not implemented, and why:

- `POST /agentic/enrollments` and the hosted card-entry flow. Creating an
  enrollment requires redirecting a human to a Reap-hosted page and reading the
  result back. The runtime consumes enrollments; it does not create them. An
  existing ACTIVE enrollment is supplied through `enrollmentId`.
- `externalCheckout` quoting. Reap restricts it to merchant domains allowlisted
  for the integration. Not available without an allowlisting agreement.
- Mandates (`/agentic/mandates/*`). The documentation carries
  `MANDATES_AVAILABLE = false` and states plainly that the endpoints are **not
  live in sandbox or production**. Building on them would mean building on
  endpoints that do not exist.

## The `shippingAddress` trap

This is the single most common cause of a rejected quote, and it is worth
stating precisely because the group chat's version of it was wrong.

The request schema:

```
required: firstName, lastName, phone, addressLine1, city, country
optional: region, addressLine2, postalCode
phone pattern: ^\+[1-9]\d{6,14}$
```

`region` is **optional in the schema but required by merchants**. That gap is
why `QUOTE_UNFULFILLABLE` carries these reasons:

| `detail.reason` | What to do |
| --- | --- |
| `STATE_OR_PROVINCE_REQUIRED` | Populate `region`. **Not** `state` — Reap does not accept that field. |
| `ADDRESS_LINE_2_REQUIRED` | Populate `addressLine2` (colonia, interior, floor). |
| `INVALID_PHONE` | Use a real reachable number. Reserved ranges are refused. |
| `ITEMS_UNSHIPPABLE` | The merchant will not ship there. Change address or product. |

### What the group chat got wrong

Several teams hit `QUOTE_TEMPORARILY_UNAVAILABLE` (503) and, following the
advice in the thread, concluded it was rate limiting caused by retrying too
often. The documentation says the opposite:

> Reap makes one quote attempt and does not retry a failed merchant request.

`QUOTE_TEMPORARILY_UNAVAILABLE` means **the merchant did not return pricing**.
It carries a documented `Retry-After` header, so the correct response is to
wait that long and issue a **new** quote, not to replay the same one or to
apply a generic backoff. Treating it as a rate limit sends you down a path that
cannot fix the actual problem.

A phone number like `+14155550123` passes the schema pattern and is still
rejected by merchants, because `555-0123` is a range reserved for fiction.

## Merchant identity is not what it looks like

Two constraints that shaped the policy design:

1. **The quote response contains no merchant at all.** It returns `id`,
   `shippingOptions`, `amountBreakdown` and `expiresAt`. Nothing else.
2. **The search response exposes `merchant.name` and no domain.** No URL, no
   canonical host.

Consequences:

- A merchant **allowlist keyed on domain cannot be enforced** from provider
  data. This runtime matches on merchant name, and documents plainly that a
  name is not authenticated — two merchants can present the same string.
- `variantAllowlist` exists as the real control. Variant ids are
  provider-issued and cannot be re-spelled by a merchant, so pinning them is a
  genuine constraint on what may be bought.
- The runtime records variant → merchant provenance during discovery. When
  provenance is missing, the policy engine **denies**, because an allowlist
  cannot be checked against nothing.

## Amount semantics — an assumption, stated

Reap documents amounts as a JSON `number` without stating whether they are
major units (`129.00`) or minor units (`12900`). The documented examples point
to **major units**: a 129 USD product price, a 150 USD mandate ceiling.

This runtime defaults to `REAP_AMOUNT_SEMANTICS=MAJOR`. Conversion goes through
the decimal string form, never through float multiplication, so `142.85`
becomes exactly `14285` minor units. Setting the variable to `MINOR` flips the
interpretation without a code change if the assumption is ever disproved
against live data.

The two interpretations are applied uniformly. An earlier version of the client
honoured the setting for quotes and silently ignored it for checkouts, which
would have reported checkout amounts 100x too large under `MINOR`.

Under `MINOR`, a fractional amount is **rejected** rather than converted:
minor units are integers by definition, so receiving `24.85` means the wire
format contradicts the configured interpretation. Failing loudly is the only
safe response — scaling a fractional value by assumption is precisely the kind
of quiet 100x error this module exists to prevent.

## Statuses

Enrollment:

```
REQUIRES_ACTION ──(hosted step completed)──> ACTIVE ──> REVOKED
       │                                          └──> FAILED
       └──(past expiresAt)──> EXPIRED
```

Checkout:

```
REQUIRES_ACTION ──(human approves)──> PROCESSING ──> COMPLETED
       │                                └──────────> FAILED
       └──(not approved before expiresAt)──> EXPIRED
```

`COMPLETED`, `FAILED` and `EXPIRED` are terminal. Neither `FAILED` nor
`EXPIRED` can be retried in place; both need a fresh quote and a fresh
checkout.

`PROCESSING` is not guaranteed to be observed. Polling is not atomic, so a
purchase approved and settled between two reads is reported `COMPLETED`
without the runtime ever seeing the intermediate state. The state machine
allows that edge for exactly this reason.

## The full error taxonomy

Implemented in `packages/core/src/errors.ts`, transcribed from the OpenAPI. The
classification is the point: it tells a caller whether a retry can help.

| Code | HTTP | Retry? | Meaning |
| --- | --- | --- | --- |
| `AGENTIC_REQUEST_REJECTED` | 400 | no | Payload rejected; `detail.errors[]` names the fields |
| `CHECKOUT_URL_INVALID` | 400 | no | URL unusable; `detail.reason` says which rule |
| `CARD_PAYMENT_UNAVAILABLE` | 400 | no | Card payment not offered for this checkout |
| `OFFER_CODE_INVALID` | 400 | no | Offer code unrecognised |
| `OFFER_CODE_EXPIRED` | 400 | no | Offer code expired |
| `QUOTE_UNFULFILLABLE` | 400 | no | Merchant will not price it; `detail.reason` says why |
| `AGENTIC_PAYMENTS_NOT_ENABLED` | 403 | no | Feature off for this key. Operator action. |
| `AGENTIC_RESOURCE_NOT_FOUND` | 404 | no | Unknown id for this key |
| `QUOTE_EXPIRED` | 409 | fresh resource | Create a new quote |
| `VARIANT_UNAVAILABLE` | 409 | fresh resource | Sold out; resolve another variant |
| `AGENTIC_SERVICE_UNAVAILABLE` | 503 | yes | Reap temporarily unavailable |
| `QUOTE_TEMPORARILY_UNAVAILABLE` | 503 | yes | Merchant did not price. Carries `Retry-After`. |

An **undocumented** error code raises a protocol error rather than being
downgraded to a generic failure. An unknown code means the integration
assumptions are stale, and that deserves to be loud.

## Sandbox specifics

- `X-Simulate-Checkout: COMPLETED` settles a checkout without a human clicking
  the hosted approval page. Documented as **sandbox only; rejected in
  production.** This runtime additionally refuses to build a configuration that
  sets it against a production host, so an embedding application cannot bypass
  that rule.
- Test cards are documented publicly. They behave like real cards and move no
  money, and are declined outside the Agentic Payments API.
- The OTP for card verification is a fixed value in the sandbox.
- Sandbox purchases are simulated: nothing ships and no money moves.

This runtime never handles any of it. There is no code path in the provider
boundary that accepts a card number, a CVC, or an OTP. Reap's hosted pages
collect those; the agent's runtime never sees them.

## Using the mock provider

`MockProvider` fixtures are transcribed from the documented responses above. It
exists so the runtime can be developed and tested with no network and no
credentials.

Code written against it is written against the real contract, so it is a
meaningful test double — but it is still a test double. Its `kind` is `mock`,
the dashboard says `MOCK MODE` in a banner on every screen, and
`/api/health` reports it. A response from it is never presented as a real
sandbox result.
