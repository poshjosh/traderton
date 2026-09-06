# Extraction Roadmap — Phases 2–10

**Status:** living
**Created:** 2026-09-06
**Governs:** the remaining extraction after Phase 1 (the `@traderton/domain` slice,
[008](./008-phase-1-scaffold-and-domain-slice.md)) landed green.

## What this document is (and is not)

This is the **outer roadmap** for autonomous, coordinated execution of the rest of
the extraction. It fixes the **sequence, scope boundaries, deliverables, stop-gates,
and acceptance criteria** for each phase. It deliberately does **not** dictate the
internal implementation steps of any phase — those are drafted at the start of each
phase, grounded in the actual herobids code read at that point.

Rationale (learned in Phase 1): the real seams are not knowable until the code is
read. Phase 1's hardest facts — the `config/schema.ts` monolith, `blueprint.ts`
being platform not trading, and the strategy registry needing a herobids source
change — were all discovered mid-extraction, not predictable from the plan. Later
phases touch more code and harder seams. So we fix the rails (this doc) and let each
phase discover its own interior.

This roadmap is intended to be executable by a coordinator in one pass, stopping only
at the defined **stop-gates** (decisions that need explicit human approval).

All work obeys the governing rules: [AGENTS.md](../AGENTS.md), [000-vision.md](./000-vision.md)
(copy-never-author, source-fix requests, deviation discipline), and the parity
standard tracked in [001-parity-ledger.md](./001-parity-ledger.md) against the
inventory in [006-source-capability-manifest.md](./006-source-capability-manifest.md).

## Verified dependency graph (actual imports, 2026-09-06)

```
domain   ── no @herobids deps ──  [DONE — Phase 1]
  ├─→ db           (domain only)
  ├─→ engine       (domain only — 137 imports, ALL via domain ports; no db/venues/market-data)
  ├─→ market-data  (domain only)
  ├─→ venues       (domain + market-data)
  ├─→ strategy     (domain + market-data + llm; mechanical slice is llm-free)
  └─→ backtesting  (domain + engine)

apps/worker  (domain, db, engine, venues, market-data, strategy, backtesting  + platform: llm, documents)
apps/api     (domain, db, engine, venues, backtesting                         + platform: llm, documents)

STAY platform, never copied: packages/llm, packages/documents, packages/web,
and the llm slice of strategy (llm.ts, llm-provider.ts, hybrid-strategy.ts).
```

Key structural facts that shape the plan:

1. **`engine` is domain-only.** It reaches venues/db/marks only through domain ports.
   It can be extracted right after domain; it does not need db or venues to compile.
2. **Clean-package phases** (no platform-package imports; copy whole, cut internal
   seams, delete non-trading files): `engine`, `market-data`, `venues`, the
   mechanical slice of `strategy`, `backtesting`.
3. **Subtraction phases** (mixed trading+platform *within* the package; same shape as
   the domain slice — copy, then delete the large platform portion): `db`
   (~70 schema files interleaved), `apps/worker` (~173 files, ~45 `agent-*`),
   `apps/api` (routes mixing trading + agent/billing/chat/blueprint).
4. **`strategy` split is clean:** `mechanical-strategy`, `dca-strategy`, `scan-engine`
   are llm-free; only `llm.ts`, `llm-provider.ts`, `hybrid-strategy.ts` import
   `@herobids/llm` and stay agent-side. `scan-engine` needs `market-data`.

## The two phase shapes (they are governed differently)

**Clean-package phase** — lower risk, lighter gating:
- Copy the whole package verbatim, get it compiling as a copy.
- Bring copied tests across (parity harness).
- Cut internal seams (platform-owned files/imports inside the package) by deletion.
- Delete the non-trading files leaf-first; build + tests green after each step.

**Subtraction phase** — higher risk, mandatory formal planning step:
- Same as domain: the package is mixed, so the **investigate → classify → draft-plan**
  step must produce a **written, reviewable keep/delete classification** before any
  code moves. This is where fused seams, ownership questions, and source-change
  requests surface (as they did in domain). Treat every subtraction phase as likely
  to hit a stop-gate.

## Per-phase execution pattern (the loop the coordinator runs)

