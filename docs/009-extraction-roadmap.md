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
| 2 | `db` — trading cluster | subtraction | domain | **Done** |
| 3 | `engine` | clean-package (+internal seams) | domain | **Done** |
| 4 | `market-data` | clean-package | domain | **Done** |
| 5 | `venues` | clean-package (+internal seams) | domain, market-data | **Done** |
| 6 | `strategy` — mechanical slice | clean-package (split) | domain, market-data | **Done** |
| 7 | `backtesting` | clean-package | domain, engine | **Done** |
| 8 | `apps/worker` — trading loop | subtraction (large) | all packages | **Done (mechanical loop; config/composition/limit → Phase 9)** |
| 9a | `apps/api`/tools — COPY surface (tools + clean trading routes + 25-tool inventory) | subtraction | db, domain, engine, venues, backtesting, worker | Blocked (stop-gate: tool contract `ToolContext` platform-fused/absent — see 003) |
| 9b | `apps/api` — AUTHORING (config shape, composition root, intake/approval, per-owner maxBots, M2 REST boundary) | authoring | 9a + holistic review | Queued (gated on holistic review) |
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
- **DONE:** `@traderton/strategy` (mechanical slice) landed. Copied `mechanical-strategy`,
  `dca-strategy`, `scan-engine` (+ tests) + `index.ts` verbatim (diff = namespace rename
  only). Dropped `llm.ts`/`llm-provider.ts`/`hybrid-strategy.ts` (+ tests) + the `@herobids/llm`
  dep entirely (never entered the tree). Both stop-gates cleared: mechanical slice is llm-free
  (no `./llm`/`./hybrid` imports), and every needed domain/market-data symbol
  (`HybridPricingIdentity` kept — it is the domain pricing-identity, not `HybridStrategy`) is
  in the Traderton barrels. Barrel trim = exactly the 3 `./llm` + 1 `./hybrid-strategy` export
  lines removed. Compiles strict, lint clean, forbidden-import sweep clean. **56 copied tests
  green** (dca 14, mechanical 18, scan-engine 24).

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
- **SEEDED + SCOPE GREW (2026-09-06):** seed plan at [docs/features/009-api-plan.md](./features/009-api-plan.md).
  Phase 9's scope spans THREE surfaces: (1) `apps/api` trading routes; (2) **the 25 trading TOOL
  modules — which live in `apps/worker/src/tools/`, deferred here from Phase 8** (decision 4); (3) the
  **Phase-8 deferred authoring**, all `Deferred (required for cutover)`: the decision-intake/approval/session
  surface (venue-account-direct resolver + `submit_decision` intake + human approvals), the Traderton-owned
  **config shape** (replacing `config.ts`/`AppConfig`, decision 2), the **trading composition root**
  (replacing the un-subsettable `index.ts`), and the per-`ownerId` **maxBots** enforcement.
- **SPLIT 9a / 9b (2026-09-07, human-approved):** Phase 9 is split so all copy work lands before the
  holistic review, and only deliberate authoring waits behind the gate.
  - **9a — COPY surface (do now):** copy the 25 trading tool modules (`apps/worker/src/tools/` — `account`,
    `analytics`, `bots`, `find-instrument`, `market-data`, `price`, `risk-limits`, `trading`, `watch` +
    support) and the clean API trading routes (`bots`, `accounts`, `analytics`, `backtests`, `credentials`,
    `reconciliation`, `actor-health`, `exports`, `datasets`, `capabilities/trading`) — verbatim
    copy-and-delete, same bar as Phases 3–8; plus the full **25-tool inventory reconciliation** against
    [006](./006-source-capability-manifest.md). **Rule:** any module that cannot go green WITHOUT an
    authored dependency (config shape, intake resolver, composition root) is **quarantined verbatim**
    (`_deferred-config/` or a sibling `_deferred-authoring/`), NOT authored early — exactly the Phase-8
    quarantine pattern. 9a's deliverable = every tool/route that copies green without authoring.
  - **9b — AUTHORING (gated on the holistic review):** the config shape, composition root, intake/approval
    surface, per-`ownerId` maxBots, and the M2 REST boundary. This is the sanctioned authoring pass
    (M1 in-process composition first; 005 REST is the M2 adapter, sequenced explicitly).
  This split also improves the review: the holistic review then covers the fuller M1 pre-authoring library
  (domain → worker loop → tool/route surface), which is the boundary to inspect before authoring begins.

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

## Milestone framing (M1 vs M2)

