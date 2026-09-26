# Bug Report: Boundary container could not reach Postgres (DATABASE_URL fell back to localhost)

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-09-26
- **Summary:** The deployed (staging) boundary served `/health/ready` with a 200, but every DB-touching tool call failed with `connect ECONNREFUSED 127.0.0.1:5432`, because the `boundary` compose service was never given `DATABASE_URL`.

## Root Cause

`infra/hetzner/deploy.sh` derives `DATABASE_URL` (URL-encoding `POSTGRES_PASSWORD`, host `postgres:5432`) and exports it to the shell. But that export is consumed only by the `migrate` service, which has an explicit `DATABASE_URL: ${DATABASE_URL}` in its `environment:`. The `boundary` service reads its config solely via `env_file: .env.staging`, and `.env.staging` does **not** contain `DATABASE_URL` (only `REDIS_URL` is committed there).

With no `DATABASE_URL` override, `loadConfig()` fell back to `config/default.yaml`'s `postgres://traderton:traderton@localhost:5432/traderton`, so the boundary connected to `127.0.0.1:5432` inside its own container — where nothing listens — and failed with `ECONNREFUSED`.

The gap was masked because `/health/ready` returns `200 {"status":"ready"}` unconditionally (it never checks DB reachability), so the "it's up" signal looked healthy while persistence was broken.

## Fix

Mirror the `migrate` service's env injection on the `boundary` service in `infra/hetzner/compose.yaml`:

```yaml
boundary:
  ...
  environment:
    BOUNDARY_HOST: 0.0.0.0
    BOUNDARY_PORT: "8080"
    DATABASE_URL: ${DATABASE_URL:?Database URL required}
```

This forces an explicit failure at `docker compose config` time if `DATABASE_URL` is absent, instead of a silent localhost fallback at runtime.

## Detection

Surfaced by the new live signed-call suite (`packages/boundary/src/boundary.live.integration.test.ts`, run via `scripts/shell/tests/run-live-boundary.sh`) — a signed `submit_decision` (dry-run) and a signed status `GET` returned an `outcome`-less 500 instead of an envelope, diverging from the in-process suite that only exercised `/health/ready` over HTTP.

## Files Changed

- `infra/hetzner/compose.yaml`

## Verification

- `pnpm lint` (boundary package type-check): passed.
- Post-redeploy, the live signed-call suite is expected to pass all 13 tests (requires a staging redeploy to take effect).

## Notes

- This is a deploy/ops config bug, not a code bug in the boundary runtime: the boundary behaved correctly given the missing override.
- Consider making `/health/ready` assert DB reachability (rather than returning ready unconditionally) so a persistence outage cannot masquerade as healthy. Logged as a separate follow-up; not part of this fix.