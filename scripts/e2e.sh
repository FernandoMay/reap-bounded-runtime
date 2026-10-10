#!/usr/bin/env bash
#
# End-to-end walkthrough of the runtime against a running server.
#
# Exercises the paths that matter, in order, and asserts on the response rather
# than on a status code alone. A check that only verifies "it returned 200"
# would pass just as happily against a runtime that approved everything.
#
#   npm run build && (cd packages/server && node dist/main.js &) && ./scripts/e2e.sh
#
# In sandbox mode the same script proves the policy layer; the approval step
# requires a human on Reap's hosted page, which is the point.

set -uo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3001}"
TOKEN="${RUNTIME_API_TOKEN:?set RUNTIME_API_TOKEN to your runtime token}"
PASS=0
FAIL=0

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
note() { printf '  \033[33mnote\033[0m %s\n' "$1"; }

api() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$BASE_URL$path" \
      -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' \
      -d "$body"
  else
    curl -sS -X "$method" "$BASE_URL$path" -H "Authorization: Bearer $TOKEN"
  fi
}

# Read one field out of a JSON response without pulling in jq.
field() {
  python3 -c "
import json,sys
data = json.load(sys.stdin)
for key in sys.argv[1].split('.'):
    if isinstance(data, list):
        data = data[int(key)]
    else:
        data = data.get(key) if isinstance(data, dict) else None
    if data is None:
        break
print('' if data is None else (json.dumps(data) if isinstance(data,(dict,list)) else data))
" "$1" 2>/dev/null
}

bold "Bounded Agent Runtime — end-to-end walkthrough"
echo "target: $BASE_URL"
echo

# --- 1. authentication ------------------------------------------------------
bold "1. Authentication"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/api/purchases")
[ "$CODE" = "401" ] && ok "unauthenticated request refused (401)" || bad "expected 401, got $CODE"

CODE=$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer wrong-token-value-here" "$BASE_URL/api/purchases")
[ "$CODE" = "403" ] && ok "invalid token refused (403)" || bad "expected 403, got $CODE"

# --- 2. provenance ----------------------------------------------------------
bold "2. Provenance"
HEALTH=$(api GET /api/health)
MODE=$(echo "$HEALTH" | field mode)
echo "  mode: $MODE"
if [ "$MODE" = "mock" ]; then
  ok "MOCK mode declared (fixtures, no real charges)"
elif [ "$MODE" = "sandbox" ]; then
  ok "SANDBOX mode declared (real Reap API)"
else
  bad "unexpected mode: $MODE"
fi

# --- 3. agents and policy ---------------------------------------------------
bold "3. Configure an agent"
AGENT="e2e-agent-$$"
api POST /api/agents "{
  \"id\": \"$AGENT\",
  \"name\": \"E2E agent\",
  \"policy\": {
    \"maxAmountPerPurchase\": {\"minor\": 5000, \"currency\": \"USD\"},
    \"budget\": {\"minor\": 20000, \"currency\": \"USD\"},
    \"budgetWindow\": \"MONTH\",
    \"allowedCurrencies\": [\"USD\"],
    \"merchantAllowlist\": [\"Blend Station\"]
  }
}" > /dev/null
ok "agent created with a 50 USD per-purchase ceiling and 200 USD monthly budget"

# --- 4. the allowed purchase ------------------------------------------------
bold "4. A purchase inside policy"
KEY="e2e-$$-allowed"
RESP=$(api POST /api/purchases "{
  \"agentId\": \"$AGENT\",
  \"idempotencyKey\": \"$KEY\",
  \"enrollmentId\": \"${E2E_ENROLLMENT_ID:-enr_mock_active}\",
  \"returnUrl\": \"http://localhost:5173/approved\",
  \"intent\": {
    \"items\": [{\"variantId\": \"var_mock_coffee\", \"quantity\": 1}],
    \"email\": \"buyer@example.com\"
  }
}")
OUTCOME=$(echo "$RESP" | field outcome)
PURCHASE_ID=$(echo "$RESP" | field purchase.id)
STATE=$(echo "$RESP" | field purchase.state)
APPROVAL=$(echo "$RESP" | field approvalUrl)

