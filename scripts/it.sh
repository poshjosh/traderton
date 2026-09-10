#!/usr/bin/env bash
#
# L1 integration harness runner (docs/features/025 §3 / 026 §2) — DEV/TEST ONLY.
#
# Brings up real Postgres + Redis (docker-compose.integration.yml), waits for
# health, exports DATABASE_URL/REDIS_URL, applies the @traderton/db migration,
# runs the gated worker integration harness with vitest, and tears the stack
# down (down -v) on exit. Plain shell — no orchestration cleverness.
#
# Usage:  pnpm test:integration
#
# The harness itself is DATABASE_URL+REDIS_URL-gated (describe.skipIf), so it
# only executes when this script exports those URLs — the default `pnpm test`
# (no infra) skips it cleanly.
#
# ── DATA-LOSS SAFETY ─────────────────────────────────────────────────────────
# The harness `TRUNCATE`s between scenarios and this script `down -v`s on exit.
# Both are destructive, so this script must ONLY ever point at the throwaway
# integration containers it provisions — NEVER a developer's real local DB.
# It therefore:
#   * uses DELIBERATELY non-default host ports (55432 / 56379, overridable via
#     PG_PORT / REDIS_PORT) so the compose containers cannot collide with a
#     local Postgres (5432) / Redis (6379);
#   * CONSTRUCTS DATABASE_URL / REDIS_URL from those ports (unless already
#     exported) and hands the same URLs to compose, drizzle-kit, and the harness;
#   * REFUSES to run if the effective DATABASE_URL points at the default
#     localhost:5432 — that is almost certainly a real local Postgres, and a
#     TRUNCATE against it would wipe real data.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── Preflight: docker must be available ──────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: 'docker' is not installed or not on PATH. The L1 integration harness" >&2
  echo "       needs Docker to stand up throwaway Postgres + Redis containers." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: 'docker compose' is not available. Install Docker Compose v2 (the" >&2
  echo "       'docker compose' subcommand) to run the L1 integration harness." >&2
  exit 1
fi

# ── Overridable, non-default host ports ──────────────────────────────────────
# Exported so `docker compose` interpolates the same values into the port
# mappings in docker-compose.integration.yml.
export PG_PORT="${PG_PORT:-55432}"
export REDIS_PORT="${REDIS_PORT:-56379}"

# ── Construct the URLs (respect a pre-exported override) ─────────────────────
# If DATABASE_URL / REDIS_URL are already exported we respect them (advanced
# override), otherwise we build them from the non-default ports above.
export DATABASE_URL="${DATABASE_URL:-postgres://traderton:traderton@localhost:${PG_PORT}/traderton}"
export REDIS_URL="${REDIS_URL:-redis://localhost:${REDIS_PORT}}"

# ── Guard: never run against a default local Postgres ────────────────────────
# TRUNCATE + down -v are destructive; refuse if the effective URL looks like a
# real local database (default 5432) rather than the throwaway stack.
if [[ "$DATABASE_URL" == *"localhost:5432"* || "$DATABASE_URL" == *"127.0.0.1:5432"* || "$DATABASE_URL" == *"@localhost/"* || "$DATABASE_URL" == *"@127.0.0.1/"* ]]; then
  echo "ERROR: refusing to run — DATABASE_URL points at the default local Postgres" >&2
  echo "       (port 5432): $DATABASE_URL" >&2
  echo "       The harness TRUNCATEs and tears down (down -v) its database, which" >&2
  echo "       would WIPE a real local Postgres. Unset DATABASE_URL to use the" >&2
  echo "       throwaway integration stack (PG_PORT=${PG_PORT}), or point PG_PORT/" >&2
  echo "       DATABASE_URL at a disposable database." >&2
  exit 1
fi

echo "==> Integration DB: ${DATABASE_URL}"
echo "==> Integration Redis: ${REDIS_URL}"

COMPOSE_FILE="docker-compose.integration.yml"
COMPOSE=(docker compose -f "$COMPOSE_FILE")

cleanup() {
  echo "==> Tearing down integration infra (down -v)"
  "${COMPOSE[@]}" down -v --remove-orphans || true
}
trap cleanup EXIT

echo "==> Starting integration infra (Postgres + Redis) on host ports ${PG_PORT}/${REDIS_PORT}"
"${COMPOSE[@]}" up -d

# Wait for both services to report healthy (compose healthchecks defined in the
# compose file). Poll `docker compose ps` for the health state.
echo "==> Waiting for Postgres + Redis to become healthy"
wait_healthy() {
  local svc="$1"
  local attempts=0
  local max_attempts=60
  while true; do
    local status
    status="$("${COMPOSE[@]}" ps --format '{{.Health}}' "$svc" 2>/dev/null || true)"
    if [[ "$status" == "healthy" ]]; then
      echo "    $svc: healthy"
      return 0
    fi
    attempts=$((attempts + 1))
    if (( attempts >= max_attempts )); then
      echo "ERROR: $svc did not become healthy in time (last status: '$status')" >&2
      "${COMPOSE[@]}" logs "$svc" >&2 || true
      return 1
    fi
    sleep 1
  done
}
wait_healthy postgres
wait_healthy redis

echo "==> Applying @traderton/db migration to the test database"
pnpm --filter @traderton/db exec drizzle-kit migrate

echo "==> Running L1 integration harness"
# Focused include so `test:integration` runs the integration suite, not the
# whole tree. DATABASE_URL/REDIS_URL are exported above → the gate is open.
pnpm exec vitest run packages/worker/src/composition/runtime.integration.test.ts

echo "==> L1 integration harness complete"
