#!/usr/bin/env bash
#
# Sandbox credential check.
#
# Run this the moment you receive a Reap sandbox key. It makes two cheap
# authenticated calls and tells you precisely which of the four possible
# problems you have, so you are not guessing from a 401.
#
# It does not touch a merchant. Catalog search and quoting cost real requests
# against real merchants, and burning one on a smoke test is how you end up
# looking like the flaky team in the support channel.
#
#   REAP_API_KEY=sk_sbx_... ./scripts/check-sandbox.sh

set -uo pipefail

BASE_URL="${REAP_BASE_URL:-https://sandbox.api.reap.global}"
API_KEY="${REAP_API_KEY:-}"
VERSION="${REAP_VERSION:-2025-02-14}"

bold()  { printf '\033[1m%s\033[0m\n' "$1"; }
ok()    { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
note()  { printf '  \033[33mnote\033[0m %s\n' "$1"; }

bold "Reap sandbox credential check"
echo "  base URL: $BASE_URL"
echo

# --- preflight --------------------------------------------------------------
if [ -z "$API_KEY" ]; then
  bad "REAP_API_KEY is not set"
  note "export it, or put it in .env and run: set -a; . ./.env; set +a"
  exit 1
fi

if [ "$API_KEY" = "sk_sbx_x" ] || [ "$API_KEY" = "sk_sbx_your_key_here" ]; then
  bad "REAP_API_KEY still holds a placeholder value"
  exit 1
fi

case "$BASE_URL" in
  *prod*)
    bad "REAP_BASE_URL points at production"
    note "This check is for the sandbox. Use https://sandbox.api.reap.global"
    exit 1
    ;;
esac

# --- step 1: is the key valid against this host? ----------------------------
# GET /users is the cheapest authenticated call in the API. Its only purpose
# here is to separate "the key is wrong" from "the feature is off".
BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT

STATUS=$(curl -sS -o "$BODY" -w '%{http_code}' \
  --max-time 20 \
  -H "Authorization: Bearer $API_KEY" \
  -H "Reap-Version: $VERSION" \
  -H 'Accept: application/json' \
  "$BASE_URL/users?limit=1")

if [ "$STATUS" = "200" ]; then
  ok "API key is valid against $BASE_URL"
elif [ "$STATUS" = "401" ] || [ "$STATUS" = "403" ]; then
  bad "the key was rejected (HTTP $STATUS)"
  note "Either the key belongs to a different environment (sandbox key against a"
  note "production host, or vice versa), or it has expired. Check that the host"
  note "matches the key you were given."
  exit 1
elif [ "$STATUS" = "404" ]; then
  bad "the host does not serve /users (HTTP 404)"
  note "Confirm REAP_BASE_URL. Documented hosts are:"
  note "  https://sandbox.api.reap.global   (Singapore, alias)"
  note "  https://sg.sandbox.api.reap.global (Singapore)"
  note "  https://mx.sandbox.api.reap.global (Mexico)"
  exit 1
else
  bad "unexpected HTTP $STATUS from $BASE_URL/users"
  head -c 300 "$BODY"; echo
  exit 1
fi

# --- step 2: is Agentic Payments enabled for this key? ----------------------
# A deliberately absent owner id. If the module is enabled this returns 200
# with an empty list; if it is not, it returns 403 AGENTIC_PAYMENTS_NOT_ENABLED.
# Either way it reaches Reap and no merchant.
AGENTIC=$(curl -sS --max-time 20 \
  -H "Authorization: Bearer $API_KEY" \
  -H "Reap-Version: $VERSION" \
  -H 'Accept: application/json' \
  "$BASE_URL/agentic/enrollments?ownerType=REAP_USER&ownerId=credential-check-no-such-owner&limit=1")

case "$AGENTIC" in
  *AGENTIC_PAYMENTS_NOT_ENABLED*)
    bad "Agentic Payments is NOT enabled for this key"
    note "The key works, but this feature has to be switched on for your project."
    note "Ask the Reap team to enable it. Everything in this runtime depends on it."
    exit 2
    ;;
  *'"code"'*)
    bad "the agentic module rejected the probe"
    note "response: ${AGENTIC:0:300}"
    exit 2
    ;;
  *)
    ok "Agentic Payments is enabled for this key"
    ;;
esac

# --- what to do next --------------------------------------------------------
echo
bold "Ready for sandbox mode"
cat <<'EOF'
  Put these in .env:

    RUNTIME_MODE=sandbox
    REAP_API_KEY=<the key you were given>
    REAP_BASE_URL=https://sandbox.api.reap.global
    RUNTIME_API_TOKEN=$(openssl rand -hex 32)

  Leave REAP_SIMULATE_CHECKOUT unset so real human approval is exercised.

  Then run:
    npm run build
    (cd packages/server && node dist/main.js &)
    RUNTIME_API_TOKEN=$(grep RUNTIME_API_TOKEN .env | cut -d= -f2) ./scripts/e2e.sh

  Note: ./scripts/e2e.sh still requires an ACTIVE enrollment id. Export
  E2E_ENROLLMENT_ID=<id> before running it, or the checkout step will be
  refused with ENROLLMENT_NOT_ACTIVE - which is the correct behaviour.
EOF