Every phase runs these steps in order. Steps are the same for both shapes; the
difference is how heavyweight step 2 is (formal written classification for
subtraction phases; lightweight for clean-package phases).

1. **Investigate** — read the herobids source for this phase's slice (read-only).
   Map cross-package and intra-package imports; identify seams and any file that is
   platform-owned. For subtraction phases, delegate a context-gatherer to produce a
   full keep/delete classification with fused-edge analysis.
2. **Draft the phase plan** — write `docs/features/<NN>-<phase>-plan.md` from what
   was actually found (not from this roadmap's guesses). It must list: files to copy,
   internal seams to cut, files/symbols to delete, tests to bring across, expected
   Intentional Divergences, and any suspected stop-gate. **This plan is a checkpoint:**
   for subtraction phases it is reviewed before implementation (self-review by the
   review sub-agent at minimum; human review if a stop-gate is suspected).
3. **Implement** — copy, then delete/seam-cut leaf-first. Build + copied tests green
   after every step. Commit in small, diffable steps. Obey copy-never-author: the only
   authored things are deletions and thin seams. If a seam cannot be cut by deletion
   without authoring non-trivial logic → **stop-gate** (source-fix request).
4. **Review** — compare against herobids: forbidden-import sweep (no platform imports,
   no `@herobids/*`, no llm coupling), diff surviving files against source to confirm
   they are copies (not authored), confirm copied tests are unmodified. Run the
   review-code / semantic-reviewer skill. Fix findings until only LOW remain.
5. **Test** — full build + lint + copied tests for the package (and any integration
   check the phase defines). Green is required to proceed.
6. **Update docs** — only the applicable ones: update [001-parity-ledger.md](./001-parity-ledger.md)
   statuses for the landed slice; log any deviation in [003-anomalies-and-deviations.md](./003-anomalies-and-deviations.md);
   record reasoning in [004-decision-log.md](./004-decision-log.md) if a decision was
   made; capture reusable lessons/best-practices (see "Lessons & best-practices" below).
7. **Mark phase complete** — flip the phase's status in this doc to `Done`, note the
   commit range and the green evidence (build/lint/test counts).
8. **Draft the next phase's plan** — seed `docs/features/<NN+1>-...plan.md` using
   what was learned, so the chain continues without needing this roadmap to have
   pre-planned the interior. Then proceed to the next phase (subject to stop-gates).

## Stop-gates (the ONLY reasons to pause for human approval)

The coordinator runs autonomously EXCEPT at these gates. When one is hit: stop, write
the decision up in the relevant doc, and wait for explicit approval.

1. **Source-fix request.** A seam cannot be cut by deletion without authoring
   non-trivial trading logic. Per the source-fix rule, request a behaviour-preserving
   herobids change; the human makes/tests/gates/releases it. (Precedent: strategy
   registry, [003](./003-anomalies-and-deviations.md) request #1.)
2. **Ownership ambiguity.** It is genuinely unclear whether a subsystem is trading or
   platform. (Precedent: the blueprint question.) Do not guess on anything that shapes
   the boundary; surface it.
3. **Consequential behavioural divergence.** A divergence that changes what the trading
   code *does* (not just relocates a concern) — e.g. narrowing an enum, dropping a
   capability, changing a default. Minor, clearly-platform divergences are logged as
   Intentional Divergence and continue; consequential ones need approval.
4. **Crux / shape change.** Anything that would alter the high-level goal, the phase
   sequence, the ownership model (decisions 10–15), or the copy-never-author law.
5. **Irreducible parity gap.** A source capability that cannot be preserved and is not
   a clean Intentional Divergence — must be signed off as a `Gap` in the ledger.

Everything else — the mechanical copy / delete / barrel-trim / test-prune / doc-update
cycle, ordinary Intentional Divergences, clean seam deletions — is autonomous.

## Phase list (dependency-correct order)

Status legend: `Done` / `Active` / `Queued` / `Blocked (stop-gate)`.

`db`, `engine`, `market-data` are each domain-only and therefore mutually independent;
they may be executed in any order or in parallel. The sequence below is the
recommended default (foundational data model first, then the core engine).

| # | Phase | Shape | Depends on | Status |
|---|-------|-------|-----------|--------|
| 1 | `@traderton/domain` slice | subtraction | — | **Done** |
| 2 | `db` — trading cluster | subtraction | domain | Queued |
| 3 | `engine` | clean-package (+internal seams) | domain | Queued |
| 4 | `market-data` | clean-package | domain | Queued |
| 5 | `venues` | clean-package (+internal seams) | domain, market-data | Queued |
| 6 | `strategy` — mechanical slice | clean-package (split) | domain, market-data | Queued |
| 7 | `backtesting` | clean-package | domain, engine | Queued |
| 8 | `apps/worker` — trading loop | subtraction (large) | all packages | Queued |
| 9 | `apps/api` — trading control-plane + tools | subtraction (large) | db, domain, engine, venues, backtesting | Queued |
| 10 | infra (Dockerfile, compose, CI, deploy) | clean-package (copy trading slice) | a working service | Queued |

### Phase 2 — `db` (trading cluster)
- **Copy:** the trading schema cluster + repositories named in [002](./002-phase-0-subtraction-plan.md)
  (`bots`, `decisions`, `decision-contexts`, `decision-approvals`, `decision-failures`,
  `positions`, `orders`, `fills`, `execution-plans`, `journal-events`,
  `reconciliation-events`, `balance-snapshots`, `instruments`, `venue_accounts`,
  `user_credentials`, `backtest-runs`, `replay-corpora`, `replay-market-events`,
  `market-assessment-*`, `token-safety-overrides`, `datasets`) + their repositories.
- **Deliver:** `@traderton/db` compiles strict; copied repository/schema tests green;
  the four identity FKs converted to soft references (`bots.userId`→`ownerId`,
  `bots.connectionId`→`venueAccountId`, `venue_accounts.userId`→`ownerId`,
  `backtest-runs.userId`→`ownerId`) per decisions 11–13.
- **Do NOT touch:** platform schema (`agents`, `sessions`, `skills*`, `blueprints*`,
  `chat*`, `billing*`, `agent-*`, `users` full, `connections`, `oauth/local-identities`).
- **Likely stop-gates:** the soft-FK conversion is a schema change — confirm it is a
  seam cut, not a behavioural change, per decisions 11–13; ownership of any ambiguous
  table; possible source-fix request if a trading table hard-FKs a platform table in a
  way deletion can't cleanly sever.

### Phase 3 — `engine`
- **Copy:** whole `packages/engine` (risk gate, order manager + state machine, planner,
  executors Paper/Shadow/Live/SwapLive, position/equity/daily-loss trackers, fill
  accounting, stop-loss monitor, circuit breaker, fee simulator, journal, trading cycle,
  decision intake, instrument executor, reconciliation, wake gate, mark source/selector).
- **Deliver:** `@traderton/engine` compiles strict against `@traderton/domain`; all
  copied engine tests green — **including the risk-gate exact-rules parity tests**
  ([001](./001-parity-ledger.md) risk-gate table). Highest-stakes parity surface.
- **Internal seams:** delete/stub any platform-only helper; the wake-gate config type
  was already dropped from domain — confirm engine's wake-gate compiles or is cut.
- **Likely stop-gates:** any engine file importing a platform concern the domain slice
  dropped (e.g. WakeGateConfig); risk-gate behavioural parity must be exact — a
  divergence here is consequential.

### Phase 4 — `market-data`
- **Copy:** whole `packages/market-data` (candle fetcher/Gecko, discovery inputs,
  indicators, token-safety providers) — indicators/discovery only, no LLM.
- **Deliver:** `@traderton/market-data` compiles; copied tests green.
- **Likely stop-gates:** low risk; watch for any platform/LLM coupling.

### Phase 5 — `venues`
- **Copy:** whole `packages/venues` (Hyperliquid, Bybit, Jupiter, 1inch adapters +
  public/private streams + mark sources + rate limiter + wallet generation + confirmation
  pollers + EVM/Solana signers + candle-fetcher).
- **Internal seams:** `browserless-adapter` and any browser-pool coupling may be
  platform — classify and cut.
- **Deliver:** `@traderton/venues` compiles against domain + market-data; copied venue
  tests green (unit; integration tests may be gated on credentials — note in ledger).
- **Likely stop-gates:** browser-pool/browserless ownership; any venue adapter pulling
  a platform service.

### Phase 6 — `strategy` (mechanical slice)
- **Copy:** `mechanical-strategy.ts`, `dca-strategy.ts`, `scan-engine.ts` (+ their tests)
  and the package shell/`index.ts`.
- **Delete / do NOT copy:** `llm.ts`, `llm-provider.ts`, `hybrid-strategy.ts` (agent-side,
  Intentional Divergence — same seam as the mechanical-only registry).
- **Deliver:** `@traderton/strategy` (mechanical) compiles against domain + market-data;
  copied mechanical tests green.
- **Likely stop-gates:** `index.ts` re-exporting llm slices (barrel trim); confirm the
  mechanical slice needs nothing from the dropped llm files.

### Phase 7 — `backtesting`
- **Copy:** whole `packages/backtesting` (replay, historical execution, replay corpora).
- **Deliver:** `@traderton/backtesting` compiles against domain + engine; copied tests green.
- **Likely stop-gates:** low risk; watch for platform coupling in replay orchestration.

### Phase 8 — `apps/worker` (trading loop) — LARGE SUBTRACTION
- **Copy:** the trading-loop runtime only — trading actors, stream pool, scan loops,
  executors wiring, reconciliation loop, actor health, the mechanical trading cycle.
- **Delete:** agent-session machinery, agent evaluation, messaging/alerting, wake
  scheduler for agents, LLM/assessment loops, `agent-*` runtime (~45 files) — platform.
- **Deliver:** a worker that runs the mechanical trading loop against the extracted
  packages; copied trading-loop tests green (incl. the `agent-risk-limits.parity.test`
  and cross-venue-lifecycle where trading-owned).
- **Likely stop-gates:** this is the biggest mixed surface — expect ownership questions,
  fused seams, and possibly source-fix requests. Formal classification + review before
  implementing. The consumer-boundary seam (decisions 2–3, [005](./005-consumer-boundary-contract.md))
  starts to matter here.

### Phase 9 — `apps/api` (trading control-plane + tools) — LARGE SUBTRACTION
- **Copy:** trading control-plane routes + the 25 trading tool endpoints
  ([006](./006-source-capability-manifest.md) inventory) + boundary handlers.
- **Delete:** agent/billing/chat/blueprint/auth-heavy/skill routes — platform.
- **Deliver:** the Traderton API exposing the trading tools over the boundary
  ([005](./005-consumer-boundary-contract.md)); copied route/tool tests green;
  the 25-tool inventory fully accounted for in the ledger.
- **Likely stop-gates:** the boundary contract implementation (auth/idempotency/deadline)
  is partly authored infrastructure, not copied trading logic — clarify what is copied
  vs. what the boundary contract legitimately requires as new seam code; ownership of
  shared route middleware.

### Phase 10 — infra
- **Copy:** the trading-relevant slice of herobids' proven infra (Dockerfile, compose,
  CI) and delete the rest; Traderton gets its own Postgres, Redis, host, pipeline
  (own-database / own-TLD decisions). Comes last — it wraps a working service ([004](./004-decision-log.md)).
- **Deliver:** the service builds, boots, and passes the operational-readiness checks
  ([007-operational-readiness.md](./007-operational-readiness.md)): health, latency,
  equivalence/shadow validation, restart resilience, rollback.
- **Likely stop-gates:** production cutover is an explicit operator decision
  ([007](./007-operational-readiness.md)); equivalence validation against herobids is
  mandatory before removing the legacy path.

## Completion of the whole extraction

The extraction is complete when the [006](./006-source-capability-manifest.md)
inventory is fully accounted for in [001](./001-parity-ledger.md) (Met / Improved /
Deferred / Gap / Intentional divergence — nothing silently dropped), the cutover
sign-off gates in [001](./001-parity-ledger.md) are met, and the operational-readiness
gates in [007](./007-operational-readiness.md) pass. The 25-tool inventory and every
mandatory subsystem group must each have a ledger disposition.

## Lessons & best-practices (living — appended as phases complete)

Captured so later phases and the coordinator improve on earlier ones. Seed entries
from Phase 1:

- **Read before you delete.** Map the real dependency graph (context-gatherer for
  mixed packages) before touching code. The plan's predicted seams were wrong in
  Phase 1; the code told the truth.
- **1:1 with source is preserved by deletion, not repurposing.** Never hollow out a
  file into something that matches no source file. A platform file is deleted (diff =
  "file removed"); a mixed file has its platform blocks deleted in place.
- **Build + copied tests green after every step.** Small diffable commits. A red build
  after a delete means a real dependency was found — fix the seam there.
- **Copied tests covering deleted platform capability are removed with their subject**
  and the affected slice stays `Intentional divergence` / `Deferred` — never marked
  `Met` on partial evidence.
- **Prefer in-Traderton deletion; reserve source-fix requests** for seams a deletion
  cannot cut without authoring. Each source request costs a herobids test/gate/release
  cycle.
- **A registry/config owned by trading can still carry agent-only entries** — the seam
  is which *entries* it registers, resolved by not calling the agent-mode hook
  (mechanical-only), not by rewriting the registry.

From Phase 2 (`db`):

- **The plan doc is a guide, not ground truth — the code is.** 002 named "four identity
  FKs"; the real FK graph had seven `users` FKs among copied tables + a platform-coupled
  `market-assessment-requests` mislabelled by the "market-assessment-*" glob. Always
  verify the plan's named seams against the actual dependency/FK graph.
- **Soft-reference rule** (now in [004](./004-decision-log.md)): no Traderton-copied table
  hard-FKs a platform table; every `users` FK → soft `ownerId`; platform FKs dropped or
  softened per decisions 10–13; intra-trading FKs preserved. This is a sanctioned authored
  seam, not a stop-gate — apply uniformly without re-litigating per table.
- **Before escalating a fused-METHOD edge to a source-fix, check consumers across ALL of
  herobids (read-only, any phase).** A kept class may carry platform-coupled methods; if
  only platform code calls them, delete the methods in place (a deletion). Escalate only
  when a trading consumer needs the reshaped behaviour.
- **"Is it trading or platform?" is too coarse for a capability.** Ask (1) is the
  capability trading, (2) is the implementation platform-coupled, (3) will herobids rely
  on Traderton for it in the end state. See the "herobids becomes a consumer" section in
  [000](./000-vision.md). The implementation may be Intentional Divergence while the
  capability is a **required** Traderton obligation.
- **Two kinds of Deferred (tag them distinctly in the ledger):** *Deferred-optional* (no
  parity obligation, e.g. bot cloning) vs *Deferred-required-for-cutover* (herobids will
  rely on Traderton for it; blocks cutover until met). Cross-reference required deferrals
  to their tool/subsystem row so the cutover gate cannot pass without them.
- **Cross-phase information dependency (structural).** A phase's seam decision can depend
  on an unextracted later phase's design (Phase 2's BotRepository limit methods depend on
  how Traderton's worker/api create bots, Phases 8–9). When a kept class has a
  method whose fate depends on an unextracted consumer: keep it if it compiles
  owner/venue-clean; delete it if its only callers are platform (staying in herobids);
  and record any capability herobids will still need as a Deferred-required ledger entry
  for the owning phase. Do not author speculative trading logic to resolve it early.
- **Plans must state the guard, not an optimistic "expected clean."** Phase 2's plan said
  a seam was "expected clean"; it wasn't. Editorializing an expectation primes an agent to
  under-escalate. State the stop condition; let the code decide.
- **Review step must sweep ROOT config** (vitest aliases, tsconfig refs, package.json) for
  references to files/exports deleted in the phase. Phase 1 left a stale vitest alias to a
  deleted file; Phase 2's review caught it.
- **Operator config (DB names, connection strings, service names) is retargeted to
  Traderton, not copied verbatim** (decision 1, own database). Not trading logic; not a
  copy-never-author concern.

## Coordinator handoff

To run this roadmap: start at the first `Queued` phase, execute the per-phase pattern,
honor the stop-gates, and keep [001](./001-parity-ledger.md) current throughout. Each
phase's own plan lives in `docs/features/<NN>-<phase>-plan.md` (git-tracked, reviewable),
drafted at the start of that phase (step 2) — this roadmap intentionally does not
pre-author them. Precedent: [docs/features/001-strategy-registry-source-fix-plan.md](./features/001-strategy-registry-source-fix-plan.md)
(the Phase 1 source-fix request plan).
