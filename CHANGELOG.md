# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- infrastructure code to infra/hetzner
- Live signed-call integration suite (`packages/boundary/src/boundary.live.integration.test.ts`) + runner `scripts/shell/tests/run-live-boundary.sh` — drives the full signed contract (HMAC auth, envelope validation, deadline, status, `submit_decision` dry-run) against a deployed boundary over HTTPS.

### Fixed

- Staging `boundary` container could not reach Postgres — `DATABASE_URL` was derived in `deploy.sh` but never injected into the `boundary` compose service (only `migrate` had it), so DB-touching calls fell back to `config/default.yaml`'s `localhost:5432` and failed with `ECONNREFUSED`. See `docs/bug-reports/2026/09/26/001-boundary-missing-database-url.md`.

## 0.0.2-2026.09.24

### Changed

- Split env files by role: `.env.example` (boundary/runtime), `.env.ops.*.example` (operator/test/validator credentials). Local test/validator scripts now default to `.env.ops.dev`.
- `validate-1inch-launch.ts` emits a WARN (not FAIL) when `ONEINCH_ROUTER_ADDRESS` is unset.
- `run-extra-tests.sh` summary distinguishes executed vs skipped vs failed suites.

### Added

- Drift test coverage for the `.env.ops.*.example` twins.
- CHANGELOG.md

## 0.0.1

### Added

- initial commit
