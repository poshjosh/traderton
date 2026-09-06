# Traderton — Vision & Ground Rules

**Status:** living
**Created:** 2026-09-01

## What Traderton is

Trading infrastructure for AI/LLM agents. Agents connect and trade across
segments and families — starting with crypto, later forex, commodities,
equities, and others. Access is exposed over multiple mechanisms: HTTP API
now; MCP and skills later. The domain business meaning of "trading" lives
here, not in any consuming platform.

## How we are building it

Traderton is extracted from an existing, working system
(`../../herobids` relative to this doc, the `herobids` monorepo) where
trading is currently fused with an agent + messaging platform. We are **not
rewriting trading from scratch.**

### The core principle — copy, never author

> Every line of trading behaviour in this repo must arrive by being **copied**
> from the source system, never by being **authored**. The only things we
> author are **deletions** and the **thin seams** where platform couplings are
> cut.

Rationale: rewriting from scratch makes an agent reproduce behaviour from its
*model* of what the code should do, silently omitting hard-won detail (edge
cases, ordering, venue quirks) and then writing tests that assert the omitted
version — green tests, real regression. Copy-and-delete starts from real
behaviour with all detail present, so the job becomes *removal* (visible: a bad
delete breaks the build/tests) instead of *creation* (invisible omissions).

### The method — copy, then delete, then stub seams

1. Copy the trading-relevant subtree verbatim; get it compiling as a copy.
2. Bring the existing tests across unmodified — they are the parity harness.
3. Delete leaves first, roots last. Build + run tests after every deletion.
4. Cut platform seams by stubbing to the narrowest thing that returns what the
   real dependency returned; verify green; only then thin it.
5. Payments: delete cleanly, do not reimplement. Ledger it as Deferred.

**Discipline:** after every delete, the build compiles and the copied tests
pass. When they don't, we've found a real dependency or cut a seam wrong — fix
it there, with full local context, before moving on.

## Verification standard — parity, not liveness

"Does it run?" is necessary but insufficient. The bar is **feature parity with
the source system.** The source repo is the specification. We may **improve**,
we must not **degrade**. Anything we cannot preserve now is recorded in the
[Parity Ledger](./001-parity-ledger.md) — nothing is silently dropped.

## Settled decisions

1. **Own database.** Traderton owns its trading data in its own store. No shared
   schema with the source platform; cross-boundary foreign keys become soft
   references validated at the boundary.
2. **Own config.** Traderton owns its domain config schema and validation
   (operator + instance layers). Consuming platforms do not compile in trading
   config types.
3. **Own risk enforcement.** The trading risk gate and its hard invariants live
   here. User-configured limits remain immutable at runtime; operator defaults
   remain adjustable within operator bounds.
4. **No backward-compatibility obligations in Traderton's surface.** Fresh
   start. We drop deprecation aliases, route-migration matrices, and "don't
   rename persisted fields" constraints. Name things right the first time.
   We still require equivalence validation before traffic cutover; that is
   proof discipline, not a public-API compatibility promise.
5. **Traderton-native usage metering, payments, and caps are deferred.**
   Platform billing authority stays outside Traderton by design; any
   Traderton-owned usage metering, billing, or caps are cut for now and
   tracked as Deferred in the ledger.
6. **Direct API first.** MCP and skills wrap the same boundary later; they do
   not block the first working API.

### Toolchain & naming

16. **Mirror herobids toolchain exactly:** Node ≥22, pnpm monorepo, TypeScript
    `strict: true`, ES2022, ESM only. Copied code must compile unchanged; do
    not upgrade versions during extraction.
17. **Rename `@herobids/*` → `@traderton/*` from the start.** Fresh repo, no
    history to protect — get the namespace right on day one rather than
    sweeping imports twice.

### Actor & intelligence model

7. **Bots are mechanical trading actors.** They belong to the trading layer and
   move to Traderton. A bot runs a deterministic strategy (`mechanical`, `dca`)
   and submits decisions; it does not reason.
8. **Intelligence is the agent's job, not the bot's.** LLM-driven decision
   making (`LlmStrategy`, `HybridStrategy`) is *reasoning* and stays agent-side
   on the consuming platform. The agent reasons, then calls Traderton's
   `submit_decision`. Mechanical intelligence (scanner, regime — indicators
   only, no LLM) is fine for bots and moves to Traderton.