Per [000-vision.md](./000-vision.md) ("Two consumption milestones — same ports, two adapters"),
**Phases 8–10 target M1 — the in-process library / ports-and-adapters state** where herobids
consumes Traderton by injecting the platform-owned values it still holds (grant/`connections`,
agent message-broker drive, `maxBots` key) into Traderton's ports at the call site. **No REST/API
boundary is authored in M1.** The M2 API adapter ([005](./005-consumer-boundary-contract.md)) over
the same ports — and the per-`ownerId` `maxBots` enforcement — are **authored after M1 lands and a
holistic review**, not during Phases 8–10. Each phase below still runs the per-phase pattern; the
authored M2 work is deliberately out of the copy-and-delete scope.

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

From Phase 3 (`engine`):

- **A clean-package phase can still have exactly one seam — find it before copying.** Engine
  was "domain-only" but one file (`wake-gate.ts`) imported a domain type Phase 1 had already
  dropped (`WakeGateConfig`). The import sweep + a per-symbol check of every domain symbol the
  package imports against the Traderton domain barrel found the single missing symbol up front,
  so the seam was known before a line moved. Do this symbol-diff at investigate time.
- **"Compiles as a verbatim copy" can be impossible when the seam file needs a Phase-1-dropped
  type — and that's fine.** The verbatim copy's `tsc` fails only on the seam file; the full
  vitest suite still runs green (type-only imports are stripped at runtime), which demonstrates
  copy fidelity before the deletion. Don't force the pre-deletion build green by touching the
  seam — delete the seam, then the build is clean. State this in the plan so the executor
  doesn't mistake the expected seam-file type error for a stop-gate.
- **Same name, different subsystem — don't conflate.** The engine has a platform "wake gate"
  (agent preset-review) AND a trading "mark source". The ledger's "Wake gate" row is the
  platform one (Intentional Divergence); the trading mark source is Met. A row label is not a
  classification — read the code.
- **A test-harness alias is a seam too.** Engine tests imported `@herobids/tests` (a root vitest
  alias to `./tests`, not a package). Mirror the structure in Traderton (copy the fixture to the
  root `tests/` dir + add a `@traderton/tests` alias) so copied tests run unmodified except the
  namespace rename. The fixture is copied verbatim; the alias is scaffolding, not authoring.
- **Verbatim comments stay verbatim.** Copied files may carry source-referencing comments (e.g.
  `@herobids/db` in a JSDoc). Under copy-never-author these are left as-is (non-executable, no
  coupling); "fixing" them would be an authored edit. Log as a LOW optional-cleanup, don't change.

From Phase 4 (`market-data`):

- **A genuinely zero-seam phase exists — don't manufacture one.** The full up-front per-symbol
  domain-import diff (all 8 imported domain symbols present in the Traderton barrel) proved there
  was nothing to cut; the verbatim copy WAS the deliverable. Doing the diff at investigate time let
  the plan state "no seam" with evidence, so the implementer didn't go hunting for a deletion that
  wasn't there. Fastest, safest phase so far (diff = namespace rename only, 41/44 files byte-identical).
- **"No LLM" means no LLM-PACKAGE dependency, not "no string containing LLM".** market-data's
  `economic-calendar.ts` ships a `createLlmCalendarParser` — but it's a self-contained
  OpenAI-compatible `fetch` client taking injected config, with no `@herobids/llm` import and no
  cost center (satisfies decision 9). It is copied verbatim and Met. Grep hits for `llm`/`ioredis`
  need reading in context: local definitions and comments are not couplings. Record the
  classification in the ledger so the "no LLM" invariant stays auditable.

From Phase 5 (`venues`):

- **The seam pattern repeats: a platform file needing a Phase-1-dropped domain PORT, orphaned of
  trading consumers, is cut by deletion.** venues' `browserless-adapter.ts` (browser-pool) was the
  exact analogue of engine's `wake-gate.ts` — imports a dropped domain type, only platform consumers,
  clean deletion + barrel-trim. When the per-symbol domain diff flags a missing type, trace which
  file(s) use it and check consumers; if it's platform-orphaned, it's an Intentional Divergence delete.
- **A verbatim dependency SPEC can still break the copy — pin to the source's RESOLVED version, not
  its declared range.** herobids declared `ccxt: ^4.4.0` but green-builds at the lockfile-resolved
  `4.5.54`; a fresh Traderton install of `^4.4.0` pulled `4.5.77`, which broke a byte-identical
  trading file (`bybit.ts` cast, TS2352). Fix = pin to the source's resolved version (reproduce the
  tested build), not edit the copied code. This is dependency-reproduction scaffolding (same class as
  retargeting operator config), not a copy-never-author breach — but log it in 003 because it's a
  forced deviation from a verbatim spec. Lesson for later phases: when a copied file fails to compile,
  check whether a transitive dependency drifted before suspecting the copy.
- **Integration tests gated on credentials skip cleanly — mark the row `Met (unit; integration
  credential-gated)`, not plain Met.** Same discipline as Phase 2 db: live-venue validation is a CI /
  Phase-10 concern; don't claim full Met on unit evidence alone.

