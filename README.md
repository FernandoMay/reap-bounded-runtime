# Bounded Agent Runtime

A programmable economic-authority layer for autonomous agents.

An agent can discover a product, obtain a real quote from a merchant, and
request a purchase. Before any provider operation is allowed, the runtime
enforces spending policy on the server. The user approves the charge on Reap's
hosted page. The runtime records the lifecycle and the evidence.

**The agent never holds payment credentials, and cannot approve its own
purchases.** That is not a guideline in this README — it is enforced by the
provider boundary having no method that accepts a card number, and by a state
machine with no transition that advances a charge without the provider
reporting one.

Built on [Reap Agentic Payments](https://docs.reap.global/agentic-payments/overview).
All purchases are sandbox simulations: nothing ships and no money moves.

---

## Status

| | |
| --- | --- |
| Unit and integration tests | 179 passing, 0 failing |
| End-to-end walkthrough (mock) | 20 assertions passing |
| Typecheck | clean across all four packages |
| **Real Reap sandbox calls** | **none — see [verification evidence](docs/evidence/README.md)** |

The runtime is complete and exercised end to end against a fixture provider
whose responses are transcribed from Reap's published OpenAPI. **No request has
been sent to Reap's sandbox**, because no API key was available. The section
[What is not verified](#what-is-not-verified) states exactly what that leaves
untested.

## Quick start

```bash
npm install
cp .env.development .env          # already set to mock mode
npm run build

# terminal 1
npm run dev:server

# terminal 2
npm run dev:dashboard             # http://localhost:5173
```

Paste the value of `RUNTIME_API_TOKEN` from your `.env` into the unlock screen.
The dashboard shows a **MOCK MODE** banner; that is accurate and it stays there
until you configure a real sandbox.

Run the walkthrough:

```bash
RUNTIME_API_TOKEN=$(grep RUNTIME_API_TOKEN .env | cut -d= -f2) ./scripts/e2e.sh
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  apps/dashboard        React console. Shows real state only. │
└────────────────────────────┬────────────────────────────────┘
                             │  Bearer token on every request
┌────────────────────────────▼────────────────────────────────┐
│  packages/server                                             │
│    server.ts    auth, routes, error envelope                 │
│    service.ts   validate → quote → POLICY → reserve →        │
│                 checkout → await human                       │
│    store.ts     SQLite. Idempotency, budget, audit trail.    │
└──────┬──────────────────────────────────┬───────────────────┘
       │ domain vocabulary only           │ provider boundary
┌──────▼──────────────────┐   ┌───────────▼───────────────────┐
│  packages/core          │   │  packages/provider            │
│    money.ts   integers  │   │    types.ts     the boundary  │
│    policy.ts  authority │   │    reap/client  real Reap     │
│    lifecycle.ts states  │   │    mock/        fixtures      │
│    errors.ts   taxonomy │   │    http.ts      transport     │
│    redact.ts  secrets   │   │    config.ts    validation   │
└─────────────────────────┘   └───────────────────────────────┘
```

The dependency runs one way. `core` knows nothing about payments providers, so
a provider's wire format cannot leak into the economic authority layer.

### Why policy sits where it does

```
validate → quote → POLICY → reserve → checkout → await human
```

The ordering is the product:

- **Before the quote** there is no real amount to check. Prices come from the
  merchant, and only a quote reveals them. A limit checked before the quote
  would be checking a guess.
- **After the checkout** the charge already exists.
- The window where the true amount is known and nothing is committed is exactly
  between them, and it is narrow.

### Why the budget counts reservations

Budget usage includes purchases that are approved but not yet settled. Two
concurrent purchases of 60 against a 100 budget both pass a check that only
counts settled spend, then together overrun it. Counting the second as
reserved makes the second check fail. This was found by the E2E script, not by
inspection — see [the bug table](docs/evidence/README.md#6-bugs-found-by-these-tests).

## Policies

Evaluated server-side, before any provider call, and never bypassed by the
dashboard or by a calling agent.

| Policy | Behaviour |
| --- | --- |
| `maxAmountPerPurchase` | Ceiling on a single purchase, inclusive of shipping and tax |
| `allowedCurrencies` | Currencies the agent may operate in |
| `merchantAllowlist` | Matched against merchant name, or domain when known |
| `variantAllowlist` | Exact variant ids the agent may buy |
| `budget` / `budgetWindow` | Cumulative ceiling counting in-flight reservations |

Every decision returns a machine-readable code and **every rule's result**, not
just the first failure:

```json
{
  "allowed": false,
  "code": "AMOUNT_EXCEEDS_LIMIT",
  "message": "amount exceeds the per-purchase limit of USD 500 minor units",
  "outcomes": [
    { "rule": "currency_allowed", "passed": true,  "detail": "USD is permitted" },
    { "rule": "merchant_allowed", "passed": true,  "detail": "merchant blend station is permitted" },
    { "rule": "max_amount_per_purchase", "passed": false, "detail": "..." }
  ]
}
```

Three properties hold throughout:

- **Fails closed.** An absent or unreadable policy denies. The engine cannot
  throw — a limit check that did not run must not let a purchase through.
- **Integer money.** Every amount is a `bigint` count of minor units.
  Provider floats are converted through their decimal string form, so
  `142.85` becomes exactly `14285`, never `14284`.
- **A denial is a successful evaluation.** The API returns `200` with the
  reason. A calling agent needs to know *why* it was refused more than it needs
  an HTTP error code.

> **Merchant names are not authenticated.** A name is an unsigned string from a
> provider response, so an allowlist match stops ordinary mistakes, not
> deliberate impersonation. `variantAllowlist` is the real control: variant ids
> are provider-issued and cannot be re-spelled by a merchant. The reasoning is
> in [`docs/reap-contract.md`](docs/reap-contract.md).

## Safety properties

| Property | How it is enforced |
| --- | --- |
| No card data, ever | The provider boundary has no method accepting a PAN, CVC or OTP. Reap's hosted pages collect them |
| Human approval is mandatory | `CHECKOUT_PENDING` is only left by reading the provider back. No method approves a checkout |
| Secrets never logged | `redactValue` on every log, audit entry and error. Luhn-checked PAN redaction, so order references stay readable |
| Idempotency | `UNIQUE` constraint on the idempotency key. Application-level checking alone would still race |
| No unauthenticated access | Bearer token on every route, compared in constant time |
| No simulation against production | `defineReapConfig` refuses to build such a configuration |
| No mock/real confusion | Every provider method is labelled; the dashboard shows `MOCK` or `SANDBOX` on every screen |

## Environment variables

Names only. Values live in `.env`, which is gitignored. Never commit them, never
paste them into an issue or a prompt.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `RUNTIME_MODE` | no | `mock` | `mock` uses fixtures; `sandbox` talks to a real Reap sandbox |
| `RUNTIME_API_TOKEN` | **yes** | — | Bearer token for this API. Minimum 16 characters. No anonymous mode exists |
| `REAP_API_KEY` | for sandbox | — | Sent as `Authorization: Bearer`. Sent privately per team by the buildathon |
| `REAP_BASE_URL` | for sandbox | `https://sandbox.api.reap.global` | Sandbox or production host |
| `REAP_VERSION` | no | `2025-02-14` | Pinned API version |
| `REAP_TIMEOUT_MS` | no | `15000` | Hard ceiling per provider call |
| `REAP_SIMULATE_CHECKOUT` | no | unset | `COMPLETED` settles without a human. **Sandbox only**, refused against production |
| `REAP_AMOUNT_SEMANTICS` | no | `MAJOR` | `MAJOR` or `MINOR`. See [`docs/reap-contract.md`](docs/reap-contract.md) |
| `HOST` / `PORT` | no | `127.0.0.1` / `3001` | Bind address |
| `DATABASE_PATH` | no | `./data/runtime.sqlite` | SQLite file |
| `LOG_LEVEL` | no | `info` | Pino level |

Configuration is validated before the port binds. A runtime that discovers a
missing key on its first purchase has failed in the most expensive way
available, so it refuses to start instead.

## Running against the Reap sandbox

```bash
# .env
RUNTIME_MODE=sandbox
REAP_API_KEY=sk_sbx_...
REAP_BASE_URL=https://sandbox.api.reap.global
RUNTIME_API_TOKEN=$(openssl rand -hex 32)
```

Leave `REAP_SIMULATE_CHECKOUT` unset so that real human approval is exercised.

You need an **ACTIVE** enrollment. Creating one means sending a person to
Reap's hosted card-entry page; this runtime consumes enrollments rather than
creating them. Read one with:

```bash
curl -H "Authorization: Bearer $REAP_API_KEY" \
     -H "Reap-Version: 2025-02-14" \
     "$REAP_BASE_URL/agentic/enrollments/$ENROLLMENT_ID"
```

Continue only when `status` reads `ACTIVE`.

### If a quote is refused

Almost always one of two things, both documented by Reap:

1. `region` is missing or misnamed. The field is `region`; **`state` is not
   accepted**. Many merchants require it even though the schema marks it
   optional.
2. `addressLine2` is missing. Required for Mexican addresses (colonia,
   interior).

Also check the phone is a real reachable number — reserved fictional ranges
pass the schema pattern and are still refused by merchants.

`QUOTE_TEMPORARILY_UNAVAILABLE` means **the merchant did not return pricing**.
It carries a documented `Retry-After`; wait that long and create a **new**
quote. It is not a rate limit, and retrying the same request cannot fix it.

## Demonstration script

A five-minute walkthrough that shows the product rather than the code.

1. **Start in mock mode.** Point out the `MOCK MODE` banner. State plainly
   that nothing here touches a provider.
2. **An allowed purchase.** Request `var_mock_coffee`. The dashboard shows the
   quote, `ALLOWED` with every rule's result, and `CHECKOUT_PENDING` with a
   hosted approval URL. **No order reference exists yet.** Say that out loud:
   a checkout existing is not money having moved.
3. **The budget.** Create an agent with a 30 USD monthly budget and request
   twice. The second is denied with `BUDGET_EXCEEDED` — while the first is
   still unapproved. Reservations count.
4. **A merchant refusal.** Point an agent's allowlist at a different shop.
   `MERCHANT_NOT_ALLOWED`, and no checkout is opened.
5. **Idempotency.** Resubmit the first request with the same key. The original
   purchase comes back, and the purchase count does not move.
6. **The audit trail.** `received → quoted → budget_reserved →
   awaiting_human_approval`, each with a plain-language summary.
7. **Approval.** Press Sync before approving: nothing changes. Approve, then
   Sync: `COMPLETED` with a merchant order reference. The runtime learned the
   outcome; it did not decide it.
8. **Then, if credentials exist, repeat 2 and 7 in sandbox mode.** The banner
   changes to `SANDBOX MODE` and the same flow runs against the real API.

## Testing

```bash
npm test          # 179 tests across core, provider and server
npm run typecheck # all four packages
npm run build     # production build
./scripts/e2e.sh  # end-to-end walkthrough against a running server
```

`npm run lint` is configured in every package but **has no ESLint config file
yet**, so it does not currently run. It is listed in scripts as a placeholder,
not as something that passes.

## What is not verified

Stated plainly, because an agent that overstates its integration is worse than
one that admits its limits:

- **No request has been sent to Reap's sandbox.** No API key was available.
  Every test uses a stubbed HTTP transport or the fixture provider.
- **No real payment has been initiated, approved or completed.**
- **No enrollment has been created.** That requires a human on Reap's hosted
  card-entry page.
- `REAP_AMOUNT_SEMANTICS=MAJOR` is inferred from documented examples, not
  observed.
- Lint is configured but not runnable.

See [`docs/evidence/README.md`](docs/evidence/README.md) for the full record,
including the ten real bugs these tests caught.

## Known limitations

- **Mixed-merchant carts** resolve the allowlist against the first known
  merchant. Pinning variants is the control that handles multi-merchant cases
  properly; a composite rule belongs in the policy layer, not the service.
- **No enrollment creation.** See above.
- **`externalCheckout` quoting is unsupported.** Reap restricts it to
  allowlisted merchant domains.
- **Mandates are not implemented.** Reap publishes them with
  `MANDATES_AVAILABLE = false`; the endpoints are not live.
- **Budget windows are not pruned.** `budgetWindow` is recorded, but usage is
  not yet reset on a schedule.
- **Single-writer SQLite.** Correct for a single-node runtime; horizontal
  scaling needs a real database and a shared idempotency table.

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/reap-contract.md`](docs/reap-contract.md) | The provider contract as implemented, the `shippingAddress` trap, merchant-identity limits, and the full error taxonomy |
| [`docs/evidence/README.md`](docs/evidence/README.md) | Every command run, its result, what it does not prove, and the bugs found |
| [Reap docs](https://docs.reap.global/agentic-payments/overview) | Upstream provider documentation |

## Licence

MIT
