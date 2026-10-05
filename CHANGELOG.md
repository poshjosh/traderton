# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## 0.0.3-2026.10.05

### Added

- **Wave E — actor events + lifecycle (Traderton side).** Restores the actor callbacks that were stubbed when trading moved out of herobids.
  - **E2 — bot status truth + restart survival:** explicit `stop_bot`/drive-target stops mark the row stopped before enqueuing; one shared running-bot loader rehydrates `running` bots on boot (worker + boundary); bot failure callbacks persist status (`onStartFailed`/`onCrashed` → crashed, `onHalted` → stopped), while graceful shutdown leaves rows `running` (resume ruling); the boundary now shuts down cleanly on SIGTERM/SIGINT.
  - **E3-T — consumer event channel (producer side):** a dedicated `consumer_notifications` outbox table + repository, a best-effort notifier wired into the agent and bot actors (scan completions, wakes, forwarded journal events, bot/agent status), the system-only `scan_consumer_notifications` read tool, and a retention prune loop.
  - **E1-T — agent scan loop + lifecycle:** the agent trading profile gains a creator/active strategy ownership split (`scan_mode`/`creator_strategy`/`active_strategy`, parity-tested against herobids preset resolution); an `agentScanner` operator config block; `agent_scan_candidates`/`agent_scan_metrics` persistence with retention; the hybrid technical scan loop wired into the agent actor; and consumer-only `start_agent_actor`/`stop_agent_actor` tools backed by an `agent_actor_runs` table with cascade-stop, boot rehydrate, and an orphan sweep.
  - Herobids-side relay/profile wiring (E3-H, E1-H) is gated behind a human go and not included. See `docs/features/2026/10/04/001-wave-e-actor-events-and-lifecycle/`.
- **Agent-actor lease + owner routing — multi-replica boundary safety (Wave E E4).** Running more than one `boundary` replica is now safe for agent actors (as it already was for bots). Each agent actor is owned by exactly one replica via a Redis lease (`lease:instance:agent:{agentId}`, 30s TTL, auto-renewed); the lazy ensure, boot rehydrate, and orphan sweep acquire it before constructing, and a replica that loses the race is a no-op. A `submit_decision` for a non-owned agent is forwarded to the owner's command list (`agent-actor:cmd:{workerId}`) and the owner writes the reply on the shared reply key the tool already waits on; an `agent-actor:stop:*` subscriber mirrors the bot stop signal. On owner death the lease expires and a surviving replica's sweep takes over within ≤ TTL + sweep interval. Proven by a two-replica integration test over real Redis + Postgres. See `docs/features/2026/10/04/002-agent-actor-lease-and-routing/001-plan.md`.
- **`journal_events` retention + partitioning (Wave E E5).** The append-only audit log is now RANGE-partitioned by month on `created_at` (composite PK `(id, created_at)`, a DEFAULT catch-all partition), with a boundary maintenance loop — single-flight across replicas via a dedicated Redis lease — that provisions future partitions ahead and, only when `journal.retention.auditRetentionMonths` is set, drops whole-month partitions past the cutoff (optionally archiving each to a gzip CSV first). Backtest-bearing partitions are exempt unless `backtestRetentionMonths` is set. Defaults keep everything (`null`), so the mechanism ships without waiting on the retention-policy decision. Operator config under `journal.retention.*`; ops docs in `007`. See `docs/features/2026/10/04/003-journal-retention/001-plan.md`.
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
