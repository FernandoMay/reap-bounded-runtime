# Architectural decisions

Short record of decisions that were delegated, and the reasoning. Kept next to
the code because a decision without its reasoning gets re-litigated by the next
person who reads it differently.

---

## D1. Budget windows are anchored on calendar boundaries in UTC

**Status:** accepted · **Date:** 2026-10-10

`budgetWindow` is evaluated against calendar boundaries: `DAY` at UTC midnight,
`WEEK` starting Monday (ISO), `MONTH` on the first. Not a rolling interval
counted from first use.

### Why

The alternative was anchoring on the operator's local timezone.

Against local time:

- The boundary would depend on where the process happens to run. The same
  policy file would mean different things on a laptop in Mexico City and a
  container in Singapore, and a spending limit whose meaning changes with
  deployment topology is not auditable.
- Containers default to UTC anyway, so local-time windows would mostly work by
  accident until someone set `TZ`, at which point behaviour would change with
  no code change.
- Reconciliation is the thing that actually happens. A budget is checked
  against a provider statement, and statements are not in the developer's
  local time.

For UTC:

- One policy, one meaning, everywhere. Deterministic and reproducible.
- ISO week boundaries are unambiguous and already have a standard definition.

The trade-off accepted: an operator in a non-UTC region sees their budget
reset at 19:00 local rather than midnight. That is a real, if minor,
inconvenience. The alternative is worse.

### If this ever needs to change

Local-time windows should be a configuration option (`BUDGET_TIMEZONE`), not
a change to `windowStart`. The window arithmetic itself does not need to move;
only the anchor does. Do not add it speculatively — one deployment is not two,
and a timezone bug in a spending limit is not cheap to debug.

---

## D2. A fractional amount under `MINOR` semantics is rejected, not converted

**Status:** accepted · **Date:** 2026-10-10

`REAP_AMOUNT_SEMANTICS=MINOR` tells the client that Reap sends integer counts
of minor units. If the client receives a fractional amount while in that mode,
it throws a protocol error instead of scaling it.

### Why

Minor units are integers by ISO 4211 definition. A value of `24.85` in minor
units is not a small quantity, it is a statement that contradicts the
configured interpretation.

The alternatives were all worse:

- **Convert leniently** — treat `24.85` as 2485. This is a guess about which
  interpretation is meant, made silently, and it is exactly the 100x error this
  module exists to prevent.
- **Round or truncate** — invents a rounding rule nobody specified, and picks
  one side of it silently.
- **Accept and log a warning** — the caller still gets a wrong number. A logged
  warning is not a control.

Failing at the boundary means the operator learns immediately, at the point of
failure, with the exact response in hand. The alternative is discovering a
100x discrepancy during reconciliation, which is days later and with no
provenance.

The strictness is also self-documenting: if this ever fires in production, the
message says what happened and the fix is a configuration change.

### If this ever needs to change

Only if Reap is observed emitting fractional minor amounts, which would mean the
ISO definition no longer describes the wire format. In that case the right
response is to change the *documented assumption*, not to loosen the check.

---

## D3. `require-await` is disabled for the fixture provider and Fastify handlers

**Status:** accepted · **Date:** 2026-10-10

ESLint's `require-await` is off for `packages/provider/src/mock/**` and
`packages/server/src/server.ts`.

### Why

The `PaymentProvider` contract declares every method as returning a `Promise`,
so the fixture implementation must return one even though it resolves in
memory with nothing to await. Fastify handlers accept a plain return value but
read as async throughout the file, and making half of them sync and half async
would make the route table harder to scan, not easier.

The rule is a heuristic and this is a known false-positive class: a signature
imposed by an interface is not an unfinished `async`.

### Scope

Disabled for those two paths only. Everywhere else the rule is on, because in
this codebase an `async` function with no `await` usually does mean a promise
is being created and not awaited — which in a purchase pipeline can mean a
charge is initiated with its outcome unrecorded.
