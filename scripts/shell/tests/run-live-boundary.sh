#!/usr/bin/env bash
# Run the FULL signed-call set against a DEPLOYED Traderton boundary over HTTPS.
#
# Reads the consumer identity (BOUNDARY_CONSUMER_ID / BOUNDARY_KEY_ID /
# BOUNDARY_SIGNING_SECRET) and the target BOUNDARY_BASE_URL from an operator env
# file (the same `.env.environment` the boundary itself is deployed with), then
# runs `packages/boundary/src/boundary.live.integration.test.ts`.
#
# Usage:
#   scripts/shell/tests/run-live-boundary.sh --env-file infra/hetzner/.env.staging
#   BOUNDARY_BASE_URL=http://localhost:8080 scripts/shell/tests/run-live-boundary.sh --env-file .env 
#   BOUNDARY_BASE_URL=... BOUNDARY_RESOLVE_IP=2.28.19.89 scripts/shell/tests/run-live-boundary.sh --env-file infra/hetzner/.env.staging
#
# Two knobs make this run against ANY boundary — a deployed one OR a local one —
# with no code change, only a URL + .env swap:
#   BOUNDARY_BASE_URL      target boundary base URL (staging vs local)
#   BOUNDARY_RESOLVE_IP    optional IP pin (mirror of `curl --resolve`) when the
#                          machine's outbound DNS is broken (Zscaler etc.). Only
#                          relevant for a DNS-reachable hostname; omitted for
#                          localhost.
#
#   Staging:  --env-file infra/hetzner/.env.staging  BOUNDARY_RESOLVE_IP=2.28.19.89
#   Local:    BOUNDARY_BASE_URL=http://localhost:8080 + the local boundary's own
#             BOUNDARY_* identity (see traderton .env / docker-compose.yml).
#
# Without --env-file, the caller must supply BOUNDARY_BASE_URL + the three
# BOUNDARY_* identity vars in the environment. If any are missing, the suite
# skips (it is gated), so this script warns rather than fails hard.
set -euo pipefail

cd "$(dirname "$0")/../../.."

ENV_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -n "$ENV_FILE" ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "env file not found: $ENV_FILE" >&2
    exit 2
  fi
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi

# Default target when none supplied: staging (the same host the boundary ships to).
# `export` here (not a bare assignment) — by this point `set +a` has already run,
# so a plain `:` default would be set but NOT exported to the vitest child, and
# the health/signed suites would silently skip.
export BOUNDARY_BASE_URL="${BOUNDARY_BASE_URL:-https://api.staging.traderton.com}"

echo "==> using env file: $ENV_FILE"
echo "==> using boundary base URL: $BOUNDARY_BASE_URL"

missing=0
for var in BOUNDARY_BASE_URL BOUNDARY_CONSUMER_ID BOUNDARY_KEY_ID BOUNDARY_SIGNING_SECRET; do
  if [[ -z "${!var:-}" ]]; then
    echo "WARN: $var is unset — those tests will SKIP" >&2
    missing=1
  fi
done

echo "==> target: $BOUNDARY_BASE_URL"
[[ -n "${BOUNDARY_RESOLVE_IP:-}" ]] && echo "==> resolve pin: $BOUNDARY_RESOLVE_IP (DNS bypass)"
[[ "$missing" == "0" ]] && echo "==> consumer: $BOUNDARY_CONSUMER_ID / $BOUNDARY_KEY_ID"

echo "==> running live boundary signed-call suite"
pnpm exec vitest run packages/boundary/src/boundary.live.integration.test.ts "$@"

echo "==> live boundary verification complete"