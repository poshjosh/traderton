#!/usr/bin/env bash
# AUTHORED (Phase 9b item F2c) — the migrate-then-test integration runner.
#
# Mirrors the intent of the F2a live-proof flow: bring up a throwaway
# Postgres(postgres:16) + Redis, apply `pnpm --filter @traderton/db db:migrate`
# against DATABASE_URL, then run the DATABASE_URL/REDIS_URL-gated integration
# tests. The default `pnpm test` is UNCHANGED — the gated tests skip without the
# env vars — so CI's default run is unaffected (item-E / F2a discipline).
#
# Usage:
#   scripts/shell/tests/run-integration.sh                 # spin up throwaway containers, migrate, test, tear down
#   DATABASE_URL=... REDIS_URL=... scripts/shell/tests/run-integration.sh --no-containers
#                                              # reuse an already-running DB/Redis (e.g. docker compose)
#
# Test #7 (compose /health/ready) additionally needs a running boundary; set
# BOUNDARY_BASE_URL (e.g. http://localhost:8080) to include it — otherwise it
# skips. Bring the full stack up with `docker compose up --build` for #7.
set -euo pipefail

cd "$(dirname "$0")/../../.."

MANAGE_CONTAINERS=1
if [[ "${1:-}" == "--no-containers" ]]; then
  MANAGE_CONTAINERS=0
  shift
fi

PG_CONTAINER="traderton-f2c-pg"
REDIS_CONTAINER="traderton-f2c-redis"

cleanup() {
  if [[ "$MANAGE_CONTAINERS" == "1" ]]; then
    echo "==> tearing down throwaway containers"
    docker rm -f "$PG_CONTAINER" "$REDIS_CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ "$MANAGE_CONTAINERS" == "1" ]]; then
  echo "==> starting throwaway postgres:16 + redis:7"
  docker rm -f "$PG_CONTAINER" "$REDIS_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$PG_CONTAINER" \
    -e POSTGRES_USER=traderton -e POSTGRES_PASSWORD=traderton -e POSTGRES_DB=traderton \
    -p 55432:5432 postgres:16 >/dev/null
  docker run -d --name "$REDIS_CONTAINER" -p 56379:6379 redis:7 >/dev/null

  export DATABASE_URL="postgres://traderton:traderton@localhost:55432/traderton"
  export REDIS_URL="redis://localhost:56379"

  echo "==> waiting for postgres to accept connections"
  for _ in $(seq 1 30); do
    if docker exec "$PG_CONTAINER" pg_isready -U traderton -d traderton >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

: "${DATABASE_URL:?DATABASE_URL must be set (or omit --no-containers to auto-provision)}"
: "${REDIS_URL:?REDIS_URL must be set (or omit --no-containers to auto-provision)}"

echo "==> applying migrations (pnpm --filter @traderton/db db:migrate)"
pnpm --filter @traderton/db db:migrate

echo "==> running the gated integration tests"
# Scope to the verification suite by default; pass extra args through.
pnpm exec vitest run packages/boundary/src/boundary.verification.integration.test.ts "$@"

echo "==> integration run complete"