From Phase 6 (`strategy`) & Phase 7 (`backtesting`):

- **A file-level split is copy-a-subset, not copy-whole-then-delete.** strategy's mechanical/llm split
  was clean at file granularity (mechanical files don't import the llm files), so copying only the
  mechanical files (+ barrel-trimming the llm/hybrid export lines) is the faithful move; the llm files
  never enter the tree. Verified up front that the kept files don't import the dropped ones.
- **The naming-trap check is now routine:** a domain type whose name contains a dropped concept's word
  (`HybridPricingIdentity` vs the dropped `HybridStrategy`) can be trading and required. Resolve by
  reading the type, not matching the substring. Keep it if the mechanical slice imports it.
- **Verbatim non-import strings referencing `@herobids` stay verbatim — including test `describe()`
  labels.** backtesting's `describe('@herobids/backtesting package.json exports ...')` is a regression
  label; the test asserts the local (Traderton) package.json shape and passes. Only imports are renamed;
  rewriting a parity test's descriptive string would be an authored edit. Log as LOW, don't change.
- **Toolchain scaffolding is retargeted to Traderton's convention, not copied verbatim.** backtesting's
  source package.json used a bare `build: tsc` + own `typescript` devDep; Traderton uses `tsc --build` +
  project references + root toolchain (decision 16). Mirroring the Traderton package shape (as the other
  landed packages do) is correct scaffolding, not a copy-never-author concern — same class as retargeting
  operator config.

From Phase 8 (`apps/worker` — large subtraction; the hardest phase, hit 3 stop-gates):

- **Top-level import scans LIE for subtraction phases — read files in FULL + validate every imported
  symbol against the actual barrels.** The coordinator's edge-analysis script checked only top-level
  relative imports and mis-classified a 5-file agent intake/approval cluster as KEEP; reading them in full
  (and checking `agentConnections`/`AgentRepository`/… against the barrels) showed they were platform,
  needing symbols that don't exist in Traderton. THEN a second, deeper miss: the "39-file mechanical set"
  premise was verified only at the worker-relative-edge level, not against the DOMAIN barrel — 8 domain
  symbols the loop imports had been dropped in Phase 1. **Lesson: for a subtraction phase, the KEEP set is
  not proven until every KEEP file's every imported symbol is confirmed exported by the Traderton barrels.**
- **Extraction can reveal an EARLIER phase under-delivered.** Phase 1 deleted `agent-protocol.ts` wholesale
  as platform, but it held trading-owned types (`WatchPurpose`, `TradingSessionName`) + trading-adjacent
  payloads the loop needs. Correcting it needed a herobids source-fix (#2) to relocate them into a
  trading-owned domain module, then a Traderton domain re-sync. A "Done" phase is not immune to a later
  phase exposing a gap in it.
- **A large fused app may have NO faithful composition-root subset.** `apps/worker/index.ts` constructs the
  trading actors *inside* the deleted startup/session/intake wiring — there is no trading-only subset to
  carve out without authoring. Resolution: deliver the loop MODULES + copied parity tests green as the M1
  library surface; the composition root is authored later (M1-integration/Phase 9). Don't force a subset
  that doesn't exist.
- **The `_deferred-config/` quarantine pattern:** when copied files (and their tests) can't compile because
  they need a deferred/authored surface (here: the Traderton-owned config shape) or a deleted/deferred
  subject (a test-only cross-reference), MOVE them verbatim into a quarantine dir excluded from tsconfig +
  vitest, with a README explaining why + when they return. This keeps the copy on disk (not lost, not
  edited), keeps the built package green, and keeps copy-never-author intact (no in-file pruning). Prefer
  quarantining a whole test file over editing it to drop a deleted-subject block.
- **Distinguish the THREE deferral fates cleanly:** (a) DELETE = platform, gone (Intentional Divergence);
  (b) `Deferred (required for cutover)` = authored later, blocks cutover (config shape, composition root,
  per-owner maxBots, intake/approval surface); (c) quarantined verbatim copy = waiting on (a-relocation) or
  (b-authoring). Tag each in the ledger; never let a deferral read as a silent drop.

## Coordinator handoff

To run this roadmap: start at the first `Queued` phase, execute the per-phase pattern,
honor the stop-gates, and keep [001](./001-parity-ledger.md) current throughout. Each
phase's own plan lives in `docs/features/<NN>-<phase>-plan.md` (git-tracked, reviewable),
drafted at the start of that phase (step 2) — this roadmap intentionally does not
pre-author them. Precedent: [docs/features/001-strategy-registry-source-fix-plan.md](./features/001-strategy-registry-source-fix-plan.md)
(the Phase 1 source-fix request plan).