9. **`llm` stays agent-side.** Traderton is mechanical and carries **no**
   `@herobids/llm` dependency and no LLM cost center. The `strategy` package is
   **split**: mechanical parts (`Dca`, `Mechanical`, `scan-engine`, `regime`)
   move to Traderton; LLM parts (`Llm`, `Hybrid`, `llm-provider`) stay
   agent-side.

### Ownership & seam (from source-code investigation)

10. **Traderton is multi-tenant but not the identity/platform-billing
   authority.** It accepts an authenticated `ownerId` + `actor` at the
   boundary; it does not manage users or platform billing. User management and
   platform billing are Intentional Divergence, not parity gaps.
11. **Seam sits between `connections` and `venue_accounts`.**
    - Stay platform: `users`, `connections`, `agent_connections`, `agents`.
    - Move to Traderton: `venue_accounts`, `user_credentials`, `bots`.
12. **Credential custody follows the venue caller → Traderton.** Traderton
    holds `venue_accounts` + `user_credentials` because it makes the venue calls.
13. **`bots` re-pointed to soft fields:** `bots.userId` → soft `ownerId`;
    `bots.connectionId` → `venueAccountId` (the connection indirection is
    platform-only and is dropped inside Traderton).
14. **`blueprint.ts` stays platform**, but its risk/execution/token-safety
    schemas are a within-file seam Traderton copies for config ownership.
15. **market-assessment splits:** copy the domain/analysis into Traderton; leave
   platform orchestration + platform-side billing behind. Traderton-side usage
   metering remains Deferred. `documents` stays platform.

### Source-fix requests

When the cleanest seam requires reshaping the source, Traderton may **request** a
behaviour-preserving change in herobids — never editing herobids directly. The
owner makes, tests, gates, and releases the change in herobids; Traderton then
copies from the improved source. Requests must be behaviour-preserving
(validated by herobids' existing tests) — they may not alter trading behaviour;
a behaviour change is a product decision, not a copy-enablement request. Log each
request and the resulting herobids version in
[003-anomalies-and-deviations.md](./003-anomalies-and-deviations.md). Prefer a
clean in-Traderton deletion when one exists; reserve source requests for seams a
deletion cannot cut without authoring non-trivial logic. Rationale is in
[004-decision-log.md](./004-decision-log.md).

## Deviation discipline

If preserving parity would require authoring **non-trivial logic** (not just a
narrow stub), stop and log it in
[003-anomalies-and-deviations.md](./003-anomalies-and-deviations.md). Do not
improvise a fix to make a build go green — a silent authored fix is the exact
failure mode this project exists to avoid. Deliberate up-front design decisions
belong in this doc + the ledger, not the anomalies log.

## Open (decide when we reach them)

- The backend→consumer event/streaming channel (fills, marks, position deltas).
- Venue/execution cost reporting across the boundary (note: with decision 9,
  Traderton has no LLM cost center).

## Documents

- [001-parity-ledger.md](./001-parity-ledger.md) — progress + parity tracking.
- [002-phase-0-subtraction-plan.md](./002-phase-0-subtraction-plan.md) — copy /
  delete / seam plan.
- [003-anomalies-and-deviations.md](./003-anomalies-and-deviations.md) — logged
  deviations discovered during copy-and-delete.
- [004-decision-log.md](./004-decision-log.md) — reasoning behind the
   decisions in this doc.
- [005-consumer-boundary-contract.md](./005-consumer-boundary-contract.md) —
   the request / response, auth, deadline, and idempotency contract consumers
   use to call Traderton.
- [006-source-capability-manifest.md](./006-source-capability-manifest.md) —
   the exhaustive source capability inventory that the parity ledger tracks.
- [007-operational-readiness.md](./007-operational-readiness.md) — latency,
   equivalence, restart-resilience, and cutover proof for moving traffic to
   Traderton.
- [008-phase-1-scaffold-and-domain-slice.md](./008-phase-1-scaffold-and-domain-slice.md)
   — the Phase 1 implementation slice (domain). **Done.**
- [009-extraction-roadmap.md](./009-extraction-roadmap.md) — the outer roadmap for
   Phases 2–10 (db, engine, market-data, venues, mechanical strategy, backtesting,
   worker, api, infra): sequence, scope, stop-gates, and the per-phase pattern for
   autonomous coordinated execution.
