#!/usr/bin/env bash
# run-extra-tests.sh — Run Traderton test suites NOT covered by run-all-tests.sh.
#
# Traderton is a library + boundary, so its "extra" set is much smaller than
# herobids': there are no agent-lifecycle / web / autoscale tiers to mirror. What
# maps is the CREDENTIAL-GATED venue-adapter integration suites (the analog of
# herobids' Tier 5) — they use `describe.skipIf` and self-skip cleanly when the
# venue credentials are absent, so this is safe to run without keys (it will skip
# them and report SKIP rather than fail).
#
# Tiers:
#   5. Venue integration   — Hyperliquid/Bybit (testnet) + 1inch adapters; require
#                            venue credentials, else self-skip.
#      Env (optional): HYPERLIQUID_TESTNET_API_KEY/SECRET/ACCOUNT_ADDRESS,
#                      BYBIT_TESTNET_API_KEY/SECRET, ONEINCH_API_KEY/PRIVATE_KEY.
#
# Usage:
#   scripts/shell/tests/run-extra-tests.sh           # runs the venue suites (skip w/o keys)
#   scripts/shell/tests/run-extra-tests.sh --all     # same (single tier today)
#   scripts/shell/tests/run-extra-tests.sh --env-file .env
#
# Exit codes: 0 = passed (incl. clean skips); 1 = a suite failed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

if [[ -t 1 ]]; then
  BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; RESET='\033[0m'
else
  BOLD=''; GREEN=''; YELLOW=''; RED=''; CYAN=''; RESET=''
fi
log()    { echo -e "${CYAN}[extra]${RESET} $*"; }
ok()     { echo -e "${GREEN}[extra]${RESET} $*"; }
warn()   { echo -e "${YELLOW}[extra]${RESET} $*"; }
err()    { echo -e "${RED}[extra]${RESET} $*" >&2; }
header() { echo -e "\n${BOLD}${CYAN}== $* ==${RESET}"; }

ENV_FILE="${ROOT}/.env"
for ((i=1; i<=$#; i++)); do
  case "${!i}" in
    --env-file) j=$((i+1)); ENV_FILE="${!j}" ;;
    --all) : ;;  # single tier today; accepted for parity with herobids
    --help|-h) sed -n '2,/^set /p' "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \{0,1\}//'; exit 0 ;;
  esac
done

header "0 / Load environment"
if [[ -f "${ENV_FILE}" ]]; then
  log "Sourcing ${ENV_FILE}"
  set -a; # shellcheck disable=SC1090
  source "${ENV_FILE}"; set +a
else
  warn "No env file at ${ENV_FILE} — venue suites will self-skip (no credentials)."
fi

header "Tier 5 / Venue-adapter integration (self-skip without credentials)"
log "Running venue integration suites…"
( cd "${ROOT}" && pnpm exec vitest run \
    packages/venues/src/hyperliquid.integration.test.ts \
    packages/venues/src/bybit.integration.test.ts \
    packages/venues/src/oneinch.integration.test.ts )
CODE=$?

echo ""
if [[ $CODE -eq 0 ]]; then
  ok "Venue integration suites passed (or self-skipped without credentials)."
else
  err "Venue integration suites failed (exit ${CODE})."
fi
exit $CODE