[ "$OUTCOME" = "awaiting_approval" ] && ok "checkout opened, awaiting human approval" || bad "outcome was $OUTCOME"
[ "$STATE" = "CHECKOUT_PENDING" ] && ok "state is CHECKOUT_PENDING" || bad "state was $STATE"
ORDER=$(echo "$RESP" | field purchase.checkout.orderId)
[ -z "$ORDER" ] && ok "no order reference yet (nothing is claimed as paid)" || bad "an order id appeared before approval: $ORDER"
[ -n "$APPROVAL" ] && ok "hosted approval URL returned" || bad "no approval URL"

# --- 5. idempotency ---------------------------------------------------------
bold "5. Idempotency"
REPLAY=$(api POST /api/purchases "{
  \"agentId\": \"$AGENT\",
  \"idempotencyKey\": \"$KEY\",
  \"enrollmentId\": \"enr_mock_active\",
  \"returnUrl\": \"http://localhost:5173/approved\",
  \"intent\": {
    \"items\": [{\"variantId\": \"var_mock_coffee\", \"quantity\": 1}],
    \"email\": \"buyer@example.com\"
  }
}")
REPLAY_OUTCOME=$(echo "$REPLAY" | field outcome)
REPLAY_ID=$(echo "$REPLAY" | field purchase.id)
[ "$REPLAY_OUTCOME" = "duplicate" ] && ok "replayed key returned the original purchase" || bad "outcome was $REPLAY_OUTCOME"
[ "$REPLAY_ID" = "$PURCHASE_ID" ] && ok "same purchase id, no second checkout" || bad "created a new purchase: $REPLAY_ID"

# --- 6. policy refusals -----------------------------------------------------
bold "6. Policy refusals"

deny_case() {
  local label="$1" policy="$2" variant="$3" expected="$4"
  local id="e2e-deny-$$-$RANDOM"
  api POST /api/agents "{\"id\": \"$id\", \"name\": \"$label\", \"policy\": $policy}" > /dev/null
  local out
  out=$(api POST /api/purchases "{
    \"agentId\": \"$id\",
    \"idempotencyKey\": \"$id-$RANDOM\",
    \"enrollmentId\": \"enr_mock_active\",
    \"returnUrl\": \"http://localhost:5173/approved\",
    \"intent\": {\"items\": [{\"variantId\": \"$variant\", \"quantity\": 1}], \"email\": \"b@example.com\"}
  }")
  local outcome code checkout
  outcome=$(echo "$out" | field outcome)
  code=$(echo "$out" | field decision.code)
  checkout=$(echo "$out" | field purchase.checkout.id)
  if [ "$outcome" = "denied" ] && [ "$code" = "$expected" ] && [ -z "$checkout" ]; then
    ok "$label -> denied with $expected, no checkout opened"
  else
    bad "$label -> outcome=$outcome code=$code checkout=${checkout:-none}"
  fi
}

deny_case "amount over ceiling" \
  '{"maxAmountPerPurchase":{"minor":100,"currency":"USD"},"allowedCurrencies":["USD"],"merchantAllowlist":["Blend Station"]}' \
  var_mock_coffee AMOUNT_EXCEEDS_LIMIT

deny_case "merchant not allowlisted" \
  '{"maxAmountPerPurchase":{"minor":500000,"currency":"USD"},"allowedCurrencies":["USD"],"merchantAllowlist":["Only This Shop"]}' \
  var_mock_coffee MERCHANT_NOT_ALLOWED

deny_case "currency not permitted" \
  '{"maxAmountPerPurchase":{"minor":500000,"currency":"USD"},"allowedCurrencies":["EUR"],"merchantAllowlist":["Blend Station"]}' \
  var_mock_coffee CURRENCY_NOT_ALLOWED

deny_case "variant not pinned" \
  '{"maxAmountPerPurchase":{"minor":500000,"currency":"USD"},"allowedCurrencies":["USD"],"variantAllowlist":["var_mock_mug"]}' \
  var_mock_coffee VARIANT_NOT_ALLOWED

# --- 7. cumulative budget ---------------------------------------------------
bold "7. Cumulative budget"
BUDGET_ID="e2e-budget-$$"
# The variant must belong to an allowlisted merchant, or the purchase is
# refused for the wrong reason and the budget rule is never reached.
# var_mock_coffee is Blend Station and prices at 24.85 USD, so a 30 USD budget
# admits exactly one purchase.
api POST /api/agents "{
  \"id\": \"$BUDGET_ID\",
  \"name\": \"Budget-limited agent\",
  \"policy\": {
    \"maxAmountPerPurchase\": {\"minor\": 500000, \"currency\": \"USD\"},
    \"budget\": {\"minor\": 3000, \"currency\": \"USD\"},
    \"budgetWindow\": \"MONTH\",
    \"allowedCurrencies\": [\"USD\"],
    \"merchantAllowlist\": [\"Blend Station\"]
  }
}" > /dev/null

