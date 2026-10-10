# Verification evidence

Everything here was executed in this repository. Each entry records what was
run, what it produced, and — importantly — what it does **not** prove.

Environment used for the runs below:

```
Node.js  v22.22.2
npm      10.9.7
Platform Linux x86_64 (Ubuntu 25.10)
Date     2026-10-10
```

## 1. Type checking

```
npm run typecheck
```

| Package | Result |
| --- | --- |
| `@bounded/core` | pass, no diagnostics |
| `@bounded/provider` | pass, no diagnostics |
| `@bounded/server` | pass, no diagnostics |
| `@bounded/dashboard` | pass, no diagnostics |

## 1b. Lint

```
npm run lint
```

Clean across all four packages. ESLint flat config at the repository root.

Turning lint on was not a formality: it found a real money bug on its first
run. See [the bug table](#6-bugs-found-by-these-tests).

## 2. Unit and integration tests

```
npm test
```

| Suite | Tests | Pass | Fail |
| --- | --- | --- | --- |
| `packages/core` | 106 | 106 | 0 |
| `packages/provider` | 50 | 50 | 0 |
| `packages/server` | 40 | 40 | 0 |
| **Total** | **196** | **196** | **0** |

What these cover, and what they do not:

- **`core/test/money.test.ts`** — integer arithmetic, ISO 4217 exponents,
  exponent notation, rejection of sub-precision amounts, and the specific case
  `0.1 + 0.2 !== 0.3` that float money gets wrong. Uses no real card numbers.
- **`core/test/policy.test.ts`** — every denial code, the concurrency case for
  reservations, fail-closed behaviour, and the guarantee that the engine cannot
  throw.
- **`core/test/lifecycle.test.ts`** — the state machine, terminal states, and
  refusal to guess an undocumented status.
- **`core/test/redact.test.ts`** — Luhn-checked PAN redaction, and proof that
  non-card digit runs such as order references survive untouched.
- **`core/test/errors.test.ts`** — every documented Reap error code, the
  `Retry-After` header, and refusal to accept an undocumented code.
- **`provider/test/client.test.ts`** — **HTTP-level, against a stubbed
  transport.** Every request/response body is transcribed from the published
  OpenAPI, so these tests fail if the client stops matching the real contract.
  They do **not** contact Reap.
- **`provider/test/provider.test.ts`** — the fixture provider's lifecycle,
  including failure and expiry scenarios, and configuration validation.
- **`server/test/service.test.ts`** — the full pipeline: allowed purchases,
  each refusal, idempotent replay, budget accounting scoped per agent, sync
  behaviour, enrollment gating, and audit contents. Runs against SQLite in
  memory.
- **`server/test/budget-window.test.ts`** — window boundaries (day, ISO week,
  month, lifetime, year rollover) and that spending outside the current window
  stops counting.

**These are automated tests using a stubbed or fixture provider. None of them
contact Reap's sandbox.**

## 3. End-to-end walkthrough

```
npm run build
(cd packages/server && node dist/main.js &)
RUNTIME_API_TOKEN=<token> ./scripts/e2e.sh
```

Result: **20 assertions passed, 0 failed**, against a freshly built binary in
`RUNTIME_MODE=mock`.

```
1. Authentication
  PASS unauthenticated request refused (401)
  PASS invalid token refused (403)
2. Provenance
  mode: mock
  PASS MOCK mode declared (fixtures, no real charges)
3. Configure an agent
  PASS agent created with a 50 USD per-purchase ceiling and 200 USD monthly budget
4. A purchase inside policy
  PASS checkout opened, awaiting human approval
  PASS state is CHECKOUT_PENDING
  PASS no order reference yet (nothing is claimed as paid)
  PASS hosted approval URL returned
5. Idempotency
  PASS replayed key returned the original purchase
  PASS same purchase id, no second checkout
6. Policy refusals
  PASS amount over ceiling -> denied with AMOUNT_EXCEEDS_LIMIT, no checkout opened
  PASS merchant not allowlisted -> denied with MERCHANT_NOT_ALLOWED, no checkout opened
  PASS currency not permitted -> denied with CURRENCY_NOT_ALLOWED, no checkout opened
  PASS variant not pinned -> denied with VARIANT_NOT_ALLOWED, no checkout opened
7. Cumulative budget
  PASS purchase #2 denied with BUDGET_EXCEEDED (in-flight reservations count)
8. Input validation
  PASS zero quantity refused before any provider call
9. Audit trail
  received,quoted,budget_reserved,awaiting_human_approval,idempotent_replay
  PASS full lifecycle recorded
  PASS no card-shaped data in the audit trail
10. Human approval
  PASS sync without approval keeps the purchase pending
  PASS purchase settles only after approval, with a merchant order reference

Summary: 20 passed, 0 failed
```

Assertion #4 deserves emphasis: after a checkout is created, the runtime has
**no** order reference and reports `REQUIRES_ACTION`. Nothing anywhere claims a
payment happened until the provider says so.

## 4. Production build

```
npm run build
```

All four packages compile to `dist/`. Dashboard bundle: 233.67 kB
(73.10 kB gzipped), 30 modules, built in 1.79s.

## 5. NOT verified — read this before claiming anything

The following are **unverified** and must not be reported as working:

- **No call has been made to Reap's sandbox.** `REAP_API_KEY` was never
  available in this environment. Every test above uses either a stubbed HTTP
  transport or the fixture provider.
- **No real payment has been initiated, approved or completed.**
- **No enrollment has been created**, because that needs a human on Reap's
  hosted card-entry page.
- **`REAP_AMOUNT_SEMANTICS=MAJOR` is an inference** from the documented
  examples, not an observed fact. See `docs/reap-contract.md`. Under `MINOR` a
  fractional amount is rejected rather than accepted, so a wrong assumption
  fails loudly instead of silently mis-scaling amounts by 100x.
- **Merchant domain allowlisting is not enforceable** from provider data, which
  is why `variantAllowlist` exists. See `docs/reap-contract.md`.
- **No lint run has been skipped.** `npm run lint` runs and passes.

## 6. Bugs found by these tests

Every one of these was a real defect, caught by a test rather than by reading
the code:

| Bug | Consequence | Fix |
| --- | --- | --- |
| Policy engine threw on currency mismatch | A 500 instead of a structured denial, on a path that decides whether money moves | Compare defensively; wrap the engine so it cannot throw |
| Per-purchase ceiling compared across currencies | Same crash, second site | Same |
| `redactValue` could not serialise `bigint` | Audit events containing amounts silently failed to write | Emit decimal strings |
| `store.encode` stored literal `"undefined"` | Corrupt rows that failed to parse on read | Normalise to `null` |
| `fromRow` read `intent` instead of `intent_json` | **Silent** data loss: every read dropped the quote and checkout, because the guard was a truthiness check | Correct column names; parse via a helper that fails loudly |
| Two ids generated for one idempotent claim | Retries hit a UNIQUE constraint instead of being recognised as replays | One id, used for both |
| State machine forbade `CHECKOUT_PENDING -> COMPLETED` | Purchases whose `PROCESSING` window was never polled would strand forever | Allow the edge, and document why |
| `setMeta` mixed positional and named placeholders | Server refused to start | Named parameters throughout |
| `.env` lookup only checked `cwd` | Root `.env` never found; runtime refused to start for what looked like a missing credential | Walk upward from `cwd` |
| `budgetUsage` had no agent filter | **One agent's spending exhausted every other agent's budget** — a cross-tenant denial of service | Scope by `agent_id`, plus a regression test |
| `parseCheckout` accepted `amountSemantics` and ignored it | Under `MINOR`, checkout amounts were **100x too large**, silently. Same omission in `parseQuote`, search and product details | Route every amount through the configured semantics |
| The `MINOR` test reused the `MAJOR` fixture | It passed **for the wrong reason** — asserting MAJOR behaviour while labelled MINOR | Separate fixtures per interpretation, plus a test that the two differ by 100x |
| `redactString` duplicated the Luhn rule inline while `redactPanCandidates` sat dead | Two copies of the rule that decides what a card number is | One implementation |
| `budgetUsage` never applied `budgetWindow` | A `MONTH` budget counted every purchase ever made, so the ceiling drifted upward without bound | Window-scoped query with an ISO calendar boundary |

The budget-scoping bug is the most serious, and it was found by the E2E script
reporting an unexpected first-purchase denial rather than by inspection.

The `amountSemantics` bug is the second most serious, and it was found by a
linter that was switched on purely to close a documentation gap. The test that
should have caught it was passing, because it reused the wrong fixture and
therefore asserted the behaviour the broken code happened to produce.

### A note on tests that pass for the wrong reason

Two of these deserve attention, because a green test is supposed to mean
something.

The `amountSemantics` test asserted the right number while exercising the wrong
path. It would have started failing the moment the code was fixed — which is
the only reason it got caught at all, by the type error that came with the fix.

The E2E budget case originally used a variant belonging to a merchant that was
not on the allowlist, so every attempt was refused for the wrong reason and the
budget rule was never reached. The script reported "budget was never enforced",
which read as a product bug rather than a test bug. It now reports the actual
last outcome so the next version of that mistake is diagnosable.
