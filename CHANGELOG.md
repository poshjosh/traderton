# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Wave E — actor events + lifecycle (Traderton side).** Restores the actor callbacks that were stubbed when trading moved out of herobids.
  - **E2 — bot status truth + restart survival:** explicit `stop_bot`/drive-target stops mark the row stopped before enqueuing; one shared running-bot loader rehydrates `running` bots on boot (worker + boundary); bot failure callbacks persist status (`onStartFailed`/`onCrashed` → crashed, `onHalted` → stopped), while graceful shutdown leaves rows `running` (resume ruling); the boundary now shuts down cleanly on SIGTERM/SIGINT.
  - **E3-T — consumer event channel (producer side):** a dedicated `consumer_notifications` outbox table + repository, a best-effort notifier wired into the agent and bot actors (scan completions, wakes, forwarded journal events, bot/agent status), the system-only `scan_consumer_notifications` read tool, and a retention prune loop.
  - **E1-T — agent scan loop + lifecycle:** the agent trading profile gains a creator/active strategy ownership split (`scan_mode`/`creator_strategy`/`active_strategy`, parity-tested against herobids preset resolution); an `agentScanner` operator config block; `agent_scan_candidates`/`agent_scan_metrics` persistence with retention; the hybrid technical scan loop wired into the agent actor; and consumer-only `start_agent_actor`/`stop_agent_actor` tools backed by an `agent_actor_runs` table with cascade-stop, boot rehydrate, and an orphan sweep.
  - Herobids-side relay/profile wiring (E3-H, E1-H) is gated behind a human go and not included. See `docs/features/2026/10/04/001-wave-e-actor-events-and-lifecycle/`.
- **Opt-in position marks on `get_agent_positions`.** New `includeMarks?: boolean` param (default `false`). When `true`, every returned row carries `markPrice`, `unrealizedPnl` (full precision) and `markedAt` (ISO); only open, non-flat rows are marked, and closed/flat/unmarkable rows get nulls. Marking is best-effort (bounded by a short internal deadline, deduped per asset) and never fails the read — base rows stay byte-identical when the param is absent or `false`. See `packages/worker/src/tools/position-marks.ts` and `docs/features/initial/005-consumer-boundary-contract.md`.
- **Canonical trading reference docs (herobids Phase 2, Step 6).** `docs/reference/*` now owns the trading venue guides (Hyperliquid/Bybit/Jupiter/1inch + funding-wallets), the crypto-ecosystem reference, and a trading glossary — moved from the herobids host platform so Traderton owns the trading product's reference material.
- **Minimal public site (Step 7).** Static `staging.traderton.com` site under `site/` (product identity, docs/venue guides, service status) with a local-only serving stack (`infra/hetzner/compose.site-local.yaml`) and an execution-boundary isolation test (`infra/hetzner/tests/site-isolation.sh`). Publishing (DNS/TLS/deploy) is prepared but not executed — see `docs/features/2026/10/01/001-minimal-public-site/002-publish-prep.md`.
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