BUDGET_HIT=""
for i in 1 2 3 4 5; do
  LAST=$(api POST /api/purchases "{
    \"agentId\": \"$BUDGET_ID\",
    \"idempotencyKey\": \"$BUDGET_ID-$i\",
    \"enrollmentId\": \"enr_mock_active\",
    \"returnUrl\": \"http://localhost:5173/approved\",
    \"intent\": {\"items\": [{\"variantId\": \"var_mock_coffee\", \"quantity\": 1}], \"email\": \"b@example.com\"}
  }")
  CODE=$(echo "$LAST" | field decision.code)
  if [ "$CODE" = "BUDGET_EXCEEDED" ]; then
    ok "purchase #$i denied with BUDGET_EXCEEDED (in-flight reservations count)"
    BUDGET_HIT=1
    break
  fi
done

if [ -z "$BUDGET_HIT" ]; then
  # Report what actually happened. Silently calling this "never enforced" hides
  # whether the budget is broken or the test reached it at all.
  bad "budget never triggered; last outcome=$(echo "$LAST" | field outcome) code=$(echo "$LAST" | field decision.code)"
fi

# --- 8. malformed input -----------------------------------------------------
bold "8. Input validation"
OUT=$(api POST /api/purchases "{
  \"agentId\": \"$AGENT\",
  \"idempotencyKey\": \"e2e-bad-$$\",
  \"enrollmentId\": \"enr_mock_active\",
  \"returnUrl\": \"http://localhost:5173/approved\",
  \"intent\": {\"items\": [{\"variantId\": \"var_mock_coffee\", \"quantity\": 0}], \"email\": \"b@example.com\"}
}")
CODE=$(echo "$OUT" | field decision.code)
[ "$CODE" = "INVALID_REQUEST" ] && ok "zero quantity refused before any provider call" || bad "code was $CODE"

# --- 9. audit trail ---------------------------------------------------------
bold "9. Audit trail"
AUDIT=$(api GET "/api/purchases/$PURCHASE_ID")
SUMMARY=$(echo "$AUDIT" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print(','.join(e['type'] for e in d['audit']))
" 2>/dev/null)
echo "  $SUMMARY"
case "$SUMMARY" in
  *received*quoted*awaiting_human_approval*) ok "full lifecycle recorded" ;;
  *) bad "unexpected audit trail: $SUMMARY" ;;
esac

LEAK=$(echo "$AUDIT" | grep -cE '4[0-9]{15}|cvv|cvc' || true)
[ "$LEAK" = "0" ] && ok "no card-shaped data in the audit trail" || bad "possible card data in audit"

# --- 10. human approval (mock only) ----------------------------------------
bold "10. Human approval"
if [ "$MODE" = "mock" ]; then
  CHECKOUT_ID=$(echo "$RESP" | field purchase.checkout.id)
  SYNC1=$(api POST "/api/checkouts/$CHECKOUT_ID/sync")
  S1=$(echo "$SYNC1" | field purchase.state)
  [ "$S1" = "CHECKOUT_PENDING" ] && ok "sync without approval keeps the purchase pending" || bad "state moved to $S1 without approval"

  note "simulating the human approving on the hosted page"
  curl -sS -X POST "$BASE_URL/api/mock/approve" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"checkoutId\": \"$CHECKOUT_ID\"}" > /dev/null 2>&1 || true

  SYNC2=$(api POST "/api/checkouts/$CHECKOUT_ID/sync")
  S2=$(echo "$SYNC2" | field purchase.state)
  ORDER2=$(echo "$SYNC2" | field purchase.checkout.orderId)
  if [ "$S2" = "COMPLETED" ] && [ -n "$ORDER2" ]; then
    ok "purchase settles only after approval, with a merchant order reference"
  else
    bad "expected COMPLETED with an order id, got state=$S2 order=${ORDER2:-none}"
  fi
else
  note "sandbox mode: approve on Reap's hosted page, then run"
  note "  curl -X POST $BASE_URL/api/checkouts/<id>/sync -H 'Authorization: Bearer \$RUNTIME_API_TOKEN'"
fi

# --- summary ----------------------------------------------------------------
echo
bold "Summary: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
