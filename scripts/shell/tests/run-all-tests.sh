#!/usr/bin/env bash
# run-all-tests.sh — Run the full Traderton test suite.
#
# Traderton is a LIBRARY + REST BOUNDARY (no web UI, no API server, no Playwright
# journeys), so this mirrors the INTENT of herobids' run-all-tests.sh, scoped to
# what Traderton is:
#
# Test tiers (in order):
#   1. Unit tests          — pure vitest, no external services (`pnpm test`)
#   2. Integration tests   — DB + Redis gated suites (scripts/shell/tests/run-integration.sh)
#   3. Boundary E2E        — the full docker compose stack (postgres + redis +
#                            migrate + boundary), then REAL signed invokes of the
#                            market-intelligence read tools asserting real data.
#                            (opt-in: pass --e2e to include)
#
# Runs on FREE provider endpoints — no API keys required (Binance / DexScreener /
# GeckoTerminal free tier). A COINGECKO_API_KEY (GeckoTerminal Pro) only raises
# rate limits; it is optional.
#
# Usage:
#   scripts/shell/tests/run-all-tests.sh           # unit + integration
#   scripts/shell/tests/run-all-tests.sh --e2e     # + boundary E2E (docker stack)
#
# Exit codes: 0 = all selected tiers passed; 1 = a tier failed / setup error.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
COMPOSE_FILE="${ROOT}/docker-compose.yml"

if [[ -t 1 ]]; then
  BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; RESET='\033[0m'
else
  BOLD=''; GREEN=''; YELLOW=''; RED=''; CYAN=''; RESET=''
fi
log()    { echo -e "${CYAN}[tests]${RESET} $*"; }
ok()     { echo -e "${GREEN}[tests]${RESET} $*"; }
warn()   { echo -e "${YELLOW}[tests]${RESET} $*"; }
err()    { echo -e "${RED}[tests]${RESET} $*" >&2; }
header() { echo -e "\n${BOLD}${CYAN}== $* ==${RESET}"; }

RUN_E2E=false
for arg in "$@"; do
  case "$arg" in
    --e2e) RUN_E2E=true ;;
    --help|-h) sed -n '2,/^set /p' "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) err "Unknown argument: $arg"; exit 1 ;;
  esac
done

STACK_STARTED=false
cleanup() {
  local code=$?
  if [[ "${STACK_STARTED}" == "true" ]]; then
    warn "Tearing down boundary stack (started by this script)…"
    docker compose -f "${COMPOSE_FILE}" down --timeout 20 2>/dev/null || true
  fi
  [[ $code -eq 0 ]] && ok "All done." || err "Test run failed (exit ${code})."
  exit $code
}
trap cleanup EXIT

declare -a RESULTS=()
OVERALL_EXIT=0
record() { if [[ "$1" == "0" ]]; then RESULTS+=("${GREEN}PASS${RESET}  $2"); else RESULTS+=("${RED}FAIL${RESET}  $2"); OVERALL_EXIT=1; fi; }

# --- Tier 1: Unit ------------------------------------------------------------
header "1 / Unit tests"
( cd "${ROOT}" && pnpm test ); record "$?" "Unit tests"

# --- Tier 2: Integration (DB + Redis) ----------------------------------------
header "2 / Integration tests (DB + Redis)"
( cd "${ROOT}" && bash scripts/shell/tests/run-integration.sh ); record "$?" "Integration tests"

# --- Tier 3: Boundary E2E (opt-in) -------------------------------------------
if [[ "${RUN_E2E}" == "true" ]]; then
  header "3 / Boundary E2E (docker compose stack + signed invokes)"

  log "Building the boundary-e2e invoker…"
  ( cd "${ROOT}" && pnpm --filter @traderton/boundary run build ) || { record 1 "Boundary E2E (build)"; }

  log "Bringing up the boundary stack (postgres + redis + migrate + boundary)…"
  docker compose -f "${COMPOSE_FILE}" up -d --build
  STACK_STARTED=true

  log "Waiting for the boundary /health/ready …"
  ready=false
  for _ in $(seq 1 45); do
    if curl -sf http://localhost:8080/health/ready >/dev/null 2>&1; then ready=true; break; fi
    sleep 2
  done

  if [[ "${ready}" != "true" ]]; then
    err "Boundary did not become ready at http://localhost:8080/health/ready"
    record 1 "Boundary E2E (stack did not start)"
  else
    ok "Boundary is ready."
    if [[ ! -f "${ROOT}/.env" ]]; then
      err "Boundary E2E requires ${ROOT}/.env so its signed invokes use the boundary's configured HMAC identity."
      record 1 "Boundary E2E (missing .env)"
    else
      # Compose passes .env to the boundary; load the same identity for the
      # host-side invoker so its signed caller/key pair matches the server.
      ( cd "${ROOT}" && node --env-file=.env packages/boundary/dist/dev/boundary-e2e.js )
      record "$?" "Boundary E2E (market-intel signed invokes)"
    fi
  fi
else
  header "3 / Boundary E2E (skipped)"
  warn "Pass --e2e to include the live-boundary signed-invoke tests."
fi

# --- Summary -----------------------------------------------------------------
header "Summary"
for r in "${RESULTS[@]}"; do echo -e "  ${r}"; done
echo ""
exit $OVERALL_EXIT
