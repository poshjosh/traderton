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
#   6. Venue-launch validators — operator-run dry-run validation of the Jupiter
#                            / 1inch adapters (scripts/shell/tests/validate-*.sh);
#                            skipped without venue keys (never in the default run).
#
# Usage:
#   scripts/shell/tests/run-extra-tests.sh           # runs the venue suites (skip w/o keys)
#   scripts/shell/tests/run-extra-tests.sh --all     # same (single tier today)
#   scripts/shell/tests/run-extra-tests.sh --env-file .env.ops.dev
#
# Env file defaults to .env.ops.dev; override with --env-file.
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

# Result counters for a clear PASS/SKIP/FAIL summary.
EXECUTED=0
SKIPPED=0
FAILED=0

ENV_FILE="${ROOT}/.env.ops.dev"
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
TIER5_CREDS_PRESENT=false
if [[ -n "${HYPERLIQUID_TESTNET_API_KEY:-}" || -n "${BYBIT_TESTNET_API_KEY:-}" || -n "${ONEINCH_API_KEY:-}" ]]; then
  TIER5_CREDS_PRESENT=true
fi

if [[ "${TIER5_CREDS_PRESENT}" == "false" ]]; then
  warn "No venue credentials present — all Tier 5 integration suites will self-skip."
  SKIPPED=$((SKIPPED + 3))   # hyperliquid, bybit, oneinch
else
  log "Running venue integration suites…"
  CODE=0
  ( cd "${ROOT}" && pnpm exec vitest run \
      packages/venues/src/hyperliquid.integration.test.ts \
      packages/venues/src/bybit.integration.test.ts \
      packages/venues/src/oneinch.integration.test.ts ) || CODE=$?
  echo ""
  if [[ $CODE -eq 0 ]]; then
    ok "Venue integration suites passed."
    EXECUTED=$((EXECUTED + 1))
  else
    err "Venue integration suites failed (exit ${CODE})."
    FAILED=$((FAILED + 1))
  fi
fi

# == Tier 6 / Venue-launch validators (opt-in operator scripts) ==
# Operator-run dry-run validation of the Jupiter / 1inch venue adapters
# (scripts/ts/validate-*-launch.ts). They hit LIVE venue endpoints and need
# venue credentials in .env.ops.dev, so they are NOT part of the default green run.
# Dry-run only — --execute is left to the operator, by hand.

# Runs the wrapper; skips cleanly (return 0) when required credentials are
# absent. By default ALL named vars must be set; `--any` runs when at least one
# is (mirrors the validator's own env-var prerequisites). The trailing `|| :`
# masks failures from `set -e` so both validators always run and failures
# aggregate into the final exit code.
venue_validator_dry_run() {
  local any=0
  if [[ "${1:-}" == "--any" ]]; then any=1; shift; fi
  local script="$1"
  shift
  local var missing=() present=0
  for var in "$@"; do
    if [[ -z "${!var:-}" ]]; then
      missing+=("${var}")
    else
      present=1
    fi
  done
  if (( any == 0 && ${#missing[@]} > 0 )) || (( any == 1 && present == 0 )); then
    warn "Skipped ${script} — missing optional venue credential(s): ${missing[*]:-${*}} (operator-only opt-in; set them in .env.ops.dev to run)."
    SKIPPED=$((SKIPPED + 1))
    return 0
  fi
  log "Running ${script} (dry-run)…"
  if bash "${ROOT}/scripts/shell/tests/${script}"; then
    ok "${script} dry-run passed."
    EXECUTED=$((EXECUTED + 1))
  else
    err "${script} dry-run failed."
    FAILED=$((FAILED + 1))
    return 1
  fi
}

header "Tier 6 / Venue-launch validators (opt-in operator scripts)"
venue_validator_dry_run validate-1inch.sh ONEINCH_API_KEY ONEINCH_PRIVATE_KEY || :
venue_validator_dry_run --any validate-jupiter.sh SOLANA_WALLET_PRIVATE_KEY JUPITER_WALLET_ADDRESS JUPITER_PRIVATE_KEY || :

echo ""
header "Summary"
log "Executed & passed: ${EXECUTED}"
if [[ $SKIPPED -gt 0 ]]; then warn "Skipped (missing optional credentials): ${SKIPPED}"; fi
if [[ $FAILED -gt 0 ]]; then err "Failed: ${FAILED}"; fi

if [[ $FAILED -ne 0 ]]; then
  err "Extra tests failed (${FAILED} failed)."
  exit 1
fi
if [[ $EXECUTED -eq 0 && $SKIPPED -gt 0 ]]; then
  warn "No credential-gated suites actually ran (${EXECUTED} executed, ${SKIPPED} skipped)."
  exit 0
fi
ok "Extra tests passed (${EXECUTED} executed, ${SKIPPED} skipped)."
exit 0
