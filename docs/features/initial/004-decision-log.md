# Decision Log — the *why* behind the decisions

**Status:** living
**Purpose:** capture the reasoning behind the decisions in
[000-vision.md](./000-vision.md), so a future agent (or human) has the judgment
to handle edge cases the same way — not just the rule, but why the rule exists.

Read this when a decision seems arbitrary or when you hit a case the rules
don't obviously cover. The reasoning tells you which way to lean.

---

## Why extract at all

Trading was fused into an agent + messaging platform through four seams: a
shared database schema, shared streaming infra, shared config, and a shared
risk gate. Attempts to draw a clean tool-invocation boundary (the herobids
`docs/features/initial/features/pending/000-capability-foundations` set) specified the
request/response tool contract well but left the *data*, *streaming*, *config*,
and *risk-gate authority* seams unowned. Trading is also becoming its own
product (own TLD, external API/MCP/skills for other agents), which justifies a
separate repo rather than internal decoupling.

## Why copy-and-delete, not rewrite-from-scratch

Prior experience: rewriting a large system from scratch with an LLM agent lost
features and never reached parity — the larger the task, the more the agent
"filled in" plausible behaviour and omitted hard-won detail, then wrote tests
asserting the omitted version (green tests, real regression).

Copy-and-delete inverts this. Starting from real, working code means behaviour
is present with all its detail; the agent's job becomes *removal* (visible: a
bad delete breaks the build/tests) instead of *creation* (invisible omissions).
Hence the core rule: **copy, never author.** The only authored things are
deletions and thin seam-stubs.

## Why parity, not "does it run"

Liveness ("it boots") is a weak bar — a trading system can run and silently do
less (fewer venues, a weaker risk gate, a dropped edge case). The source repo
is the specification; we may improve but not degrade. The parity ledger makes
every source capability either Met / Improved / Deferred / Gap / Intentional
divergence — nothing is silently dropped. Copy-and-delete makes this cheap:
we start at 100% parity and only account for *subtractions*.

This is also why equivalence or shadow validation still matters during cutover.
Decision 4 in [000-vision.md](./000-vision.md) rejects public compatibility
debt such as alias routes and legacy field names; it does **not** relax the
proof bar. We still need side-by-side evidence that Traderton behaves like the
source before moving traffic.

## Why the anomalies log exists

The dangerous moment in copy-and-delete is hitting something broken or a seam
that resists a narrow stub. An agent's instinct is to author a fix to make the
build green — which is the exact silent-rewrite failure we're avoiding. The
anomalies log converts that into a visible, reviewable decision: stop, log,
surface. Deliberate up-front decisions do NOT go there — only mid-extraction
forced deviations.

## Why the seam sits between `connections` and `venue_accounts`

Traced the full chain: `user_credentials` → `venue_accounts` → `connections`
→ `agent_connections` → `agents`.

- `connections` is the platform's **single grantable entity** and is general —
  it also covers telegram/twitter, not just venues. So it (and
  `agent_connections`, `agents`, `users`) is platform identity/grant → stays.
- `venue_accounts` + `user_credentials` only make sense for venues Traderton
  actually calls. **Credential custody follows the venue caller** → they move
  to Traderton.

So the cut is between the grant layer (platform) and the venue-execution
identity (Traderton). `bots.userId` → soft `ownerId`; `bots.connectionId` →
`venueAccountId` (the connection indirection is platform-only; Traderton binds
bots directly to the venue account it already references).

## Why Traderton is multi-tenant but not the identity/billing authority

Feature parity says "reproduce everything," but the point of the split is that
trading no longer *owns* users or billing. You can't have both. Resolution:
Traderton stores an opaque `ownerId` + `actor` supplied (already authenticated)
by the caller, scopes all data by it, and enforces per-owner isolation — but it
never resolves *who* the owner is or bills them. So user-management and billing
are **Intentional Divergence**, not Gaps: a relocated concern, not a degraded
one.

That does not eliminate every money-related concern from Traderton. Platform
billing authority stays outside by design, but Traderton-native usage metering
or execution-cost attribution may still return later as a Deferred concern.
Keeping those ideas separate avoids mixing "not owned here" with "owned here,
but postponed."

## Temporary retention of market assessment pending legal-isolation decision

**Decision date:** 2026-09-16. **Status:** temporary; this is a mandatory
reassessment before legal-isolation sign-off, not a permanent capability
classification.

`market_assessment_requests`, `market_assessment_runs`, and
`market_assessment_artifacts`, together with the request, evidence, ranking,
review, and preset-transition workflow, currently remain in Herobids. This
preserves the working agent-preset review behavior while no replacement boundary
exists. The current c4.9f table-drop exclusion remains correct operationally:
dropping the tables today would break live worker behavior.

This temporary retention does **not** conclude that market assessment is outside
Traderton's product/legal boundary. The capability is trading-adjacent: it
consumes Traderton `check_regime`, `get_volatility`, and `score_candidate` data;
ranks trading presets for a canonical instrument; and updates an agent preset
binding used for future entries. It does not currently submit a decision, create
a bot, execute an order, or alter an existing position. `entries_only` is the
only supported transition mode; modes that would tighten or fully transition
existing positions are rejected.

The platform concerns currently interwoven with the capability are agent/user
identity, agent opt-in and allowed-preset policy, platform billing and usage
records, agent wakes, platform LLM configuration, and the agent-binding/config
update lifecycle. Traderton currently carries only `runs`/`artifacts` schema and
domain types, has no `requests` table, and has no runtime consumer.

### Ownership options retained for the future decision

The future 008 brief must evaluate the complete workflow, not merely its three
tables. It must include the following unranked options and may derive a better
one from grounded evidence:

1. **Permanent Herobids retention.** Treat it as platform agent-reasoning and
  record an explicit legal-isolation exception for a trading-adjacent
  capability.
2. **Complete Traderton ownership.** Move request lifecycle, assessment state,
  evidence/scoring, ranking, and artifacts behind the boundary; Herobids
  becomes a consumer and retains only platform-facing concerns that the
  resulting contract deliberately accepts.
3. **Deliberate boundary split.** Traderton owns canonical market identity,
  evidence, scoring, artifacts, and their cache/idempotency; Herobids retains
  platform billing, agent policy, review scheduling/wakes, and application of
  an approved preset. The decision must define exactly one owner for each
  cache, idempotency key, and state transition.
4. **Removal/deprecation.** Remove market-guided preset transitions rather than
  migrating them. This is a product/parity reduction and requires explicit
  treatment as such.

Until that decision, no new local market-data provider, trading execution,
trading-state access, or in-process trading package dependency may be added to
Herobids under the temporary-retention label. The mandatory trigger is the
legal-isolation sign-off / final cutover approval, or an earlier dedicated
assessment-ownership slice. Record the ruling in this log and its status in 001
and 011.

## D1-coda: local trading-package removal and where consumer type contracts now live

**Decision date:** 2026-09-17. **Gate result:** settled within the rules
(008 §9.1 — parity does not discriminate the placement since types erase at
compile; no rule is violated, no recorded decision contradicted, no objective
undermined; the change is branch-reversible). No human ratification required.

After Slice 4 Plan A removed the stale manifest edges, the remaining static
type contracts that kept the local trading packages compiling were decided by
the decision agent (Slice 4 Plan B checkpoint) and implemented in herobids
`55c53756` + `0d161a74` on `consume-traderton`:

1. **Re-pointed to `@herobids/domain`** (structurally identical, already
   publicly exported): `RegimeParams`, `RegimeResult`, `PriceCandle`,
   `ScannerCandleTarget`.
2. **Copied verbatim into narrow worker/API seams**, each citing its copy
   source, because the domain package must not carry them:
   - `apps/worker/src/traderton/price-contracts.ts` (source:
     `packages/market-data/src/price-service.ts:21-69`) — the price port block
     (`PriceSource`…`PriceService`). `createBoundaryPriceService` remains a REST
     adapter over `resolve_price_target`.
   - `apps/worker/src/market-intelligence/preset-scan-contracts.ts` (source:
     `packages/strategy/src/scan-engine.ts:38-122`) — `ScoredSignal`,
     `IndicatorConfig`, `ScanConfig`. **Correction of the brief's premise:** the
     domain zod-inferred `IndicatorConfig` has required sub-object keys while
     the strategy-side type is all-optional (`{}` satisfies only the strategy
     shape — verified by tsc probe). The seam keeps the strategy-side shape;
     do NOT swap it for the domain type.
   - `apps/worker/src/agent-risk-limits-contracts.ts` (source:
     `packages/engine/src/risk-gate.ts:12-34`) — `RiskLimits`.
   - `apps/api/src/providers/solana-address.ts` (source:
     `packages/venues/src/solana-signer.ts:238-304`) — `deriveSolanaAddress` +
     private base58 helpers, moved verbatim. This honours the D1-3b ruling
     (manual-Jupiter address derivation stays in herobids API). A focused unit
     test was added (parity-permitted improvement; no test covered it in either
     repo before).
3. **Deleted, not copied:** `apps/worker/src/shared/decision-validation.ts`
   (`LevelValidationError`) — verified orphaned (zero importers incl. dist; the
   live counterpart is Traderton-side `composition/decision-intake.ts`).
4. **All four local packages deleted in one slice** (`packages/{venues,engine,
   strategy,market-data}`), together with their manifest deps, tsconfig
   references, vitest aliases, Dockerfile `--filter` builds, the lab's
   market-data dep, and the root tsconfig references. The packages were mutual
   importers (strategy→market-data, venues→market-data), so no partial
   deletion was possible.
5. **Two in-scope deviations found and resolved within the rules** (recorded
   for the audit trail):
   - The rate-limit lab DID have real imports of market-data (the ruling's
     "no source imports" premise was false): `scenario-runner.ts` value-imports
     `createSharedRateBudgetCoordinator`, plus type imports of market-data
     types. Resolved by verbatim-copying `rate-limiter.ts` (334 lines, pure
     rate-limit infrastructure — no market-data fetch logic) and the
     `PROVIDER_REQUEST_CLASSES`/`RequestGate` type block into the lab;
     lab tests 3/3 green.
   - `scripts/ts/test-forexfactory-parser.ts` (surfaced by the mandated script
     sweep; not on the checklist) value-imported market-data's
     `ForexFactoryCalendarAdapter`/`createScrapflyFetch`/`HttpError`; its
     subject (economic-calendar parsing) moved Traderton-side with the B6
     re-point (Traderton `packages/boundary/src/bin.ts` acquisition loop +
     `economic-calendar.test.ts`). Deleted with zero remaining references —
     mirrors the Plan A obsolete-script deletion.
6. **Test-mock rework:** `preset-scorecard-runner.test.ts` dropped the
   `vi.mock('@herobids/strategy')` + 5 `expect(scoreCandidate).not.toHaveBeenCalled()`
   assertions — the in-process scorer no longer exists, so the isolation
   property is now structural rather than spy-enforced. Payload-shape and
   scorecard-mapping assertions preserved. Intentional divergence, no parity
   change.

**Isolation effect:** herobids now structurally cannot import trading
execution/planning/risk logic — the packages are gone, not merely unimported.
Behaviour is unchanged (type-only changes + one verbatim function move + one
orphan deletion + dead-mock rework). Full verification at commit: api/worker
`tsc --noEmit` clean, `pnpm lint` clean, worker suite 3013/11 skip, api suite
1483/0 (incl. new solana-address tests 5/5), lab 3/3, `git diff --check` clean,
zero remaining alias/path/dynamic references. The one full-suite failure
(`tests/staging-config-validation.test.ts > staging config has liveRollout
disabled`) is pre-existing and unrelated (reproduced on clean HEAD).

**Non-goals:** this does NOT decide the market-assessment ownership question
(see "Temporary retention" above) — the assessment tables/orchestration remain
in herobids pending that separate 008 ruling. `ScoredSignal`/`IndicatorConfig`/
`ScanConfig`/`RiskLimits` now live in herobids-local seams with declared copy
sources; if Traderton later publishes a boundary-contract artifact (option B of
the ruling, routed to 010 as a later-option), these seams become the migration
surface.

## Why bots are mechanical (the cyclical tension, resolved)

The old model let bots use LLM intelligence and let agents run the mechanical
scanner — two capabilities on both actors. That symmetry made the actors
collapse into each other: if a bot can reason it's an agent; if an agent runs
mechanics it's a bot → no fixed point → the cycle.

The code showed the misfit concretely: a bot's `config.strategy.type` could
select `LlmStrategy` or `HybridStrategy` (both call the LLM), alongside the
mechanical `Mechanical`/`Dca`. Regime/scanner, by contrast, is *mechanical*
intelligence (indicators only, no LLM).

Resolution: **intelligence is the agent's defining trait; mechanical execution
is the bot's.** A bot executes a deterministic strategy and submits decisions;
it does not reason. LLM/Hybrid decision-making relocates to the agent, which
calls `submit_decision`. This breaks the cycle and gives Traderton a coherent
mechanical identity with **no LLM dependency and no LLM cost center**. Bots
being mechanical-only is a deliberate Intentional Divergence (source allowed
LLM/Hybrid bots).

Implication for the split: `llm` stays agent-side; `strategy` is split —
mechanical (`Dca`, `Mechanical`, `scan-engine`, `regime`) moves, LLM (`Llm`,
`Hybrid`, `llm-provider`) stays.

### Where mechanical-only is (and is not) enforced — the config-enum question

Recorded 2026-09-07 (M1 holistic review, finding S-1). Mechanical-only shows up at two
layers, and they are deliberately enforced differently:

- **Registry / runtime layer (enforced now):** the strategy registry never calls
  `registerAgentDecisionModes({ llm, hybrid })`, so `validateStrategyParams` reports
  `momentum:llm` / `momentum:hybrid` as unsupported, and `@traderton/strategy` exports only
  `Mechanical` / `Dca`. This is the copied+trimmed enforcement (source-fix #1) and is the live
  mechanical-only guarantee today.
- **Config-enum layer (NOT narrowed yet — by design):** `StrategySchema.decisionMode` is a
  **verbatim copy** of herobids' `z.enum(['mechanical','llm','hybrid'])`, so a bot config with
  `decisionMode: 'llm'` still *parses* (the registry then rejects it downstream). The enum was
  left as-is because narrowing it is a consequential authored behavioural change — exactly the
  kind this project refuses to make silently during the copy phase.

Why defer the narrowing to 9b rather than do it now: trimming the enum (and its copied
acceptance test) is *authoring* against a verbatim copy, which breaks copy-never-author and 1:1
diffability during extraction. Traderton owns its config (decision 2), so the right place to
express a tighter mechanical-only boundary is the **authored 9b config/composition surface**,
recorded as a signed-off Intentional Divergence. Two acceptable shapes: (a) narrow the
Traderton-owned config schema (or a Traderton wrapper over the copied `StrategySchema`) to
`decisionMode: ['mechanical']` and update the copied test — crispest guarantee; or (b) keep the
copied enum and rely on the registry rejection, documenting that config parse is
permissive-by-inheritance while the runtime is mechanical-only. Either way, add an explicit
live assertion of the mechanical-only guarantee at Traderton's owned boundary (ties to the
review's harness note that copied tool tests are not type-checked against the Traderton surface).
This is a 9b design decision, not a pre-9b blocker or a copy defect.

**DECISION (2026-09-07, human-approved): option (a) — narrow-and-diverge. IMPLEMENTED (item A′).**
9b tightened the Traderton-owned config boundary via a **wrapper** (not by editing the copied
`StrategySchema`): a new `MechanicalStrategySchema` (`decisionMode: z.enum(['mechanical']).optional()`
+ the same dca-or-required refine) is what `BotConfigSchema.strategy` validates against. The copied
`StrategySchema` stays byte-verbatim (its copied test asserting `llm` is accepted stays true — the
narrowing lives on the Traderton wrapper). A dedicated authored test (`config/mechanical-only.test.ts`)
asserts the guarantee (llm/hybrid rejected; mechanical/dca accepted). This chose the wrapper (a-i)
over editing the copy (a-ii) to keep 1:1 diffability of `StrategySchema`. Rationale for (a) over (b): it makes the mechanical-only guarantee
an explicit product invariant at the boundary Traderton owns, rather than an emergent property of
downstream registry rejection — closer to decision 3 (own risk/enforcement) and easier to test and
reason about. This is a sanctioned authored Intentional Divergence on Traderton's owned config
surface (decision 2), executed in 9b (not during the copy phase).

## Why Traderton does not own human approvals

Decided 2026-09-07 (human-confirmed), during 9b planning, while scoping the intake surface.

The question arose from a config knob (`agentApprovals.ttlMs`) but the real issue is a
boundary one: **does Traderton own the human-approval lifecycle?** Answer: **no.** The
consuming agent platform owns it.

The model — "agents ask for approvals": when a consumer's policy says a proposed trade needs
a human sign-off, the **consumer** decides that, asks the human (its own UI / messaging), holds
the pending approval (its TTL, short-code, expiry, per-user ownership), and — once the human
approves — calls Traderton's `submit_decision`, the *same* port a direct (no-approval) decision
uses. Traderton has **no** notion of a pending approval, an approver, or an authorization mode.
Traderton owns only decision **execution** (`submit_decision` → risk → planner → executors).

Why this is the right seam (evidence from the herobids source, read 2026-09-07):
- The approval flow is keyed on the platform **`userId`** (`approval.userId !== userId → not_owned`;
  it hard-requires "an owned agent with a user"). Traderton takes an opaque `ownerId` and never
  resolves *who* the user is (decision 10) — so an approval concept keyed on user identity cannot
  be Traderton's.
- `authorizationMode` (`direct | approval_required`) is read from the platform `agent.unifiedConfig`.
- The pending path notifies via the platform messaging surface (Telegram, `InstanceEventPublisher`)
  — the "ask a human" channel is the messaging platform, which stays in herobids (decisions 7–9).
- What the approval flow *reuses* from Traderton is only `submitDecisionForExecution` on approve —
  i.e. the execution Traderton already owns. Everything wrapping it (ask/hold/expire/notify/own-by-user)
  is platform.

Consequences:
- The copied `decision_approvals` table + `DecisionApprovalRepository` (Phase 2) were an **orphan**
  in Traderton (no trading code imported them). They are **deleted** (Intentional Divergence, logged
  in [001](./001-parity-ledger.md)); the initial migration regenerated (23→22 tables). Deletion is the
  sanctioned action (copy-and-delete), preserves 1:1 diffability, and is not a silent drop — the
  *capability* is consumer-owned, and Traderton's obligation (`submit_decision` execution) is unchanged.
- 9b's intake surface (item C) shrinks accordingly: no `ApprovalService`, no `authorizationMode` fork,
  no `agentApprovals` config in Traderton. Item C is just the venue-account-direct `DecisionIntakeResolver`
  + a slim decision handler that drives `submitDecisionForExecution`.
- This tightens, and is consistent with, the Phase-8 reclassification that already put the
  intake/approval/session cluster on the platform side.

## Why `blueprint.ts` is a within-file seam

`blueprint.ts` is platform bot/agent-blueprint policy (agent style, preset
policies, wake prefs) → stays platform. But it also contains genuinely
trading-shaped schemas (risk, execution defaults, token safety) that are the
"instance config" Traderton must own. So it's a seam *inside a file*: copy the
risk/execution/token-safety schema pieces, leave the agent-policy pieces. Flag
carefully — this is where an agent would copy too much or drop a field.

## Why infra comes last, and is copied not authored

Infra (Hetzner, Dockerfile, compose, CI) is the outermost layer — it wraps a
working service. Building it early yields a container with nothing coherent
inside (liveness, not parity). It belongs at the end of the build sequence.
When we reach it, copy the trading-relevant slice of herobids' proven infra and
delete the rest — same copy-and-delete principle. Traderton gets its own
Postgres, Redis, host, and pipeline (own-database + own-TLD decisions).

## Why the data seam turned out small (a reassurance)

Early fear was a 70-table shared schema with cross-boundary FKs. Investigation
showed the trading core tables (`decisions`, `positions`, `orders`, `fills`,
`journal-events`, etc.) are **already soft-linked** — plain `text` columns, no
FKs. The only trading→platform hard FKs are the identity/grant seam above. This
is strong evidence the split follows a real seam, not an arbitrary line.

## Why source-fix requests are allowed (never source edits)

Copy-and-delete lets Traderton author only deletions and thin seams. When the
source has an awkward shape — e.g. a single symbol fusing trading and platform
fields — the choices inside Traderton are to author a workaround (forbidden) or
stall. The better fix is usually to make the seam clean *at the source*: reshape
herobids so trading and platform concerns are separable, then copy the
already-clean shape.

So Traderton may **request** such a reshape; it must never edit herobids itself.
Reasons:

- **Preserves 1:1 parity.** If herobids changes and Traderton copies it, the two
  stay diffable — the whole point of keeping file-for-file correspondence with
  the source, so we can monitor parity and port bug-fixes cleanly. An authored
  Traderton-only fix would create exactly the drift we are avoiding.
- **Keeps authorship where the context and tests live.** A reshape validated by
  herobids' real suite and released is trustworthy in a way an in-Traderton
  guess is not.
- **Respects herobids as READ-ONLY.** Traderton asks; the owner makes, tests,
  gates, and releases. Clean separation of authority.

Guardrails: requests must be **behaviour-preserving** (validated by herobids'
existing tests) — altering trading behaviour is a product decision, not a
copy-enablement request. Every request and the resulting herobids version is
logged in [003-anomalies-and-deviations.md](./003-anomalies-and-deviations.md).
Prefer a clean in-Traderton deletion when one exists; each source request costs a
full herobids test/gate/release cycle, so reserve it for seams a deletion cannot
cut without authoring non-trivial logic.

## Why blueprint.ts stays platform, and bot cloning is a planned Traderton feature

`blueprint.ts` in herobids is the **marketplace/authoring** layer — reusable
agent/bot templates with revisions, publication status, fork lineage, likes,
popularity/trending scores, and browse cursors. Investigation of its consumers
(2026-09-05) confirmed it is not part of the trading path:

- Bot creation, validation, and startup all validate against **`BotConfigSchema`**
  (defined in `config/schema.ts`, trading-owned), not the blueprint payload —
  `apps/api/routes/bots.ts`, `apps/worker/agents/agent-message-broker.ts`,
  `apps/worker/index.ts`.
- The bot **execution** path (`agent-trading-actor.ts`, `packages/engine`) has no
  blueprint references at all.
- `BotBlueprintRevisionPayload` is used only by the marketplace API. Critically,
  `apps/api/services/blueprint-projection.ts` builds the bot blueprint payload
  *from* a bot row (`projectBotToBlueprintPayload`) — the blueprint is a
  marketplace **view over** the bot's `config`, and `BotConfigSchema` is the
  source of truth.

So blueprint.ts is platform and is **not copied** into Traderton (Intentional
Divergence). We deliberately do **not** keep a hollowed `blueprint.ts` containing
only `BotConfigSchema`: `BotConfigSchema` is defined in `config/schema.ts`, so a
blueprint.ts holding only it would match no source file and break the
file-for-file 1:1 diff discipline. 1:1 parity is preserved by deleting the
platform file (the diff is simply "file removed"), not by repurposing it.

**Planned Traderton-native capability — bot reproduction / cloning.** We want
Traderton to let users reproduce/clone a bot from day one. This does not need the
marketplace machinery. From the herobids clone/projection behaviour, reproducing
a bot is: take the bot's stored `config` (the authored recipe validated by
`BotConfigSchema`), strip instance-only fields (`venueAccountId`, `connectionId`,
`status`), and create a new bot from that recipe bound to a (possibly different)
venue account / owner. The config is the reproducible essence; the marketplace
publish/fork/browse flow is separate and stays platform.

This is a deliberate future feature, not a parity gap and not an anomaly. It is
recorded here + in the ledger as a planned Traderton-native capability built on
`BotConfigSchema`, to be designed and built in a later phase — not authored during
the Phase 1 domain-slice extraction.

## The soft-reference rule (generalizing decisions 10–13)

Decisions 10–13 name specific identity FKs to convert (`bots.userId`,
`bots.connectionId`, `venue_accounts.userId`, `backtest-runs.userId`). Phase 2 (db)
investigation found the actual FK graph has more copied trading tables that hard-FK a
platform table than decisions 10–13 enumerated: `user_credentials.userId`,
`replay_corpora.userId`, and `datasets.userId` also reference `users`. The named list
was illustrative, not exhaustive.

The governing principle behind those decisions (decision 10: Traderton does not own
user identity — it accepts an authenticated `ownerId` + `actor` at the boundary) implies
a general rule, adopted 2026-09-06:

> **Soft-reference rule.** No Traderton-copied table hard-FKs a platform table. Every
> `users` FK in a copied trading table is converted to a soft `ownerId` (plain text
> column, no `.references()`, validated at the boundary). Every other platform FK
> (`connections`, `agents`, `billing*`) is dropped or softened per decisions 11–13
> (e.g. `bots.connectionId` → `venueAccountId`). Intra-trading FKs (a copied table
> referencing another copied table — e.g. `bots.venueAccountId` → `venue_accounts`,
> `venue_accounts.credentialId` → `user_credentials`, `market_assessment_artifacts` →
> `market_assessment_runs`) are preserved.

This is a sanctioned **authored seam**, not an anomaly and not a stop-gate: it is the
schema-level expression of the ownerId boundary model. Apply it uniformly to every
copied table without re-litigating per table.

Corollary (from the same investigation): a KEPT repository/class may carry individual
platform-coupled *methods* (e.g. `BotRepository.getResolvedVenueAccount` reads
`connections`; `listRunningBotsForInactiveAgents` joins `agents`). Before treating such
a method as a fused edge needing a source-fix request, **check its consumers across all
of herobids (read-only, any phase)**: if only platform code calls it, delete the method
in place (a deletion, not authoring). Escalate to a source-fix only when a trading
consumer needs the reshaped behaviour.

## Why "herobids becomes a consumer of Traderton" changes how we classify

Discovered while extracting `packages/db` (Phase 2), on the BotRepository seam. The
end-state (stated in [000-vision.md](./000-vision.md): herobids becomes a runtime
consumer of Traderton) means the question "is this capability trading or platform?"
is too coarse. The precise questions are:

1. **Is the CAPABILITY trading?** (bots, decisions, execution, limits → yes.)
2. **Is the current IMPLEMENTATION platform-coupled?** (e.g. per-agent limit locked on
   the `agents` table → yes.)
3. **In the end state, will herobids RELY on Traderton to provide this capability?**

A capability can be "trading capability, platform-coupled implementation, and herobids
will depend on Traderton for it." In that case:

- The platform-coupled implementation → **Intentional Divergence** (relocated, not
  copied). It is deleted from Traderton; it stays in herobids' agent layer for now and
  is retired when herobids cuts over to calling Traderton.
- The capability itself → **Deferred but REQUIRED for cutover** — Traderton must
  provide it (via the relevant tool, e.g. `create_bot`/`start_bot`), because
  herobids-on-Traderton must not be weaker than herobids-today. Record it against the
  affected tool/subsystem in the ledger so the cutover gate cannot pass without it.

Worked example (BotRepository, Phase 2): `tryCreateBotWithLimit` /
`tryMarkBotRunningWithLimit` enforce a per-agent maxBots limit by row-locking `agents`.
- Implementation (agent-keyed, agents-locked) → Intentional Divergence (platform); the
  methods are DELETED from `@traderton/db` (their only callers are the platform
  agent-broker + worker runtime, which stay in herobids).
- Capability (limit-enforced bot creation/start) → Deferred-REQUIRED; owned by
  Traderton's bot-lifecycle phase (worker/api), where the limit key (per-owner /
  per-venue-account / operator config) is decided. herobids will call Traderton's
  `create_bot`/`start_bot`, so this MUST land before cutover; herobids' per-agent
  enforcement is the parity reference for "not weaker than."

Corollary for the automation flow: a novice agent that lacks the "herobids becomes a
consumer" model will mis-file such a capability as optional backlog and risk a silent
parity regression at cutover. The model is now explicit in 000; the ledger must tag
required-for-cutover Deferrals distinctly from optional ones.

## Why trading is an isolable, REST-first-but-in-process-capable deployable (legal, not architectural)

Added 2026-09-07 (human-stated constraint); **refined the same day** — the first draft
overstated it as "in-process forbidden as a law." The accurate rule is below. Read it before
the M1/M2 section that follows.

**The constraint (why REST-first).** Payment providers commonly **restrict or deny trading
activity**. If trading code runs inside the agent/messaging platform's shipped deployable, it
puts the platform's payment rails (subscriptions, billing — the platform's actual revenue) at
risk of being restricted or cut off. To ring-fence that risk, **trading must be a
separately-deployable, isolable unit** — able to run as its own service (its own TLD, behind
the REST boundary [005](./005-consumer-boundary-contract.md)) so it can be fully separated
from the platform's payment surface. **Given today's legal posture, trading ships REST-only:
herobids consumes it out-of-process over REST and does NOT import `@traderton/*` into the
shipped platform process.**

**Why it is a DEPLOYMENT constraint, not an architectural law (the refinement).** The
requirement is *isolability/separate-deployability*, not "in-process is forbidden." Technically
herobids *can* import `@traderton/*` and drive it in-process — the ports compose (L1 proved
it). Both consumption paths are, and must remain, **first-class and supported**:
- **In-process library** (`createTradingRuntime` + direct calls) — used for dev/test/eval now,
  and the **shipped** path the moment the legal hurdle is cleared.
- **REST adapter (M2/005)** — a thin adapter over the same ports; the shipped path today.
**Support both; let DEPLOYMENT decide which ships.** The core stays importable; REST never
becomes the only door and never leaks HTTP/HMAC concerns into the core. A future agent must
NOT collapse this into "REST-only, delete the in-process path" — the in-process path is a
deliberately-preserved option (see the invariant below).

**Latency — why preserving the in-process option matters (analysis, 2026-09-07).** The
transport overhead *added around* the trading work (risk gate + planner + DB + venue call),
per `submit_decision`-class call, order-of-magnitude:
| Topology | Added overhead / call | dominated by |
|----------|----------------------|--------------|
| In-process library | ~0.001–0.05 ms | a function call (no serialize, no network) |
| REST, same machine (compose / loopback) | ~0.3–2 ms | JSON + HTTP framing + loopback + HMAC |
| REST, separate machine, same region/VPC | ~1–5 ms | + one LAN/VPC round-trip + TLS |
| REST, separate machine, own TLD, cross-region | ~20–150 ms+ | + WAN RTT (dominant) + DNS + TLS |
Load-bearing reading: **the expensive part is the far/cross-region hop, not "REST" itself**;
in-process→same-machine-REST is ~1–2 ms. For the agent/bot path this is **noise** — an LLM
already spent 1–30 s reasoning before the call, and Traderton's own execution loop (actor,
marks, reconciler) runs in-process *inside the traderton service* regardless of topology, so
REST is crossed only for intake + events, not per internal tick. So REST-first costs little on
today's paths; but if a future latency-sensitive need arises AND the legal hurdle is cleared,
plugging trading in-process removes the boundary overhead entirely — which is exactly why we
keep the in-process path alive.

**INVARIANT (do not break):** *the in-process library must always remain a first-class,
working consumption path; REST is an adapter over the same ports, never the only door.* This
preserves the deployment optionality (isolate-behind-REST today; plug-in-process later).

**Consequences (load-bearing for the roadmap):**
1. **M2/REST is the shipped boundary today** (F is required — it is how trading ships isolated
   for the current legal posture). It is *mandatory-for-shipping*, but it is an adapter over
   the in-process ports, not a replacement for them.
2. **M1 (in-process) is BOTH the assembly/verification milestone AND a permanently-supported
   consumption path** — only "not the shape herobids *ships* in today," not forbidden.
3. **L2 (differential) was SKIPPED** (2026-09-07) — see the L2 skip note in
   [024](./024-verification-and-consumption-roadmap.md) + 027-L2-differential-proposal (on branch `l2-differential`, not on this branch):
   the herobids ref only recorded **agent/LLM** decisions (no mechanical-bot corpus), so there
   is no faithful mechanical reference to diff Traderton (mechanical-only) against; the
   decision-layer parity L2 would test is already covered by the byte-verbatim `@traderton/strategy`
   split (+56 copied strategy parity tests) and the 83 copied risk-gate parity tests, and L1
   exercised the full execution path live. Manufacturing a mechanical corpus was judged high-cost /
   low-marginal-value over L3's eventual REST-boundary differential. Order (when L2 is done at
   all): L1 → L2 → F → L3, L2 before-F-or-skipped.
4. **The L3 REST differential remains mandatory at Step 16** (2026-09-24). A8/C5 suites and the
  24-hour cross-stack soak did not produce the promised side-by-side report or a representative load
  report. Skipping L2 did not waive L3e. Step 16 therefore uses read-only pre-removal Herobids oracle
  `1f6978d740d45e466cf4149617b8afc1c721e751` (the parent of package-removal commit
  `55c5375664bceb093444832b0145419d4d9ef684`) and must define identical inputs, normalization, and load
  profile before execution. Existing parity, boundary, A8/C5, and soak evidence remains supporting
  evidence only. This preserves the recorded parity/readiness policy; it does not authorize staging
  mutation or a merge.

## Why there is an interim "library consumer" milestone (M1) before the API (M2)

Added 2026-09-06, while resolving the Phase 8 (`apps/worker`) stop-gate.

> **CORRECTED 2026-09-07 — read the section above ("Why trading is an isolable,
> REST-first-but-in-process-capable deployable") first.** This section originally called M1 a
> "library consumer" milestone. Refined: the in-process library **remains a first-class,
> supported path**, but for the **current legal posture herobids SHIPS its consumption over
> REST (M2)**, not in-process. So "same ports, two adapters" and "defer authoring to M2" below
> still hold; only "herobids ships in-process at M1" is corrected to "herobids ships over REST;
> in-process stays a supported, non-shipped-today path (dev/test/eval, and a future option if
> the legal hurdle clears)."
> M1 remains exactly as valuable, but re-labelled: it is a **Traderton-internal in-process
> *assembly + verification* milestone** (the extraction proves itself in one process, driven
> by a test/verification harness — see L1 in [024](./024-verification-and-consumption-roadmap.md)),
> **not** a state herobids runs trading in. Everything below about "same ports, two adapters"
> and "defer authoring to M2" still holds; only "herobids consumes in-process at M1" is wrong —
> substitute "a verification harness drives the assembled library in-process at M1."

For a long time the docs described a single end state: "herobids becomes a consumer of
Traderton **over the boundary**" — i.e. HTTP/REST (005). That framing was load-bearing in a
way we hadn't named: it implied the *first* time herobids calls Traderton is over an HTTP
boundary. That is precisely what produced the Phase 8 stop-gate — the mechanical decision
intake core is copyable, but if the first driver must be the 005 HTTPS boundary, then the
driver is **authored** boundary infrastructure (auth/idempotency/deadline), not copied
trading logic. Under "defer all authoring to the end," authoring the boundary early is
exactly what we want to avoid.

Naming an **intermediate library state (M1)** dissolves the tension:

- **M1 — Library consumer.** herobids consumes Traderton **in-process** via dependency
  injection / hexagonal ports & adapters. The extracted `@traderton/*` packages *replace*
  herobids' in-process trading; herobids drives Traderton's intake core in-process, exactly
  as it drives its own trading today. herobids keeps owning what Traderton deliberately does
  not — the `connections`/`agents` grant layer, the agent message-broker drive, the per-agent
  `maxBots` key — and **injects those into Traderton's ports as values/callbacks at the call
  site.** No boundary code is authored. This is where the extraction proves itself.
- **M2 — API consumer.** The 005 REST boundary is added as a **second adapter over the same
  ports.** Its request/deadline/idempotency semantics are the HTTP expression of the M1 ports.
  MCP/skills wrap it later.

Why this is the right shape, not a convenience:

1. **It makes "defer authoring to the end" coherent.** All the authored pieces (per-owner
   `maxBots` enforcement, the REST layer) become **M2 work**, done after M1 lands and a
   holistic review — not sprinkled through the extraction.
2. **It is the honest expression of the ownership seam.** Decisions 10–13 already put
   grant/identity/billing outside Traderton. M1 says: in the interim, the owner of those
   concerns (herobids) supplies them through ports. Nothing is dropped; nothing is authored to
   fake ownership Traderton doesn't have.
3. **Same ports, two adapters** keeps M1 and M2 from diverging — the API is not a different
   core, it is a driver over the identical seams.

### The ports-carry-values invariant

A consumer may inject through a port only the **platform-owned values** Traderton does not own:
a resolved `venueAccountId`, grant/connection validity, the `maxBots` limit decision, an
authenticated `ownerId`/`actor`. A port must **never** let the consumer inject *trading
behaviour* — the risk gate, planner, executors, reconciliation, and fill/position accounting
are Traderton's and are not overridable through a seam. If a proposed port would carry trading
logic, the seam is mis-drawn; that is the copy-never-author law asserting itself at the
boundary. This invariant is what keeps the injected M1 seams (e.g. injected `venueAccountId`,
deferred `maxBots` decision) from quietly becoming a backdoor around copy-never-author.

### Worked consequences (Phase 8)

- The bot-startup connection→venueAccount resolution (`resolveBotStartupContext`) is a platform
  grant concern → deleted from Traderton (Intentional Divergence); the port takes an injected
  `venueAccountId`. herobids (the M1 consumer) resolves it and runs the connection-grant guards;
  Traderton runs only the venue-account guards it owns.
- `create_bot`/`start_bot` limit enforcement is `Deferred (required for cutover)`: not copied
  (platform-keyed), not authored at M1; herobids enforces its existing key in the interim; the
  per-`ownerId` enforcement is authored as M2 work. Cutover is gated on it, so Traderton never
  ships weaker than herobids-today.

## Why Phase 10 (infra) is a shared versioned module, not copy-and-delete

Settled 2026-09-07. Full decision + verified source facts: [docs/features/initial/features/012-shared-infra-module-decision.md](../archive/features/012-shared-infra-module-decision.md).

Every other phase moves trading code by copy-and-delete because herobids *stops* owning that code — trading
relocates to Traderton and herobids becomes a consumer. **Infra is the exception: herobids does not stop
owning infra.** Both herobids and Traderton must keep running on Hetzner/Nomad/cloud-init/deploy-scripts. A
naive "copy the trading slice of the infra and delete the rest" (what the original Phase 10 said) would create
**two divergent copies of the same infrastructure to maintain forever** — the opposite of the maintenance win
the extraction exists to produce.

So Phase 10 changes shape: herobids' proven infra is extracted into a **standalone, versioned Terraform
module library** — two composable modules, `app-host/hcloud` (control-plane substrate: VM, firewall, network,
TLS, cloud-init, deploy scripts) and `nomad-autoscaler/hcloud` (the agent-node pool + autoscaler) — consumed
via pinned git-ref `source`. Traderton consumes `app-host/hcloud` with `enable_nomad = false` (host only,
autoscaling-ready but not enabled, since Traderton is mechanical and runs no per-agent containers); herobids
consumes both. Each pins its own immutable version tag.

Load-bearing consequences for how agents work this phase:

- **The module-library extraction is authoring/refactoring, not copy-and-delete, and it is herobids-owned.**
  Parameterizing `app_name` (the ~232 `HEROBIDS_ENV` refs funnel through one `_ssh_opts.sh` seam), splitting
  the two modules, adding the `enable_nomad` flag and the single `user_data_override` seam — all of that is
  done *in herobids* by its owner (build/test/release), the same authority model as source-fixes. **A
  Traderton agent does not refactor herobids infra**; it consumes the released module and authors only
  Traderton's own operator config (tfvars/compose/env — always exempt from copy-never-author per decision 1).
- **It is timed to the M1 testing window, deliberately.** herobids is the only system with real agent load to
  exercise module B's autoscaler under production traffic, so it is module B's live test harness; Traderton
  validates module A (host boots, clones, composes-up, serves TLS). Building the reusable module properly in
  this window beats throwing away a temporary Traderton-only infra.
- **The same "is it generic or does it encode the first consumer's semantics?" boundary test we use for
  trading-vs-platform applies here** (doc 012 decision 9): the Nomad node-health publisher ships herobids'
  `ServerHealthSnapshot` schema, so it stays herobids-side (re-attached via the `user_data_override` seam),
  exactly as the browser-pool job and market-intelligence loops were ruled platform. And doc 012 decision 5's
  "a parameter with exactly one real value is a constant with extra steps" is the same anti-speculative-
  generality restraint used throughout — do not abstract beyond a memory-driven single-pool autoscaler.

This does not affect the M1 holistic review or Phase 9b; it is Phase 10 shape, recorded now so it is not lost.

## Why trading credentials are NOT mirrored into herobids (credential custody follows use)

Settled 2026-09-11 (human), during L3-P1b scoping. Extends decision 12 (credential
custody follows the venue caller → Traderton) and the soft-reference rule.

**The question.** herobids and Traderton each already have their OWN `user_credentials`
table (two physical tables in two databases — herobids' is `userId`-FK'd to `users`;
Traderton's is soft-`ownerId`). During L3-P1b scoping it looked like a "shared table
ownership" problem: the herobids `credentials.ts` DELETE operates on credentials of ANY
provider (trading AND non-trading), and its dependents check spans platform-owned
(`connections`, `agent_connections`) and trading-owned (`venue_accounts`, `bots`) rows.
Proposed idea: keep ALL credentials (incl. trading) in a usage-agnostic herobids table,
mirroring the trading ones for ease of reference.

**What the code actually shows (traced 2026-09-11).** Credential *use* splits cleanly
into two kinds:
- **Decrypt-and-use (custody — the legally-loaded use):** the only sites that decrypt a
  secret to plaintext are Gmail (`apps/worker/src/gmail-credential-resolver.ts` — a
  platform capability, legitimately in herobids) and the trading venue adapters
  (`venue-adapter-factory.ts`, which decrypts API/private keys to sign orders). That
  file is **already gone from herobids `consume-traderton`** and lives in Traderton —
  i.e. trading-credential custody has ALREADY moved behind the boundary.
- **Metadata-only (reference — legally harmless):** every OTHER herobids touch of
  `user_credentials` reads only non-secret columns or does lifecycle bookkeeping and
  NEVER decrypts — plan-limit counting (`plan-guards.ts`), link validation
  (`accounts.ts`/`connections.ts` read `{id, provider}`), the `credentials.ts` list/get
  (returns `id/provider/label/timestamps`, never `encryptedData`), delete, rotate, FKs.

**Decision.** Each side stores ONLY the credentials it actually uses; there is NO
trading-credential mirror in herobids.
- Trading credentials are Traderton-owned (custodied + decrypted behind the boundary).
- Non-trading credentials (Gmail/OAuth/social) stay entirely herobids-owned; Gmail token
  refresh is unaffected (it reads herobids' own table — correct, a platform concern).
- If a unified credential VIEW is ever needed (e.g. a UI list across both), COMPOSE it at
  read time (herobids' own credentials + a boundary read call) — a read-time composition,
  never a stored mirror.

**Why not the mirror.** A herobids reference-row for a trading credential (metadata only,
no `encryptedData`) would NOT break the legal rule (no secret material, no decrypt). But
it introduces a second writer of one fact → drift, plus a reconciliation burden, to save
provisioning-time/plan-check reads that are not on any hot path found. The extraction is
removing trading-shaped state from the platform, not adding a synced copy of it. A
metadata-only read-cache with an explicit reconciliation job remains a future option IF a
hot path that frequently lists/counts trading credentials is later found — declared as a
cache, never a second source of truth. None was found (touches are provisioning-time +
plan-checks, not per-request-hot).

**Consequence for L3-P1b.** The herobids `credentials.ts` route stays LOCAL and unchanged
— it correctly manages herobids' own credentials. Only the holistic TRADING path
re-points to the boundary (`setup.ts` → `provision_venue_account`; `provider-links.ts` +
`accounts.ts` deletes → `deprovision_venue_account`). See the parity-ledger cutover
obligation for migrating pre-existing trading-credential rows into Traderton at cutover.

## Q2 `score_candidate` re-point — decision + resolved unknowns (2026-09-11)

**Decision (Option A, human-ratified via the 008 process):** re-point herobids'
`preset-scorecard-runner.ts` from the in-process `scoreCandidate(candidate, scanConfig)` to the
boundary `score_candidate` tool. Make the runner + its assessor caller async; STOP feeding local
candles to scoring; call the boundary with IDENTIFIERS; reconstruct `scanHealth` from the boundary
result's `candlesEvaluated` (signal→healthy; null&count>0→no_signal; null&count===0→stale); map
`failure`/`transport_error` to a propagated Result error (NOT to a synthesized `stale` — that would
degrade parity by conflating infra failure with market staleness). No traderton-side change for the
happy path (`candlesEvaluated` already exists in the result). Decision made by the `Contemplator`
decision agent from a neutral brief; the agent corrected a false premise in the brief (candles are an
evidence-collection byproduct, not a scoring fetch). Parity-touching → human ratified.

**Parity impact (→ [001](./001-parity-ledger.md), Intentional-divergence):** `scanHealth='stale'` now
reflects the BOUNDARY's fetched candle count, not herobids' evidence-candle count. Accepted as an
improvement (source of truth = the candles actually scored). **Separate Deferred (out of scope for this
slice):** `collectEvidence` still fetches candles in-process — a distinct market-data coupling to be cut
by the `check_regime`/evidence-ports work.

**Resolved unknowns (traced in `packages/domain/src/market-assessment.ts`):** `MarketAssessmentIdentity`
is a discriminated union — orderbook/perp carry `symbol` (venue-canonical) + `venueFamily`; swap/dex
carry `network` + `address` (canonical TOKEN address).
- **Orderbook `providerSymbol`:** the old path passed `identity.symbol` directly as the candidate symbol,
  so mapping `providerSymbol = identity.symbol` reproduces the old scored behaviour by construction
  (parity holds — same symbol the old scan used). Clean thin seam; no resolver.
- **Swap `poolAddress` — a REAL GAP (new sub-decision, route via 008).** The boundary REQUIRES a DEX
  `poolAddress` for swap (errors without it), but the identity carries only a TOKEN `address`, and the
  OLD in-process path never resolved a pool — it sidestepped this by passing pre-fetched candles +
  `venueType: undefined`. So swap scoring CANNOT be reproduced over the boundary from identity alone.
  Consequence for the slice: **orderbook/perp scoring re-points cleanly now; swap/dex scoring is a
  separate decision** — where does token→pool resolution live (herobids seam? boundary accepts a token
  and resolves pool-side?), and is that resolution trading-adjacent? To be briefed + routed via 008
  before swap scoring is re-pointed. The score_candidate slice covers orderbook/perp; swap is Deferred
  (required for cutover) with this reason.

## Q2 regime re-point — telemetry re-source + a parity hole fix (2026-09-11, 008-routed)

**Decision (decision agent; parity/contract-touching → pending human ratification):** to re-point
herobids' regime telemetry over the boundary WITHOUT degrading it, make two minimal changes:

1. **`check_regime` success result gains a `freshness` block** — `{ provider, source:'upstream'|'cache',
   ageMs, isStale }` — copied from the provider result's existing `meta.freshness` (which traderton's
   `candle-registry.ts` currently DISCARDS). herobids records provider-success + freshness-mode from it.
2. **Make `rate_limit.exceeded` reachable across the boundary for regime.** Parity hole the agent found:
   `check_regime`'s rate-limit branch sets `retryable:true`, and `dispatcher.ts mapToolResult` maps ANY
   `retryable===true` → `upstream.transient` BEFORE any rate-limit check — so herobids could not tell a
   throttle from a generic failure, silently degrading its `recordRateLimitThrottle` vs
   `recordProviderFailure` split. Fix: `check_regime` sets `errorCode:'rate_limit'` on throttle; add a
   rate-limit branch to `mapToolResult` (keyed on the tool's errorCode) BEFORE the retryable branch →
   `rate_limit.exceeded` (existing closed-union member; no new surface).

**herobids maps telemetry from the TradertonClientResult union** (no local throw anymore): success →
recordProviderSuccess + recordFreshnessMode(source==='upstream'?'fresh':'cached') + snapshot fresh;
failure code `rate_limit.exceeded` → recordRateLimitThrottle + snapshot unavailable; any other failure OR
transport_error → recordProviderFailure + snapshot unavailable; in_progress → record nothing. BOTH regime
call sites (`coordinator.ts refreshRegime` + `evidence-adapters.ts`) apply the identical mapping.

**Ownership call (resolved, not escalated):** the seam that stops `candle-registry.ts` discarding `.meta`
is authored in TRADERTON — it cuts a platform coupling (discarded freshness), not trading behaviour;
copy-never-author permits thin-seam authoring for cutting couplings, and the values are copied from the
existing `ProviderResult.meta.freshness`. Logged in [003](./003-anomalies-and-deviations.md).

**Parity:** preserved exactly (Met), not degraded. The rate-limit-distinction fix actually RESTORES a
parity split that was latently broken for any future regime consumer. Pending human ratification (parity +
005-contract-visible).

## Q2 batch — herobids-side re-point decisions (2026-09-11, 008-routed, human-confirmed)

**Q1 regime scope → A (re-point regime ONLY now).** herobids `coordinator.ts refreshRegime` +
`evidence-adapters.ts` re-point to `check_regime`; telemetry re-sourced from the tool's `freshness`
block + `rate_limit.exceeded` code (parity). The coordinator's OTHER in-process market-data loop
(`providerRegistry.discovery.discover`) is NOT touched — so this does NOT clear `@herobids/market-data`;
discovery is a separate larger slice (the Traderton `discover_tokens` tool is a single-network point
query and does NOT carry the coordinator's multi-network snapshot/stale-state surface — re-pointing
discovery needs new snapshot-parity boundary surface). Regime-alone is a safe incremental step (regime +
discovery loops are independent). `check_regime` is `read-market-data` (resolver short-circuits — no owner
scoping needed); the coordinator gets a boundary client from the worker composition root (index.ts already
constructs `createTradertonClient`) with a SYSTEM subject (`actor.type:'system'`, e.g. id 'market-intel').

**Q2 agent-tool write path → A (`tradertonWriteBoundary?` on ToolContext).** Add a second optional,
subject-bound side-effecting boundary port to `TradingToolContext` (subject bound at the agent-container
composition root, mirroring the read adapter — a subject-less `invokeAndAwait({toolName,payload,deadlineMs})`).
Keeps the deliberate read/write adapter split (reads poll-never + domain-clean result; writes idempotent/
deadline-bound + raw union). `adjust_risk_limits` routes through it; it is `ownerScopedNoVenue` so
ownerId+actor suffices. Reject B (widen the read boundary — leaks write affordances into reads) and C
(route via decision-handler — over-couples to submit_decision plumbing).

**adjust_risk_limits boundary-absent → (a) HARD-FAIL `precondition.not_ready`, no in-process fallback
(human-confirmed).** Forced by the existing L3c "Fallback posture" (side-effecting writes fail closed when
the boundary is absent; do NOT fall back to in-process) + the unanimous write precedent (submit_decision,
bot lifecycle, executeApproval all fail closed). Reads keep their direct-DB fallback (transitional); writes
fail closed — `adjust_risk_limits` is on the write side. `ctx.riskContractOps` STAYS (the read
`get_risk_limits` still uses it); only the WRITE path (`adjustOverrides`) re-points. Implication accepted:
with no boundary, risk-limit adjustment is inert (same as submit_decision today) — capability relocated
behind the boundary, not dropped (system-level parity). Swap scoring + discovery + get_risk_limits-read
re-point remain separate slices.

## T2 swap score_candidate — decided approach (B) + deferred build (2026-09-11, 008-routed)

**Decision (decision agent): Option B** — `score_candidate` should accept a swap TOKEN
(`network + address`) and resolve the pool BEHIND the boundary (reusing Traderton's
`swap-candidate-discovery` selection + `geckoterminal.fetchPoolOhlcv`), so herobids passes the
identity it already has and does NO pool resolution / candle fetch. Rejected A (carry poolAddress —
entrenches herobids' in-process discovery as the pool source) and C (status quo).

**Grounded finding that changes urgency (verified in code):** the herobids swap-scoring path is
**effectively INERT today, and does NOT fetch swap candles in-process.** `evidence-adapters.ts`
`identityToScannerTarget` returns `null` for swap → the evidence candle port ERRORS for swap
("Candle evidence not supported") → `extractCandlesFromSnapshot` yields EMPTY candles for swap →
`scoreSwapInProcess` scores empty candles (no fetch of its own) → typically no signal → 'stale'/
'no_signal'. Also confirmed `scan-engine.ts` only CARRIES `venueType` onto the output, it does NOT
branch scoring on it (so 'swap' vs undefined does not change the score — no parity break there).

**Consequence:** T2 is NOT an urgent legal-isolation fix (no live in-process swap market-data fetch
on this path — the earlier `scanner-candle-fetcher` concern is about a fetcher this path doesn't invoke
for swap). Re-pointing swap to the boundary would make swap scoring ACTUALLY functional (real pool
candles) — a parity IMPROVEMENT, not a like-for-like move. Because it requires non-trivial Traderton
AUTHORING (extend `score_candidate` to accept a token + resolve pool behind the boundary) and its value
is enhancement not isolation, its BUILD is **Deferred as its own slice** (approach B is decided; not
urgent). Recorded so it is not lost. Coordinator sequencing call (not a parity/legal risk — deferring
changes nothing live).

## B2 investigation — agent.ts live market-data couplings (2026-09-12, terrain map)

Investigation (delegated) found B2 is larger than "a handful of agent.ts couplings" — it is a
multi-decision track. Six live in-process market-data couplings in `apps/worker/src/agent.ts`
(4022 lines): (1) regime eval tick-gate 2733-2740 → COVERED by `check_regime`; (2) volatility
candles 2743-2746 (binance.candles BTC 24x1h → ATR/adaptive interval) → GAP, no candle-series tool;
(3) hybrid sizing 3072-3084 → `priceService.resolvePriceTarget` (NOT getPrice) → get_price contract
MISMATCH (resolvePriceTarget resolves chain/address + returns resolvedChain/resolvedAddress); (4)
venue-intelligence refreshVenueIntelligence 1058-1230 (assetContexts/longShortRatio/discover/dexscreener)
→ maps to get_funding_rates/get_market_overview/discover_tokens/search_tokens but field-shape parity
unverified + bybit longShortRatio possibly a partial gap; (5) construction createProviderRegistry+
createPriceService 913-927; (6) NEW: economic calendar CompositeEconomicCalendarProvider 934-968 (cache-read
only) — no boundary tool.
**Separate BLOCKING surface:** the agent-container READ TOOLS consume ctx.marketDataRegistry/priceService
directly (tools/price.ts, tools/market-data.ts, tools/watch.ts) → removing createProviderRegistry from the
container is BLOCKED by those tools = a separate re-pointing slice.
**5 decisions to route (008):** volatility-candle gap (new surface vs extend check_regime w/ ATR vs
static-fallback); hybrid get_price-vs-resolvePriceTarget contract; venue-intel field-shape coverage;
whether registry removal / read-tool re-pointing is in B2 scope; economic-calendar scope.
Consequence: B2 = a track (several slices), not one slice. Surfaced to human for scope steer before routing
all 5 + building.

## B2 — four coupling decisions (2026-09-12, 008-routed; parity-touching → pending ratification)

The decision agent corrected two wrong premises in the brief (get_price shares resolvePriceTarget's
signature; bybit longShortRatio is ALREADY behind the boundary via get_market_overview). Outcomes:

- **Q-A volatility candles → DEFER (A4).** The in-process `binance.candles('BTC',1h,24)` → `calculateAtrPercent`
  → adaptive tick interval rides the SAME `marketDataRegistry` B2 defers. Moving it now needs new candle/ATR
  boundary surface for a coupling already agreed to persist until the read-tools slice → fails minimal-surface.
  Eventual surface (at the read-tools slice): a `get_volatility` tool returning `{volatilityPct, freshness}`
  (value, not candles — keeps ATR source-side per ports-carry-values). Deferred, no new surface now.
- **Q-B hybrid sizing → DEFER (B3).** Depends on `priceService` (stays until the read-tools slice). Re-pointing
  to today's `get_price` would DROP `resolvedChain/resolvedAddress` from the submitted-decision metadata (silent
  degrade) — rejected. Eventual: extend the boundary price contract (or add `resolve_price_target`) to return the
  resolved identity + {priceUsd,source,fetchedAt,stale}. Deferred with priceService/read-tools slice.
- **Q-C venue-intelligence → LAND NOW (C1).** Re-point each read to its EXISTING tool (reads already have boundary
  tools, independent of registry removal): hyperliquid.assetContexts + bybit.longShortRatio → `get_market_overview`
  (venue bybit); discovery.discover → `discover_tokens`; dexscreener.search → `search_tokens`. Compose the LLM signal
  herobids-side from boundary values (presentation stays herobids; rejected an aggregated tool = authoring on the
  seam). **Parity carve-out:** `get_market_overview` projection LACKS `markOracleSpreadPct` which herobids surfaces
  to the LLM ("Mark/oracle spread"). Resolution (coordinator, copy-faithful/not four-risk): ADD `markOracleSpreadPct`
  to the traderton `get_market_overview` projection (the source `HyperliquidAssetContext` already has it) — restores
  parity, no field dropped. Also verify search_tokens/discover_tokens field-shape parity before re-point.
- **~~Q-D economic calendar → RECLASSIFY AS PLATFORM (D2).~~ RETRACTED — see the 2026-09-12 human ruling below.**
  ~~Macro/economic data (not venue/trading market-data), zero traderton presence, and the tick read is
  `getUpcomingEvents({cacheOnly:true})` — a cache-only read of herobids-owned Redis (a herobids loop populates it).
  NOT a trading-boundary coupling. Stays in herobids; recorded as explicitly-platform (NOT a Gap).~~
  **This classification was WRONG.** It tested "where the data comes from" (macro/forex source, cache transport)
  instead of "does a trading decision consume it." The economic calendar IS trading-adjacent (see the human ruling).

**B2-now = Q-C only** (+ regime, the known coordinator pattern). A/B deferred to the read-tools slice; D out.


## 2026-09-12 — Market-intelligence boundary registry gap + DEX top-pick (routed via 008; decision agent = Contemplator)

**Trigger:** reviewing the B2 venue-intelligence re-point before commit, the DEX top-pick selection appeared to diverge between the in-process path (highest-liquidity ≥$10k) and the boundary `search_tokens` path — a parity/behaviour-change four-risk. Routed a neutral §2 brief.

**The decision agent corrected a MATERIAL false premise** (the value of the 008 process, again): the divergence I framed is moot in production because the boundary tools return `market_data_not_configured` — the boundary context factory (`bin.ts`) never wires `marketDataRegistry`. Verified by the coordinator: the only place `marketDataRegistry` is set on a tool context is the unit tests; no prod/dev bootstrap wires it; `check_regime` uses `ctx.marketDataRegistry!` (NOT the wired `scannerCandleFetcher`).

**Ruling:**
- **D1 (rule-forced, settled):** record the capability gap — the four market-intel read tools are inert over the boundary until the registry is wired. Recorded in 003 + 001. Wiring is the prerequisite work item (feasible: `appConfig.marketData` present; `createProviderRegistry` is the established path in `create-trading-runtime.ts`). Parity-touching → pending ratification; merge gate.
- **D2 (parity-touching, pending ratification):** once wired, adopt Option A — accept Traderton's safety-aware `search_tokens` ranking as the DEX top-pick (Intentional-divergence). herobids keeps its network filter + `[0]`, does NOT re-author a liquidity floor/sort (Option B rejected = re-homes market-data policy in herobids, violates the top rule). Option C rejected = rule-unviable (ranking is always safety-score desc; no param yields liquidity-desc). Justification: the DEX venue-intel signal is display-only (LLM prompt context; no execution/sizing/risk path consumes it), so a safety-first pick is an improvement, not a degrade. If the $10k floor must persist, pass `minLiquidityUsd:10000` (a filter) — ordering stays Traderton's.
- Also resolved by the agent: `discover_tokens` list ordering does not affect the discovery-metadata join (by network:address into a Map, order-independent).


## 2026-09-12 — Swap score_candidate token→pool RESOLVER mechanism (008-routed; decision agent = Contemplator) — CORRECTS the T2/Q2 ratified primitive

**Trigger:** building the deferred swap arm of score_candidate (ratified Option B: token in → pool resolved behind the boundary). Investigating the named primitive (`swap-candidate-discovery`) revealed it is the WRONG fit for a point lookup — routed the resolver-mechanism question.

**Decision agent corrected TWO false premises (both verified in-repo):**
1. `discoverSwapScannerCandidates` (swap-candidate-discovery.ts) is a SET DISCOVERY function (`discover({networks,maxResults,minLiquidityUsd})` → trending list → filter/rank/cap). It does NOT resolve a specific token address → its pool. Using it for a point lookup would fail for arbitrary held tokens → swap scoring degrades to 'stale'/no-signal → violates no-degrade.
2. The DexScreener search family in THIS repo does not surface a pool/pair address — `mapPairToTokenInfo` drops it and `TokenInfo` has no poolAddress field. The atomic `pool` object (poolAddress + base/quote) is produced ONLY by GeckoTerminal (`mapPoolsToTokens`). So "reuse the live search primitive" was illusory.

**Ruling (mechanism):** resolve a known swap TOKEN (network + token address) → pool via a NEW thin GeckoTerminal token-pools wrapper behind the boundary (`/networks/{network}/tokens/{address}/pools`), reusing the existing `mapPoolResource`/`mapPoolsToTokens` mappers + `buildGeckoUrl`/`buildGeckoHeaders`/`fetchJson`. Select the highest-liquidity pool (tie-break volume24hUsd desc, then poolAddress lexicographic; network filter case-insensitive) — matching the liquidity-ranked canonical-pool heuristic already used by merge/discovery. Then fetch candles via the existing `scannerCandleFetcher` (guaranteed GeckoTerminal-fetchable since same provider) and score. Loosen `score_candidate`'s `buildTarget()` so venueType:'swap' accepts `network + tokenAddress` (poolAddress becomes optional / resolved).
- Rejected B-literal (wrong primitive → degrade); rejected A (DexScreener carries no pool address here + cross-provider candle-fetchability risk).

**Copy-never-author check:** the pool-SELECTION behaviour (liquidity-ranked canonical pool) is copied from existing discovery selection; only a thin HTTP wrapper (new seam behind the boundary) + a param-guard loosening are authored. Consumer is display/assessment (preset scorecard → scanHealth), not execution, and the current in-process swap path is effectively inert (empty candles) — so real pool candles are a strict IMPROVEMENT, no specific-pool parity obligation.

**Classification: parity/legal-touching → PENDING HUMAN RATIFICATION.** It revises the LETTER of the human-ratified T2/Q2 decision (named primitive swap-candidate-discovery → GeckoTerminal point resolver); the DIRECTION (token in → pool behind the boundary) stays ratified. Two open questions for the ratification pass: (1) quote-asset constraint on the resolved pool — default taken: highest-liquidity, NO quote constraint (behaviour-affecting; confirm); (2) GeckoTerminal Pro-tier availability of the tokens/{address}/pools endpoint (operational; verify at e2e/config).


## 2026-09-12 — Economic calendar IS trading-adjacent (HUMAN RULING — FINAL, legal-based)

**Ruling (human, final):** the economic calendar is **trading-adjacent**. This is a legal-based
determination and is FINAL — it supersedes and RETRACTS the earlier Q-D "reclassify as platform / not a
Gap" call.

**Grounded facts that support it (verified in code):**
- The `macro-economic` context block (`herobids/apps/worker/src/runtime-composition.ts` ~1240) is
  `requiredFamilies: ['trading']` — it renders ONLY for trading agents.
- Its data (`runtimeState.metrics.macroEvents`, set in `agent.ts` ~3453 from
  `getUpcomingEvents({cacheOnly:true})`) is injected into the agent's DECISION prompt as
  "Upcoming Economic Events" (impact/forecast/previous) — market context the trading agent reasons over.
- The `EconomicCalendarProvider` port lives in the domain market-data ports layer
  (`packages/domain/src/ports/economic-calendar.ts`), alongside candle-fetcher.
- Under our own definition (AGENTS.md "Data": price, P&L, **market context** — always provided; the agent
  reasons over it), trading-gated market context consumed by a trading decision IS trading-adjacent. The
  source being macro/forex and the transport being a cache-only Redis read do NOT make it platform.

**Why the earlier ruling was wrong (recorded so the failure mode isn't repeated):** it conflated
data-provenance/transport with consumption. The correct test for trading-adjacency is "does a trading
decision consume it," not "where does the data originate." (This is the same drop/defer-leaning judgment
weakness 008 exists to catch — noted.)

**Consequence for the ledger:** economic calendar is NO LONGER "explicitly-platform / not-a-coupling." It
is a **trading-adjacent coupling** and therefore a cutover obligation: the acquisition (the ForexFactory/
Scrapfly scrape loop + parser + the `CompositeEconomicCalendarProvider`) and the read must move behind the
Traderton boundary so no trading market-context acquisition runs in the herobids process. Recorded in
001-parity-ledger as **Deferred (required for cutover)** — its own slice. The exact boundary shape
(acquisition-behind-boundary + a read tool, e.g. `get_economic_calendar`, vs. a boundary-populated cache
the consumer reads) is a build-time design for that slice; the classification (trading-adjacent, must not
stay a herobids-owned in-process coupling) is settled by this ruling.


## 2026-09-12 — Bot-consumer contract (008-routed; decision agent) — SETTLED rulings + human residue

Routed the §009 brief to a fresh decision agent. It VERIFIED all load-bearing facts (agent-scoped read tools + no `getBotsByOwner` repo method at TWO layers; boundary serves read-database; fills/journal Traderton-owned; create_bot dryRun schema-only; create_bot payload carries NO id) and tightened the brief (two items I'd over-escalated are actually rule-forced).

**SETTLED (rule-forced) — recorded here + 001:**
1. **Bot reads target = OVER THE BOUNDARY (1b). Local read-model (1a) UNACCEPTABLE.** Invariant 1 — a durable local bots/fills/journal projection re-homes trading-state authority in herobids. 1b tracked Deferred-required-for-cutover, gated on ruling 4.
2. **`POST /bots` = 202 Accepted, id-later, no local row. Polling (2b) REJECTED.** The boundary create payload carries no id and writes no local row; 201+id would require a fabricated id or a local write (invariant 1). Honest 202 = preservation-of-correctness; consistent with start/stop (already 202). Polling re-adds the tick-liveness coupling the async decision removed (invariant 7).
3. **Capability validation = async-by-default; the herobids local pre-check STAYS removed (3-local UNACCEPTABLE).** Re-adding it reverses settled decision #4 + re-homes a trading-config rule (invariant 1). The lost synchronous paper+swap 400 MUST be ledgered as Intentional-divergence/Gap (invariant 7) regardless of human item B.
4. **The owner-scoped Traderton read surface is a HARD, TOTAL prerequisite for 1b, built as a COPY/ADAPT (re-key existing `getBotsByCreator`-family queries agent→owner over the soft `ownerId` column, decision 13), NOT authored.** Permitted thin seam (invariant 1); precedent = L3-P1 `provision_venue_account`. Proceeds as an `l3-integration` slice under the autonomy contract — NO human sign-off before starting. New read-tool surface recorded in 005 when built.
5. **Interim posture = herobids local bot read endpoints STAY on the local mirror until 1b lands; do NOT 503/disable them.** Disabling working endpoints mid-migration is a feature-drop (invariant 7 / 008 §1). The interim mirror is the pre-existing trading DB (L3d deletes it later), not a new durable authority. Transitional staleness for boundary-created bots (no local row) logged in 001 as a Gap closing on 1b.

**FOR THE HUMAN (product/policy) — 3 genuine calls, recommended defaults:**
- **A. 202 create-response correlation shape.** Default: keep `{ok, note}` + ADD a structured `requestId`/correlation token so a client can locate the bot via the (forthcoming owner-scoped) read without polling. (id-later itself is forced; only the token detail is a call.)
- **B. Accept the lost synchronous paper+swap 400 (async-only) vs fund a sync `preview_bot_capability` boundary tool.** Default: accept async-only now, ledger as Intentional-divergence; the sync-preview tool (validation COPIED from `validateExecutionCapability`) is a clean later-option → 010 backlog.
- **C. Owner read-scoping semantics.** Default: owner view = ALL bots whose `ownerId` matches, regardless of `creatorType` (owner = tenancy boundary, decision 10). If product wants agent-created bots hidden from a user's list, that's a genuine segregation decision. Confirm in the ratification batch; slice builds on the default (008 §6.3), cheap veto.


## 2026-09-12 — CORRECTION to the bot-consumer contract rulings (false premise found; A + B RE-OPENED)

The 2026-09-12 "Bot-consumer contract" rulings for `POST /bots` (ruling 2: 202/id-later) and capability validation (ruling 3: async) rested on a **FALSE PREMISE** — that Traderton's `create_bot` writes the bot row asynchronously "on the next tick." Verified in code, that is WRONG:

- **The bot row is written SYNCHRONOUSLY** during the `create_bot` boundary call. `create_bot` (`packages/worker/src/tools/bots.ts`) does `await ctx.publishToInbound('MANAGE_BOT', {create_and_start})`; in the boundary composition `publishToInbound` is the IN-PROCESS `createDriveTarget` (`packages/worker/src/composition/drive-target.ts`), whose `createAndStart` runs `await deps.botLimit.tryCreateBotWithLimit(...)` — an atomic count+insert that PERSISTS the row and returns `{created, botId}` — then enqueues the START job. **Only the actor START is deferred**, not the row.
- **`create_bot` DISCARDS the synchronously-available id**: `createAndStart` returns `void`; the tool returns a hardcoded `{ok, note:'…next tick'}`. The "next tick" note is MISLEADING — only the start is deferred.
- **Config + mode validation are SYNCHRONOUS** (`BotConfigSchema.safeParse` + `checkModeEscalation` throw before persist).
- **The paper+swap capability check (`validateExecutionCapability`) is NOT WIRED into the live boundary create path at all** — it exists only in `packages/worker/src/_deferred-authoring/api-routes/` (quarantined, excluded from build/tests). So over the boundary today paper+swap is neither a sync 400 nor an async rejection — it is an ABSENT check (a parity GAP vs herobids, which validated it synchronously).

**Consequence:**
- **Ruling 2 (202/id-later) is RETRACTED.** A synchronous **201 + id** IS achievable without polling or re-coupling — the `botId` is already produced synchronously and merely dropped. The question re-opens as: plumb the id through `create_bot`'s return (→ herobids 201+id, parity-preserving) vs keep the void/202 fire-and-forget shape. Contract + copy-vs-author call → RE-ROUTE.
- **Ruling 3 (async capability) is RETRACTED / re-framed.** paper+swap is currently a GAP in the live path, not "async." Restoring parity = wire `validateExecutionCapability` into `createAndStart` (un-quarantine copied logic; copy/adapt, not authoring), which would make it a SYNCHRONOUS rejection again. Question: restore it (sync) vs leave the gap. Parity-restoration + copy-vs-author call → RE-ROUTE.
- **Ruling 1 (reads over boundary), 4 (owner-scoped read surface — BUILT), 5 (interim keep local reads) STAND** — unaffected by this premise.
- **C (owner read view) STANDS** with the human's refinement: owner sees all bots by `ownerId`, STRUCTURED so creator (`creatorType`/`creatorId`) is visible.

A + B re-routed to the decision agent with these corrected facts (next). Nothing was committed on the wrong premise beyond docs; the owner-scoped read slice (ruling 4) is correct and unaffected.


## 2026-09-12 — Bot-consumer contract: HUMAN RATIFICATION (A/B/C final)

The human ratified the corrected bot-consumer contract. All flags cleared; these are the FINAL settled positions for the bot re-point slice:

- **A1 (RATIFIED): `POST /bots` returns 201 + botId.** Plumb `{ok, botId}` through `createAndStart` → `create_bot`'s return (the id is synchronously available from `tryCreateBotWithLimit`); herobids returns 201 + id (parity with the pre-migration contract). Correct the misleading "next tick" note (only the actor START is deferred; the row + id are synchronous). Supersedes the retracted 202/id-later ruling.
- **B1 (RATIFIED): wire `validateExecutionCapability` into the live `createAndStart` path** (un-quarantine the copied `@traderton/domain` check; copy/adapt) so paper+swap is rejected SYNCHRONOUSLY → boundary failure → herobids 400. Restores the pre-migration parity gap. **Error-code (human choice): a DEDICATED capability code** (e.g. `execution_capability.paper_swap_not_supported` mapped to 400), preserving the pre-migration error identity/message — NOT the generic `validation.invalid_payload`. Supersedes the retracted async ruling.
- **C (RATIFIED, refined): owner read view = ALL bots whose `ownerId` matches, STRUCTURED so creator is visible** — surface `creatorType`/`creatorId` in the owner-scoped read payloads (`list_owner_bots`/`get_owner_bot_status`) so a user can tell "I made this" from "an agent made this for me." This is an intentional ADDITIVE divergence from the agent-scoped `list_bots`/`get_bot_status` shape (which omit creator) — logged as such, not a byte-parity match.

Rulings 1 (reads over boundary), 4 (owner-scoped read surface — built), 5 (interim keep local reads) stand. The bot re-point slice proceeds on these.


## 2026-09-12 — Wave A1: bot deletion over the boundary (008-routed; decision agent)

Pivotal verified fact: **NO FK points to `bots`** (fills/orders/positions/journal are actor-scoped by string `actorId`; `token_safety_overrides.botId` is a soft nullable text ref). So a hard bot-row delete orphans nothing and the forensic trail survives — hard-delete is safe AND copy-faithful (herobids' pre-migration DELETE was a hard row delete; no archival concept exists → soft-delete would be authoring).

**SETTLED (rule-forced):**
- **S1:** a `delete_bot` boundary tool MUST exist (leaving the Traderton-owned bot orphaned on a herobids-local delete is a silent divergence). 
- **S2:** `delete_bot` mirrors the `deprovision_venue_account` shape — `ownerScopedNoVenue`, `write-database`, owner-scoped existence via `getBotByIdForOwner` (→ `not_found.resource`), db/owner-unavailable → `fault:true`, hard-delete the row in a tx, metadata-only success `{botId, deleted:true}`.
- **S3:** refuse to delete a `running` bot (copied herobids 409 "stop it first") — a STATUS guard on the bot's own status (NOT deprovision's any-referencing-bot guard); dedicated errorCode mapped to 409.
- **S4:** herobids DELETE routes over `delete_bot` as authoritative, fail-closed (503 when boundary absent) — same posture as create/stop/start. Reject H-b (local-authoritative) + H-c (skip local mirror).
- **S5:** interim local-mirror delete stays but runs **boundary-first** (invoke delete_bot; only on success delete the local row, owner-scoped). Prevents split-brain/orphan. The local delete line is removed at D1 with the table.

**FOR THE HUMAN (pending ratification, safe default — proceeding per 008 §8.2):**
- **H-1:** confirm hard-delete is the intended terminal semantics (no forensic-retention policy requiring bot-config rows to persist). Default (proceeding): hard-delete — copy-faithful; forensic trail is FK-independent and survives. Retention, if ever wanted, is a POST-migration 010 item (would author new behaviour; must not ride this wave).


## 2026-09-12 — Wave A2: owner-scoped bot read-wave SHAPE (008-routed; decision agent)

The 5 herobids bot-detail read endpoints (costs/sessions/events/journal/journal-summary) read Traderton-owned `fills`/`journalEvents` LOCALLY. Verified: their handler bodies are BYTE-IDENTICAL to the quarantined Traderton copy (`_deferred-authoring/api-routes/bots.ts`) — so this is un-quarantine, not authoring. `get_analytics` does NOT subsume them (agent-scoped, time-windowed, different shape) — brief premise corrected.

**SETTLED (rule-forced on the core axis): S-C hybrid.**
- **S-B (herobids re-aggregates) is RULE-UNACCEPTABLE** — re-homes trading aggregation (fee-grouping, session-pairing, summary) into herobids = legal-isolation + copy-never-author violation. Aggregation MUST execute in Traderton.
- **3 dedicated owner-scoped AGGREGATION tools** (un-quarantine + adapt agent→owner, reusing the identical copied bodies): `get_owner_bot_costs` → `{botId, feesByCurrency}`; `get_owner_bot_sessions` → `{botId, sessions, limit, offset}` (pairing server-side); `get_owner_bot_journal_summary` → `{botId, tradeCount, feesByCurrency}` (verify exact summary shape).
- **1 owner-scoped RAW journal-read tool** `get_owner_bot_journal({botId, type?, limit, offset?})` → `{events}` serving BOTH `/journal` and `/events` (events = filtered read, NOT aggregation → no herobids-side logic). herobids passes results through verbatim.
- Every tool follows the landed `get_owner_bot_status` shape: resolve via `getBotByIdForOwner(botId, ctx.ownerId)` → `not_found.resource` (fault:false) if absent/unowned → compute/return. category read-database. Ownership gate preserved (replaces the local `bots` where(id,userId)).
- **All 5 endpoints / 4 tools are cutover-blocking as a SET** — each reads a local trading table; leaving any local blocks dropping the tables at D1.
- herobids endpoints keep the boundary-first + local-fallback posture (consistent with the delete/get routes); local reads removed at D1.

**FOR THE HUMAN (pending ratification, safe default — proceeding per §8.2):** tool granularity for the 2 pass-through reads — default = ONE shared `get_owner_bot_journal` (4 tools total); could split events/journal 1:1 (5 tools). Naming/ergonomics only, no rule impact.


## 2026-09-12 — H-1 RESOLVED by parity (no ratification needed)

Verified against herobids `main` (pre-migration production): the original `DELETE /bots/:id` handler does `await db.delete(bots).where(eq(bots.id, id))` — a HARD row delete. Searched every historical revision of `bots.ts` across all branches: ZERO soft-delete/`deletedAt`/archival/`status='deleted'` markers, ever.

So Traderton's `delete_bot` hard-delete is **copy-faithful** — it reproduces exactly what herobids did. It HONOURS copy-never-author; it does not violate/contradict/undermine anything. The earlier decision-agent escalation of H-1 as a "product call (retain config for audit?)" was an OVER-ESCALATION: retention is a capability herobids never had, so adding it would be authoring a new feature (forbidden mid-migration), and NOT adding it is not a degrade — it's parity.

**H-1 is SETTLED by parity — NOT pending ratification.** The standing ratification queue is now EMPTY. (Lesson: the ratification test is "does it go AGAINST a rule?", not "does it touch deletion semantics?" — a copy-faithful behaviour needs no sign-off even when the topic sounds consequential.)


## 2026-09-12 — Wave B1: hybrid-sizing price re-point (008-routed; §9 gate = SETTLED BY PARITY, no ratification)

herobids `resolveHybridTargetSize` (hybrid-decision-sizing.ts) uses `priceService.resolvePriceTarget` and flows `resolvedChain`/`resolvedAddress`/`resolvedSymbol`/`source` into go_long decision metadata (agent.ts ~3320). The boundary `get_price` tool calls `getPrice` and does NOT surface the resolved identity → re-pointing to it would DROP those fields (feature-drop). Traderton's context priceService already exposes `resolvePriceTarget` — so a boundary tool surfacing it is copy-faithful.

**§9 gate:** step 1 parity — preserving the resolved shape REPRODUCES herobids → settled by parity; step 2 — the copy-faithful option violates nothing.

**RULING (rule-forced, P-A): add a distinct boundary read tool `resolve_price_target`** (thin wrapper over `ctx.priceService.resolvePriceTarget`; shape `{ok, symbol, chain, address, name, priceUsd, source, fetchedAt, stale}`, mirroring get_price's structure). Re-point B1 `resolveHybridTargetSize` to it.
- Rejected P-B (re-point to get_price) = silent feature-drop → violates parity-not-liveness.
- Rejected P-C (extend get_price to also resolve) = authors a getPrice/resolvePriceTarget merge herobids does NOT have + mutates a shared tool's contract for unrelated callers. P-A reproduces herobids' two-surface split faithfully.
- **Shared surface B1+B3:** ONE tool serves hybrid sizing (B1) AND the watch tools (B3, which also use resolvePriceTarget for pinning). B1 builds it; B3 re-points to it. B2 (plain price) stays on get_price.
- No ratification (settled by parity); one new 005 read-tool surface (expected, parity-justified).

---

## B3 — watch tools over the boundary + watch-evaluation ownership (2026-09-12, decision agent; SETTLED within rules, no ratification)

**Context.** B3 re-points the herobids agent watch tools (`watch_token`/`remove_watch`/`check_watches`/`list_watches`, `apps/worker/src/tools/watch.ts`) over the Traderton boundary. Parity-check surfaced two seam issues beyond a clean tool re-point:

1. **`instrumentRepo` not wired in the boundary factory** (traderton `packages/boundary/src/bin.ts` — wires redis/botRepo/priceService/marketDataRegistry but NOT instrumentRepo). Consequence: over the boundary `watch_token` skips the instrument-identity block → protective watches (stop_loss/take_profit/exit) that rely on auto-linking (no explicit `coverage.targetPosition`) are REJECTED by the fail-closed guard, though they succeed in-process. Same gap makes boundary `find_instrument` always return `instrument.repo_unavailable`. → **B3-pre**: construct `new InstrumentRepository(db)` (already exported by `@traderton/db`; the `db` handle is already in the factory) and add it to the returned context. Mechanical composition-root wiring, authors no trading logic → **settled by parity / within rules**. Unblocks both `watch_token` protective auto-link and `find_instrument`.

2. **Watch-state split-brain + the platform monitor.** Watch state is Redis `agent:watches:{agentId}` (+ `:summary:` + `:notified:`). B3 moves the TOOLS' reads/writes to Traderton's Redis. But (a) the herobids worker's `market-intelligence/monitor.ts` `evaluateWatches()` is still constructed/started (herobids `index.ts:925`, local `redisClient`), reads+writes `agent:watches:*` locally and emits `agent.wake` (watch_threshold); and (b) the agent per-tick reader `loadActiveWatchSummary` (herobids `agent.ts:792`) reads `agent:watches:summary:*` locally. Landing B3 alone → monitor sees an empty local set → **watch-threshold wakes silently stop** + the agent's own watch summary goes stale = a silent parity DEGRADE.

**Decision (Option D — evaluation authority = Traderton `check_watches`; monitor = thin platform consumer).** Traderton `check_watches` already runs the identical edge-trigger logic, persists `lastConditionMet`/`lastCheckedAt`, refreshes the summary, and returns the triggered set — it is the single evaluation authority. The herobids monitor stops scanning/evaluating local watch state and instead, per active+subscribed agent, invokes `check_watches` over the boundary and consumes the returned `triggered[]`, doing ONLY platform work (session-active filter, wake-prefs filter, scanner-gated context-only mode, dedupe, rate-limit, `emitMarketWatchTriggered`, `enqueueWake`). The agent per-tick summary reader is re-pointed to source the summary over the boundary too. This draws the platform/trading line exactly: **evaluation + watch state = Traderton; wake emission = herobids platform.** No trading evaluation is authored in herobids (consumes existing `check_watches`) — only a thin seam.

**Sequencing (binding): B3 must NOT land alone.** B3-pre (traderton instrumentRepo wiring) + the 4 watch-tool re-points + the monitor re-point + the summary-reader re-point land ATOMICALLY in the same slice, else the branch has the Option-A silent degrade as an intermediate state. Fallback ONLY if the monitor/summary re-point proves materially larger than one slice: **Option C** — land B3 tools with the local watch-wake path explicitly DISABLED + a logged Deferred-required cutover row (a temporary, logged gap on a branch; still no merge, still no ratification). Never fall back to Option A (silent).

**Rejected:** A (leave monitor local → silent degrade, violates "must not degrade"); B (monitor re-implements evaluation off boundary-fetched raw state → drifts toward authoring evaluation in herobids, weaker on copy-never-author); C as primary (turns wakes OFF when a same-slice D is available — fallback only).

**Implementation mechanism note (assigned to Implementer, not a further decision):** the monitor runs in the main worker process looping over many agents, so it needs, per active agent, that agent's `ownerId` + a write boundary bound to that agent's subject to invoke owner-scoped `check_watches`. `systemReadBoundary` (SYSTEM subject, read-only) is insufficient. Resolve `ownerId` per agent from the existing session/agent registry and construct a per-subject write boundary (the write adapter takes the subject per-call).

**§9.3 gate result:** parity-check — the correct end-state reproduces herobids `main` observable behaviour (wakes still fire, summary fresh); D relocates only *where evaluation authority lives* (Traderton), consistent with the already-settled regime re-point. Violation check — D enforces the top isolation rule, honours parity (no drop), honours copy-never-author. **SETTLED WITHIN THE RULES; wake-firing itself settled by parity. No human escalation, no ratification.** (Only the Option-C fallback would log a temporary Deferred — still no ratification.)

**Out of scope for B3 (logged, not dropped):** `resolve_watch` (lives in `resolvers.ts` with resolve_bot/resolve_task — routes with the resolvers group later; still reads local Redis until then, no split-brain once both land on the same boundary). `generate-narrative.ts` diagnostic reads of `agent:watches:*` (read-only, eval-time; low priority note).


### B3 — Option-C fallback ELECTED for the monitor re-point (2026-09-12, coordinator; settled within rules, no ratification)

The B3 decision (above) set Option D as default and Option C as the fallback "if the monitor/summary re-point proves materially larger than one slice." On grounding the monitor mechanism it does: the herobids `market-intelligence/monitor.ts` runs in the main worker process (deps `{ redis, publisher }`), loops over agents knowing only `agentId`, and to invoke owner-scoped `check_watches` per agent it would need (a) a NEW `db` dep + an `agentId→ownerId` lookup (herobids resolves owner via `db.select({userId: agents.userId}).from(agents)` — see `run-evaluation.ts`), (b) a per-agent write-boundary factory (the write adapter binds the subject per-call; the boundary's `skipVenueResolution` short-circuit for `ownerScopedNoVenue` tools means a consumer-signed `{ownerId, actor:{id: agentId}}` subject correctly targets `agent:watches:{agentId}` — so it IS within the existing boundary contract, no new surface), and (c) a substantial `evaluateWatches` restructure (drop local scan/eval; consume boundary `triggered[]`) + rework of the large monitor test suite. That is its own slice, not a tail of B3.

**Elected: Option C.** This pass lands B3-tools (4 watch tools over the boundary) + B3-summary (agent tick summary reader over the boundary — clean, since `agent.ts` already builds the per-agent subject) and DISABLES the monitor's local watch-threshold evaluation so it does not run against an empty local watch set (no silent split-brain corruption, no partial). The monitor watch-evaluation re-point (Option D shape) is logged as a Deferred-required cutover obligation: **B3-monitor** (011). This is rule-compatible: temporary, logged, on a branch, not merged, and it is an accepted-and-recorded temporary gap (watch-threshold WAKES are OFF until B3-monitor lands) rather than a silent degrade — so still no human ratification (not a merge to main, not a permanent accepted degrade). §9.1: parity-check — herobids `main` fires watch wakes; C turns them OFF temporarily but LOGS it and does not corrupt state → not a silent drop; violation check — no rule/decision/objective violated (it advances isolation for the tool surface + summary; the wake gap is explicitly tracked). Settled within rules.

**Note on the agent's OWN `check_watches` tool over the boundary:** the agent can still call `check_watches` itself (its tool routes over the boundary post-B3-tools), so on-demand watch evaluation by the agent is preserved; only the platform PUSH loop (proactive wakes) is deferred to B3-monitor.


## B5 — volatility candles behind the boundary (2026-09-12, decision agent; SETTLED within rules, no ratification)

**Context.** herobids `agent.ts:3001` `fetchVolatilityCandles` fetches BTC 1h candles (limit 24) directly from `marketDataRegistry.binance.candles` and feeds them to the PURE platform functions `calculateAtrPercent(candles)` → `resolveAdaptiveIntervalMs(...)` in `tick-gates.ts`, which set the agent's ADAPTIVE TICK CADENCE. `agent-capabilities.ts:34` records this as the last known in-agent-process market-data fetch ("volatility candles have NO boundary tool yet"). No existing boundary tool returns candles or a volatility number (check_regime → regime verdict; score_candidate → signal; scannerCandleFetcher is an internal ctx port).

**Decision (Option B).** Add a new narrowly-scoped boundary READ tool (e.g. `get_volatility`) that fetches BTC 1h/limit-24 candles BEHIND the boundary and returns the DERIVED `{ volatilityPct: number|null, freshness }` — never raw candles. herobids re-points the `fetchVolatilityCandles` port to `ctx.tradertonBoundary.invoke({ toolName:'get_volatility', ... })` → `mapReadResultToToolResult`, keeping ONLY `resolveAdaptiveIntervalMs` (pure platform scheduling: thresholds, cadence doubling/halving). Non-success boundary result → throw → the existing `adaptiveIntervalDegraded` fallback fires (identical to today's fetch-throws path and to B4's regime treatment).

**Copy-vs-author:** the ATR% derivation is trading-market-data (true-range/close ratio over BTC candles) → its home is `@traderton/market-data` (which already contains the copied true-range/ATR arithmetic inside `indicators.ts` `adx`/Wilder ATR). Relocating/backing the tool with the copied ATR% derivation is copy-and-delete, NOT new authoring. `resolveAdaptiveIntervalMs` + thresholds are platform scheduling → STAY in herobids `tick-gates.ts`. This split matches the objective: trading-market-data derivation goes Traderton-side; the platform scheduling decision stays consumer-side.

**Rejected:** A (new tool returns raw `PriceCandle[]`; herobids keeps `calculateAtrPercent`) — puts raw candle arrays back on the consumer + leaves a trading-market-data derivation in the herobids process → violates the HARD isolation rule (`tool-contract.ts:274-276`: "the consumer must not fetch trading candle data"; boundary returns derived results, not candles). C (extend check_regime to carry ATR%) — `RegimeResult` has ADX (trend strength) not ATR% (volatility); different window (200 vs 24), contract-breaking, conflates two independently-gated tick concerns. D (drop the volatility input) — degrades adaptive cadence; forbidden silent degrade.

**§9.3 gate:** parity — herobids `main` consumes only a derived number from the candles and the fetch is already best-effort/degradable; B reproduces the consumer behaviour + degradation while moving the fetch behind the boundary (the migration's point; same as ratified B4 regime). Violation check — B ENFORCES isolation + stays copy-faithful. **SETTLED WITHIN THE RULES; reinforced by parity with B4/check_regime. No human ratification.** Record here; no ledger Gap for the ruling.

**Prerequisite check (resolved):** the decision agent flagged a possible D1 gap (boundary factory omits `marketDataRegistry`). VERIFIED STALE — `bin.ts:201` DOES wire `marketDataRegistry` into the context (B4's tools already rely on it). No wiring blocker for `get_volatility`.

**Tool shape/name:** `get_volatility` (verb_noun per herobids convention) → `{ ok, volatilityPct: number|null, freshness }`, BTC 1h limit-24, candles fetched behind the boundary, ATR% derived Traderton-side. herobids re-point mirrors B4.


## B6 — economic-calendar acquisition + consumption behind the boundary (2026-09-12, decision agent; SETTLED within rules, no ratification; LAND NOW)

**Context.** Human ruled (final, legal-based) the economic calendar is TRADING-ADJACENT → in-scope for isolation, NOT platform. Two herobids sites: ACQUISITION (`index.ts:~1183` — worker constructs `CompositeEconomicCalendarProvider` w/ Scrapfly network fetch + LLM/DOM fallback parser, runs initial warm + `setInterval` refresh warming Redis `market-data:cache:`) and CONSUMPTION (`agent.ts:~1069` provider init + `:~3554` per-tick `getUpcomingEvents({cacheOnly:true})` → `macroEvents`, null-tolerant, non-blocking).

**Decision (Option A, refined).** Move fetch + cache + provider + loop ALL Traderton-side; herobids becomes a pure boundary reader:
1. **Acquisition (relocate loop → traderton `boundary/src/bin.ts`):** when `appConfig.marketData.economicCalendar.enabled` && `process.env.SCRAPFLY_API_KEY`, construct the copied `CompositeEconomicCalendarProvider` (config assembly copied from herobids index.ts, boundary's `redis` for the `market-data:cache:` cache, `createScrapflyFetch`, `createFallbackCalendarParser` from `appConfig.llm`) + initial warm + `setInterval` refresh. Same `enabled && !key → warn` degrade.
2. **Seam (new boundary read tool `get_economic_calendar`):** thin `AgentTool` in `@traderton/worker` market-data read set, registered via `buildToolRegistry`; behind the boundary calls the boundary-owned provider with `{cacheOnly:true}` and returns `EconomicCalendarResult {events,...}`; guards provider-presence → `market_data_not_configured` degrade when EC disabled. Authors NO calendar behaviour (provider is copied).
3. **Consumption (re-point herobids `agent.ts` per-tick):** `tradertonReadBoundary.invoke({toolName:'get_economic_calendar', payload:{}})` → `result.data.events` → `macroEvents`; preserve exact null-tolerant degrade (failure/transport/empty → `macroEvents=null`, warn, block omitted). DELETE herobids EC provider init (agent.ts) + acquisition loop (index.ts) + now-unused imports/interval-clears.

Net: no network fetch, no provider instance in the herobids process. cacheOnly non-blocking read + warm-loop/cacheOnly-read split are copy-faithful to source.

**Rejected:** B (on-demand tool, no cron) — drops the warm loop → first read after cache-miss risks network latency on the tick path (today guaranteed non-blocking cacheOnly) = silent quality degrade; to make B safe you re-add the loop → collapses into A. C (herobids reads Traderton's EC cache directly) — re-introduces shared-state coupling = violates the top isolation rule.

**Sequencing: LAND NOW (not Deferred).** All prerequisites present: provider copied (no authoring); `bin.ts` is a long-lived process w/ runtime + once-per-process init site (loop home); EC/scrapfly/llm config already loaded by `bin.ts`; Scrapfly key is env-var by design (NOT a schema gap); consumer transport generic by tool name; `mapReadResultToToolResult` exists. One cohesive slice; no dependency on the D-wave. Backlog's earlier "Deferred-required/shape TBD" is superseded.

**§9.3 gate:** parity — behaviour (macro events reach context; cacheOnly non-blocking; null-tolerant degrade; warm-loop+cacheOnly-read split) copy-faithful to herobids main; the relocation is the same isolation-enforcing move as B4/B5. Violation check — A enforces isolation, honours copy-never-author (copied provider + relocated loop + thin seam), preserves parity, consistent with the human trading-adjacent ruling (does NOT reclassify as platform). **SETTLED WITHIN THE RULES. No human ratification.**

**Ops prerequisite (not a Gap/degrade):** the boundary process must have `SCRAPFLY_API_KEY` in its env for acquisition to run — identical to the herobids worker requirement today; absent → same warn+empty degrade in both. Record in 001 B6 slice entry.


## B7 — remove the in-process market-data fallback from the agent container (2026-09-12, decision agent; SETTLED within rules; ONE pending-ratification item)

**Context.** Wave B capstone. herobids `agent.ts` still constructs `marketDataRegistry`/`priceService`, threads them into the ToolContext, and keeps in-process FALLBACK branches (used only when the Traderton read boundary is absent) at every re-pointed site (venue-intelligence, regime, volatility, hybrid-sizing, get_price/market-data tools). CANONICAL-STATE §3.2 names registry removal as the deferred-but-planned cutover obligation (deferral was B2's scope; removal is the successor).

**Decision (Option D — full teardown NOW + fail-fast startup guard).** Verified field-by-field that the boundary is a COMPLETE parity superset (get_market_overview carries all 6 perps fields incl. markOracleSpreadPct + bybit ratio; discover_tokens/search_tokens cover DEX; check_regime/get_volatility/get_price/resolve_price_target cover the rest) — so removing the in-process registry drops NOTHING when the boundary is present. Scope:
- REMOVE from agent.ts: `createProviderRegistry`/`createPriceService` value-imports; `marketDataConfig`/`marketDataRegistry`/`priceService` constructs (+ MARKET_DATA_CONFIG_JSON parse); every in-process `else` fallback branch (refreshVenueIntelligence in-process block ~1263-1470; regime `evaluateRegime` else; volatility `calculateAtrPercent` else; hybrid-sizing `: priceService!` arm); `marketDataRegistry ?? undefined` + `priceService ?? undefined` + `marketDataConfig` from the ToolContext build; simplify the refreshVenueIntelligence early-return `!boundary && !registry` → `!boundary`; simplify the capability gate `deriveTradingTickWorkPlan` to boundary-only (drop the registry arg; the target-end-state test agent-capabilities.test.ts:83-90 already asserts boundary-only). Drop now-unused imports (`evaluateRegime`, `ProviderRegistry`, `PriceService`, `TokenInfo`, etc. — noUnusedLocals forces it); keep the local `calculateAtrPercent` import from tick-gates only if still used (it is, for... actually its in-process use is being removed — drop if unused). Advances D1 (removes @herobids/market-data value-imports from agent.ts; full package-dep removal is D1's own slice).
- DEGRADE = FAIL-FAST GUARD: at startup, if trading skills resolved AND read boundary absent → throw a clear error ("trading agent requires BOUNDARY_CONFIG_JSON; in-process market-data removed"). NOT silent market-data-unavailable. The boundary is MANDATORY at cutover (CANONICAL-STATE §3/§5: REST is the only legal consumer shape; in-process is a non-cutover dev path). Non-trading agents unaffected (capability gate zeroes their market-data work). The guard is a config-check throw — authors no trading logic.

**Rejected:** A (plain teardown, silent market-data-unavailable on no-boundary) — a trading agent would boot and run with all market-data permanently degraded silently; worse/more-confusing than a boot error. C (defer to D-wave) — leaves the top rule unmet for the agent container through all of Wave B; contradicts B7's purpose. B (partial, keep registry for venue-intel) — unnecessary; venue-intel boundary path is full parity (verified).

**§9.3 gate:** parity — agent.ts is platform Intentional-Divergence (not copied); the in-process fallback was itself an authored TRANSITIONAL seam (B1-B6), never a source behaviour; boundary-present behaviour is parity-preserving (verified superset). Violation check — D enforces the top rule, honours the §3.2 recorded decision, preserves parity. **SETTLED WITHIN THE RULES.** ONE pending-ratification item: the fail-fast-guard behaviour change in the misconfigured no-boundary+trading case (silent in-process fallback → hard boot error) = an accepted Intentional-divergence; logged, added to the after-the-fact ratify-list; NOT a hard stop (rules settle it — boundary mandatory at cutover, fail-closed is the established posture).

**Confirm during impl (non-blocking):** grep `ctx.marketDataConfig` in tools/ before removing it from the ToolContext; the cutover agent-container env should omit MARKET_DATA_CONFIG_JSON + set BOUNDARY_CONFIG_JSON (code no longer reads the former after B7, so a stale value is harmless — clean for clarity).


## B3-monitor — re-point the watch-threshold PUSH loop over the boundary (2026-09-12, decision agent; SETTLED, no ratification)

**Context.** B3 (Option D) disabled the herobids monitor's local `watchThresholds` family; watch-threshold WAKES are OFF. B3-monitor re-enables them by sourcing triggered watches from boundary `check_watches` instead of local scan/eval. Decision agent resolved the three sub-questions + confirmed a pre-existing property.

**Q1 (mechanism) — inject a thin MonitorDep port.** Add `evaluateAgentWatches(agentId) => Promise<TriggeredWatch[]>` (+ reset list, see Q2) built in `index.ts` from: ownerId via `db.select({userId: agents.userId}).from(agents).where(eq(agents.id, agentId))` (pattern already at index.ts:830); per-agent subject `{ownerId, actor:{type:'agent', id:agentId}}` (check_watches is ownerScopedNoVenue → skipVenueResolution → no venue account needed); invoke via the worker's system `sideEffectBoundary.invokeAndAwait({toolName:'check_watches', payload:{removeTriggered:false}, subject, deadlineMs})`. Keeps the monitor port-only/testable (matches read-adapter/write-adapter/checkRegimeBoundary seam precedent). Port fails open (resolution failure → empty triggered, log) matching the monitor's existing posture.

**Q2 (reset-dedupe, the crux) — extend Traderton `check_watches` to return `reset[]`.** On `main`, `evaluateWatches` clears `market-monitor:dedupe:watch:{watchId}:cross:{condition}` on a true→false reset (monitor.ts:284-288) so the next up-cross isn't suppressed within the 24h TTL. Boundary `check_watches` returns only `triggered[]` (edge-up), so the monitor wouldn't see resets → cross-up→reset→cross-up-again within 24h would be SUPPRESSED = missed wake = degrade. FIX: `check_watches` already detects `lastConditionMet===true && !conditionMet` (traderton watch.ts:750) — collect those watchIds and return `data.reset: string[]` alongside `triggered`. The monitor `redis.del`s its dedupe key for each reset watchId (exactly what `main` did). PRESERVES exact parity; authors no eval logic (surfaces data the tool already derives). Cross-repo contract addition → land Traderton-side FIRST (add reset[] + schema/type + a test), record in 005 (consumer-boundary contract) + 006 (check_watches manifest note), then herobids consumes. Rejected: B (reuse agent:watches:notified — semantically the agent's scout-gating set, not the monitor's wake dedupe), C (short-TTL — allows rapid re-wake main suppressed), D (accept the degrade — the exact drop-it failure mode 008 prevents).

**Q3 (removal scope).** REMOVE from the monitor's watch path (trading eval/state in the herobids process): `scanKeys('agent:watches:*')` + hgetall parse; `getLatestPrices` (watch-only; dead after re-point) + its call; local edge-trigger computation; local `redis.hset` of lastConditionMet/lastCheckedAt (Traderton owns it); `refreshSummaryCache` + its call (Traderton refreshes its summary; herobids derives per-tick via list_watches — a monitor summary write would be split-brain). KEEP the platform machinery: `getSubscribedAgentIds('watch_threshold')` as the agent iterator (folds in session-active + wake-prefs), scanner-gated→context-only, dedupe (+ reset[]-driven del), rate-limit, emit + enqueueWake. Reshaped loop: iterate subscribed agents → `evaluateAgentWatches(agentId)` → per triggered entry: dedupe→rate-limit→emit→enqueue; per reset watchId: clear dedupe key. Then flip index.ts `watchThresholds` back to config-driven (re-enable).

**Pre-existing property confirmed (NOT a new degrade):** on `main` the agent's own `check_watches` tool AND the monitor both advanced `lastConditionMet` on ONE shared local store; after B3 they both advance the ONE Traderton store — identical two-caller topology. Settled by parity.

**§9.3 gate:** Q1 internal seam (settled within rules, matches precedent); Q2 reproduces main's reset-clear across the boundary (settled by parity; prevents a degrade; adds a parity-preserving contract field recorded in 005/006, Traderton-first); Q3 enforces the top objective + reproduces main's wake machinery (settled within rules). **SETTLED — no human escalation, no ratification.**


## C1 — swap-venue token-safety gating (2026-09-12, decision agent; SETTLED BY PARITY, no ratification)

**Context.** Ledger Item B left the trading composition root's per-bot `swapTokenSafety` `undefined` + dropped the 1inch `swapNetwork` fail-closed guard, deferred because reproducing herobids' `enrichTokenWithDiscovery` was framed as "non-wiring authoring."

**Ruling.** SUPERSEDED that framing: `enrichTokenWithDiscovery` (herobids `main` `apps/worker/src/index.ts:93-152`) is a self-contained market-data helper; copying it VERBATIM is copy-faithful (008 §9.1), NOT authoring. Every symbol it references (`ProviderRegistry.dexscreener.search`/`discovery.discover`, `TokenInfo`, `ResolvedSwapTokenData`) already exists in traderton; the token-safety adapter (`createSwapTokenSafetyAdapter`) + resolver (`resolveSwapTokenData`, `CanonicalResolver`, `DexScreenerProvider`) + override repo are already copied. So C1 = (1) copy the helper verbatim, (2) wire `swapTokenSafety` via the adapter + the herobids `resolveTokenData` closure (index.ts:243-268) in `create-trading-runtime.ts`, (3) re-add the 1inch guard (index.ts:2043-2047). Runs in the traderton worker/composition process where `sharedMarketDataRegistry` legitimately lives (no isolation conflict).

**Sequencing: land NOW** (not deferred). Restores a live parity gap on a cutover-blocking ledger row; harmless while swap execution is inert (C2: null candles); "must not run live until resolved" argues FOR doing it now while there's no live traffic to regress. Orderbook/paper bots unaffected (guard leaves `swapTokenSafety` undefined without marketData+registry).

**§9.3 gate:** parity check — copies herobids source verbatim + wires copied infra, reproducing herobids behaviour exactly. Violation check — restores parity, degrades nothing, drops nothing. **SETTLED BY PARITY. No ratification.** Ledger Item B → RESOLVED.

**Not-fixed (parity-preserving):** CodeReviewer MEDIUM-2 flagged the guard fail-opens (swapTokenSafety undefined) if the ActorFactory ran before start()/registry-assign — but that invariant holds (factory runs after start), and a defensive throw would be behaviour-changing vs herobids, so NOT added (parity). MEDIUM-1 (composition seam test) WAS added.


## D1 — remaining-value-import classification (2026-09-12, decision agent = Contemplator; routed via 008 §9.1)

**Context.** Wave D1 as written = "remove remaining `@herobids/{engine,venues,market-data,strategy,backtesting}` VALUE imports from herobids apps; drop local `bots/fills/journalEvents/venue_accounts/user_credentials` tables + `trading-provisioner.ts`." A grep of the surviving VALUE (non-type) imports surfaced four groups; the coordinator routed a neutral fact-grounded brief (each import's real consumer verified in code) to the decision agent rather than self-ranking the four-risk (isolation-boundary + parity + feature-drop) classification.

**Ruling (per group).**
- **GROUP 1 — worker market-data registry + scanner candle fetcher (`createProviderRegistry`/`TokenBucketRateLimiter` in `index.ts`; `VenueCandleFetcher` in `scanner-candle-fetcher.ts`): DEFER — its own re-point slice. D1 CANNOT mechanically remove these.** Post-Wave-B the registry feeds ONLY `scannerCandleFetcher`, whose sole consumer is `createEvidencePorts` → the PlatformAssessor. The regime arm of `evidence-adapters.ts` already routes over `check_regime`, but the raw candle-series fetch (`getCandles`, orderbook/perp) still calls venue APIs (Binance/GeckoTerminal) IN-PROCESS. An in-process venue candle fetch IS market-data authority in the worker process — the exact coupling the isolation forbids — regardless that the consumer (PlatformAssessor) is a platform subsystem ("platform consumer does not launder an in-process venue fetch into compliance"). No existing boundary tool is a drop-in: `get_volatility`=derived scalar, `check_regime`=verdict, `score_candidate`=score — none returns raw `PriceCandle[]`. Cutting it needs a new/extended boundary candle-series read (or folding orderbook/perp assessment onto Traderton-side evidence) + re-point of `evidence-adapters.getCandles`. Honors the 2026-09-12 log entry that already flagged this as "a distinct market-data coupling to be cut" (Deferred, NOT platform-keeps-forever). Settled within rules. **Scope headline: D1 is not one slice.**
- **GROUP 2 — worker public streams (`PublicStreamPool`, `BybitPublicStream`, `HyperliquidPublicStream`): REMOVE-at-D1 (dead runtime path). Settled.** `publicStreamPool` is constructed then only `.shutdown()`; `createScopedStreamPoolHandle` (the only `.subscribe()` caller) has ZERO non-test callers (its sole reference is its own unit test). Nothing consumes the pool's price data in the runtime. Removing the imports feeding an unconsumed pool preserves parity (nothing observable dropped). Remove the now-dead test as Intentional-divergence. (The public-data-vs-authority question is moot — the path is dead; if a future platform-display slice needs public streams, that is a fresh decision then.)
- **GROUP 3a — venue adapter `.probe()` in the API control plane (`HyperliquidAdapter`/`JupiterSwapAdapter`/`OneInchSwapAdapter` in `accounts.ts`): KEEP for D1 (platform-permissible), removal is OPTIONAL/non-blocking per 011 §2. Settled.** Lives in the API process (separate HTTP control plane), NOT the agent/worker process the invariant governs. `.probe()` is an unauthenticated venue-metadata call returning a `venueProfile` for the pre-provision preview — no trading state, no owner-scoped credentials, no order authority. Provisioning itself is already re-pointed to `provision_venue_account`; only the preview probe remains. 011 §2 already lists the deprecated `POST /venue-accounts` preview endpoint as delete-at-cleanup (non-blocking). Forcing it into D1 would over-scope against 011's own classification.
- **GROUP 3b — `generateWallet` / `deriveSolanaAddress` (`setup.ts`/`chat.ts`/`index.ts`/`accounts.ts`): trading-owned → must move Traderton-side; DEFER the import removal; FLAG FOR HUMAN RATIFICATION.** Verified: `generateWallet` runs only when `credentialMode==='generated'` on the trading path; the generated wallet's secrets become `normalizedSecrets` shipped to Traderton via `provision_venue_account` (the boundary owns the credential; herobids persists only `connectionId`+`venueAccountId`). So this MINTS trading venue keypair/private-key material in-process in the payment-rails-adjacent deployment — not neutral platform key-gen (contrast OAuth/session keys). The isolation's spirit says trading key generation belongs Traderton-side (add a "generate" mode to `provision_venue_account` or a dedicated boundary key-gen). Mechanical import deletion would break generated-wallet provisioning until Traderton accepts a generate-mode + returns the address (a boundary CONTRACT change, not an import deletion). This is the §3-undetermined open question AND a custody/security judgment → NOT settled purely within existing rules → human ratification required before implementing.

**Summary.** GROUP 2 + the table drops + `trading-provisioner.ts` removal are the mechanical D1-a slice (safe now). GROUP 1 (candle-evidence re-point) and GROUP 3b (Traderton trading key-gen contract) each require a Traderton-side re-point BEFORE their imports can be removed; 3b additionally needs a custody ruling ratified. GROUP 3a stays until the 011 cleanup pass.

**Two open questions requiring human input (not answerable from code):**
1. GROUP 3b custody (BLOCKING 3b): ratify that trading wallet generation moves Traderton-side (generate-mode on `provision_venue_account` or a dedicated boundary key-gen tool), vs accept in-process trading key-gen as platform retention.
2. GROUP 1 re-point shape (blocks D1-b, not D1-a): new boundary candle-series read tool, vs fold orderbook/perp market-assessment onto Traderton-side evidence.

**§9 gate:** GROUPS 1/2/3a settled within rules (parity-preserving; honor prior decisions + 011). GROUP 3b flagged for ratification (custody call + boundary-contract change; the §3 undetermined item). D1-a can proceed autonomously now; D1-b + 3b are their own re-point slices pending the two rulings.


## D1-tables — trading-table-drop scoping (2026-09-12, decision agent = Contemplator; routed via 008)

**Context.** D1 wants to DROP the local trading tables (`bots`/`fills`/`journalEvents`/`venue_accounts`/`user_credentials`) from herobids, but a grounded audit found KEPT-PLATFORM subsystems still read them IN-PROCESS (evaluation evidence, assessment identity, grant resolution, Gmail-OAuth credential refresh, + ruling-5 route fallbacks). Whether these re-point pre-cutover or the tables persist is a four-risk architecture/scoping call → routed neutral.

**Ruling (governing principle).** A local `fills`/`bots`/`venue_accounts` table IS trading STATE physically resident in the payment-rails-adjacent process; a kept-platform reader reading it in-process is the SAME laundering pattern the GROUP 1 candle ruling rejected ("a platform consumer does not launder an in-process fetch into compliance") — applied to STATE. §3.1 is unconditional ("delete the trading DB, incl. the `bots` table") — no "platform read surface" carve-out. So "no trading state in the process" = both the write path (already moved) AND every in-process read a kept subsystem makes. The tables must go; their readers re-point to the boundary first.

- **A — PRE-cutover obligation (not cutover-time).** It is CODE re-pointing (cut the in-process read couplings), NOT row movement. D2 (migrate surviving credential/venue rows) is the separate data step. The branch's merge-gate bar = herobids consuming Traderton with no in-process trading state → A is pre-cutover. Settled within rules (correct re-point changes no externally visible behaviour).
- **B — re-point the three platform readers over NEW agent/owner-scoped boundary READ tools (A2-shaped), each its own slice. Settled within rules.** #1 evaluation evidence (`evidence-assembler.ts` `loadAgentFills`/`loadAgentJournalEvents`/`loadAgentBotIds` → new agent-scoped read tools, e.g. `get_agent_fills`/`get_agent_journal_events`/`get_agent_bot_ids` or an evidence-bundle read; aggregation stays Traderton-side; NOTE the SAME loaders feed `apps/api/src/routes/exports.ts` — that consumer must re-point on the same tools). #2 assessment identity (`assessment-identity-resolver.ts` reads `bots`+`venue_accounts` → boundary venue-binding read, e.g. `resolve_assessment_identity`/`get_agent_venue_binding`; the assessment stays platform). #3 grant resolution (`startup-context.ts`) is MIXED — `connections`/`agent_connections` grant layer STAYS local (§3.1 keeps the grant layer), only the `bots`/`venue_accounts` read re-points → a seam split within one resolver, the most intricate (implementer note, still within rules). Rejected "tables persist as platform read surface" (contradicts §3.1; re-homes trading state on the payment deployment) and "leave reads in-process because consumer is platform" (GROUP 1 laundering principle).
- **C — `user_credentials` SPLIT; PENDING HUMAN RATIFICATION (the one blocker).** The shared table holds BOTH trading venue creds AND non-trading Gmail/OAuth creds (`gmail-credential-resolver.ts` reads+re-encrypts email-provider OAuth tokens by joining `connections.credentialId`). Under the settled "credentials NOT mirrored; each side stores only what it uses" model: the trading half migrates to Traderton (rows at D2), the Gmail/OAuth half stays in a herobids-local table → the table must be SPLIT. The split (schema + write-path) is pre-cutover; row migration is D2. This is a credential-store schema/ownership partition = custody class (GROUP 3b precedent) → NOT copy-faithful parity → HUMAN RATIFICATION before implementing. Safe default proposed: split now behind the existing model, migrate venue rows at D2.
- **D — ruling-5 local fallbacks: in-scope; ride ATOMICALLY with (or after) the B re-points; boundary becomes MANDATORY (B7 fail-fast posture, already-accepted Intentional-divergence).** A fallback can only be removed once its primary boundary read exists+proven; removing earlier = broken intermediate (forbidden like B3's no-silent-degrade rule).

**Scope headline (the true shape).** The D1 table-drop is a MULTI-SLICE RE-POINT WAVE, not a D1 mechanical step. Sequenced as A2-shaped slices: author agent-scoped evidence reads → re-point #1 (+ exports.ts); author assessment-identity read → re-point #2; split startup-context venue read over boundary (grant stays local) → re-point #3; remove ruling-5 fallbacks atomically with their reads; THEN drop the four tables. `user_credentials` is a separate track gated on C's ratification (split) + D2 (row migration). Record each new tool in 005/006 Traderton-first (mirroring A2/B). **A, B, and D can proceed autonomously NOW; only C blocks (the credential split).** Merge gate unchanged (the one hard stop).

**§9 gate:** A/B(#1,#2)/D settled within rules (parity-preserving A2-shaped re-points; new read-tool surfaces expected + parity-justified). B(#3) settled but intricate seam (implementer note). C requires HUMAN RATIFICATION (credential-store partition; custody class). 


## D1 open questions — resolution pass (2026-09-12)

### Q1 (GROUP 3b — trading wallet key-gen) — SETTLED BY PARITY / EXISTING RULES; NO ratification needed (coordinator over-escalated; corrected)
`generateWallet`/`deriveSolanaAddress` on the `credentialMode==='generated'` trading path mint trading venue keypair material in the herobids process. This is NOT an open custody choice — it is settled by the existing rules: (i) the isolation invariant (no trading state/authority in the herobids process); (ii) settled decision 12 ("credential custody follows the venue caller → Traderton"); (iii) the already-settled "Traderton owns the venue credential; new trading links land via `provision_venue_account`" model. Trading key-gen is trading behaviour → it moves Traderton-side. Realized as a `generate` mode on `provision_venue_account` (or a dedicated boundary key-gen tool) that mints behind the boundary and returns address/metadata only (never the private key). §9.1 parity-check settles it; the coordinator wrongly framed it as needing human ratification — corrected. Implementation is a re-point slice (Traderton generate-mode + herobids re-point of setup/chat/index/accounts), sequenced with the trading-drop; NOT a hard stop.

### Q2 (GROUP 1 / D1-b — candle-evidence re-point) — CONTEMPLATED; RECOMMENDATION FOR HUMAN APPROVAL = Option B (derived-evidence hybrid)
Decision agent (Contemplator) verified: NOTHING downstream of `evidence-adapters.getCandles` consumes the raw OHLCV series — all four consumers in `PlatformAssessor.collectEvidence` want a DERIVATION (volatility verdict via ATR%, candle-window {start,end}, availability flag, score). Recommendation: **Option B realized as a derived-evidence hybrid** — feed the four consumers derived evidence over the boundary reusing tools that ALREADY exist (`get_volatility` for ATR/volatility; `score_candidate` for signal + `candlesEvaluated` count; `check_regime` for regime), extending one existing derived tool to also return the `{start,end}` candle-window metadata; author NO raw-candle read tool. Then delete `scannerCandleFetcher`/`sharedMarketDataRegistry`/`scanner-candle-fetcher.ts` + the last `@herobids/{market-data,venues}` value imports from the worker. REJECTED Option A (`get_candles → PriceCandle[]`): it directly reverses the derived-only contract rule (tool-contract.ts:275-277) that B5/B7 established, sets a precedent that raw candles may cross the wire, and pays the highest architectural price to move data nothing consumes raw. Upholds derived-only + the B5/B6 derivation-crosses/verdict-stays split; parity-preserving (ranker consumed derived scalars, not arrays; raw-array-carried-but-unconsumed → Intentional-divergence); copy-never-author (herobids authors deletions + a thin re-point seam only). Small–medium; prerequisites mostly already met (score_candidate/get_volatility/check_regime + scannerCandleFetcher/scannerPoolResolver wired in bin.ts, proven by boundary-e2e). Seam open qs: candle-window surfacing (extend score_candidate vs get_volatility, or drop to null if audit-only); symbolCandles keep-as-flag vs remove. **GOING TO HUMAN FOR APPROVAL.**

### Q3 (D1-cred — `user_credentials` split) — CONTEMPLATED; RECOMMENDATION FOR HUMAN APPROVAL = carve-out + defer-to-D2 + drop
Decision agent (Contemplator) verified: `connections.credentialId` is ALREADY asymmetric — non-trading links (Gmail/OAuth/telegram/twitter) name a local `user_credentials` row; trading links have `credentialId=null` (credential behind the boundary via `resolvedVenueAccountId`). New trading links already bypass local creds (setup.ts trading path → `provision_venue_account`). So herobids-local TRADING rows are legacy/pre-cutover residue (exactly D2's job); the only live local consumers are NON-trading (gmail-credential-resolver read+write-back, connections-oauth, setup non-trading path, credentials CRUD, plan-guards count). Recommendation: **carve-out hybrid** — (pre-cutover, consume-traderton branch) author a new herobids-local NON-trading credential table (e.g. `platform_credentials`), re-point the ~5 non-trading read/write paths, backfill the non-trading rows; resolve the transitional trading-validation reads in accounts.ts/connections.ts as part of the trading-drop; (cutover) D2 migrates the TRADING rows to Traderton (unchanged — do NOT duplicate); (after D2) drop the old shared `user_credentials`. REJECTED: purge-in-place/rename (keeps trading-cred history home, no work saved); column/flag partition (trading + non-trading physically co-resident → violates isolation); leave-trading-rows-as-Deferred (retains trading creds on payment deployment). Matches the settled credential model (each side stores only what it uses; not mirrored) + decisions 11/12; parity-preserving (Gmail OAuth refresh keeps working via same-shape re-point); does not duplicate D2. Medium; requires a herobids schema migration (branch-only). Seam open qs: table NAMING (`platform_credentials` recommended); drop TIMING (gate strictly after D2 verifies migration — recommended); whether the accounts.ts/connections.ts trading-validation re-points belong to this workstream or the trading-drop workstream. **GOING TO HUMAN FOR APPROVAL.**

### R1 / B7 fail-fast startup guard — ACKNOWLEDGED (2026-09-12, human); removed from pending-ratification
The B7 fail-fast guard (trading agent + no read boundary → hard boot error instead of silent in-process degrade) was already settled-within-rules (boundary mandatory at cutover; fail-closed is the established posture). Framing it as "pending ratification" was a mislabel. Human acknowledged; the item is CLOSED — no ratify-list entry remains.


### D1 open questions — HUMAN APPROVED (2026-09-12)
- **Q2 (D1-b candle-evidence): APPROVED — Option B (derived-evidence hybrid).** No raw-candle tool; feed derived evidence over existing tools (`get_volatility`/`score_candidate`/`check_regime`), extend one to return the `{start,end}` candle-window. Seam sub-choices delegated to the coordinator.
- **Q3 (D1-cred): APPROVED — carve-out hybrid.** New herobids-local non-trading credential table + re-point the non-trading paths + backfill non-trading rows (pre-cutover, branch); D2 migrates trading rows; drop the old shared table after D2. Naming/drop-timing sub-choices delegated to the coordinator.
- Coordinator sub-choice defaults (recorded): Q2 — surface `{start,end}` candle-window on `score_candidate` (it already fetches candles Traderton-side, natural home) rather than `get_volatility`; keep `symbolCandles` as an availability flag (lower parity risk than removing the field). Q3 — new table named `platform_credentials`; the old-table DROP gated strictly AFTER D2 verifies trading-row migration; the transitional `accounts.ts`/`connections.ts` trading-validation re-points belong to the trading-drop workstream (D1-c4 area), NOT D1-cred (they read trading rows, which D2/the drop handle).


### D1-b rework — volatility derivation must move Traderton-side VERBATIM (2026-09-12; CodeReviewer HIGH x2; SETTLED BY PARITY)
The first D1-b herobids attempt re-derived `VolatilityEvidence` consumer-side from the boundary's scalar `volatilityPct`, causing two HIGH defects: **H1** — silent UNIT break: old `averageTrueRange` = ATR in absolute price units; new code put a percentage into the same field the LLM ranker consumes (llm-ranker feeds `averageTrueRange`→`atr`, `volatilityRegime`→`regime` into the prompt). **H2** — authored thresholds: old `volatilityRegime` was classified by PERCENTILE (25/75/95) of the current TR within the candle's own TR distribution (needs the full series); new code invented absolute-ATR% bands (only 0.3 copy-anchored; 1.0/2.0 invented) → violates copy-never-author + shifts label semantics on a consumed value.
**Root cause:** the percentile classification + absolute-ATR require the full candle TR distribution, which we deliberately keep behind the boundary. So the derivation cannot faithfully happen consumer-side from a scalar.
**Fix (settled by parity, no ratification):** move the ENTIRE `computeVolatilityEvidence` (ATR over 14 periods + percentile-regime + `percentileValue`) VERBATIM into `@traderton/market-data` (next to `calculateAtrPercent`), and have the boundary volatility read return the full `VolatilityEvidence {averageTrueRange, volatilityRegime, calculationVersion:'1.0.0'}` — derived behind the boundary from the candles it already fetches. herobids consumes the shape verbatim (no consumer-side classification, no invented thresholds, `calculationVersion` stays '1.0.0'). This reproduces herobids `main` exactly → SETTLED BY PARITY (copy-faithful, like B5's ATR% relocation; the B5/B6 derivation-crosses/verdict-stays split). Mechanical sub-choice (extend `get_volatility` to also return the full evidence vs a dedicated tool): coordinator's call, no behaviour impact — extend/add a derived read that returns the copied VolatilityEvidence; keep the existing `{volatilityPct}` shape intact for the agent tick-loop consumer (B5) so that consumer is unaffected. M1 (double score_candidate fetch per assessment) → address in the rework or log as an accepted transitional cost.


## No pre-existing production data — greenfield cutover (2026-09-12, human-stated)

**Human stated: "We have no real data. We are starting afresh."** No production/real rows exist
(no trading-credential, venue-account, bot, fill, journal, or user_credentials rows to migrate).
The cutover is GREENFIELD — post-cutover, all trading state is created NEW directly in Traderton.

Impact on the D-wave (recorded in CANONICAL-STATE §2.0, 001 D2 row, 011):
- **D2 (pre-existing row migration) → NO-OP.** Nothing to migrate. Reduces to a "confirm the old
  tables are empty, then drop" step. The `Deferred (required for cutover)` obligation is satisfied
  by the absence of data (not by a migration).
- **D1-cred carve-out → NO backfill step.** The new herobids-local `platform_credentials` table
  starts empty; there are no non-trading rows to copy. New links land directly in the new table.
- **`user_credentials` DROP no longer gated on a data migration** — gated only on re-pointing its
  code consumers (D1-cred non-trading half + the D1-c4 trading-validation re-points); then it drops
  (empty).
- **D3/D4 need no data-seeding** — E2E + soak run against freshly-created data.
- Parity discipline unchanged — parity is measured against herobids `main` BEHAVIOUR, not a dataset.


### D1-cred scope CORRECTION — credentials.ts is a TRADING path (2026-09-12, decision agent = Contemplator)
Grounding the carve-out found `apps/api/src/routes/credentials.ts` (`POST/GET/DELETE/rotate /credentials`, LIVE, web-client-called) is NOT non-trading: it validates VENUE secrets (`canonicalizeVenueSecrets`/`validateVenueSecrets` over `parsed.data.venue`, same as trading provisioning), stores them in `user_credentials`, and `accounts.ts`/`connections.ts` validate a supplied `credentialId` against it to link venue accounts/connections. So it mints/stores TRADING venue credentials in herobids-local storage — an isolation violation; must NOT move to `platform_credentials`.

**Corrected D1-cred scope:**
- **Move to `platform_credentials` (genuinely non-trading; SETTLED WITHIN RULES):** `gmail-credential-resolver`, `connections-oauth`, and the **setup.ts NON-trading path only** (the setup.ts trading path already provisions to Traderton, no local write). Re-point `plan-guards.checkCredentialLimit` to count `platform_credentials` only (trading quota is already covered by `count_venue_accounts`/`checkVenueAccountLimit`).
- **Trading (NOT moved; belongs to the D1-c4 trading-drop / deprecation workstream):** `credentials.ts` + the `credentialId`-validation branches in `accounts.ts`/`connections.ts`.
- **NEW human-ratification item (Q4):** deprecate/remove the live `POST/GET/DELETE/rotate /credentials` endpoint (superseded by `provision_venue_account` manual+generate via the holistic setup flow; greenfield = no data loss; best serves isolation) vs re-point it to Traderton. **Recommended: deprecate/remove.** Product/contract call (removing a live web-client-facing endpoint) → needs the human.
- **Safe interim (proceed NOW, no block):** do the non-trading move + `checkCredentialLimit` re-point; FREEZE the trading paths (`credentials.ts`, accounts/connections credentialId validation, and the `user_credentials` table) unchanged until Q4 is ruled — `credentials.ts` keeps writing `user_credentials` (no user-facing regression) until then. Do NOT put trading secrets in `platform_credentials`.


## D1-c1 — evaluation-evidence reads over the boundary (2026-09-12, decision agent = Contemplator; SETTLED WITHIN RULES)

**Plan:** `docs/features/initial/features/D1-c1-evaluation-evidence-plan.md`. Re-point the herobids PLATFORM agent-evaluation subsystem's reads of the trading tables (fills/journal/positions/bots) over the boundary so the tables can drop (D1-c4). Evaluation analyses RAW rows (redaction, per-fill timing, security-scan) → the reads return FULL ROW arrays.

**Ruling on full-trading-STATE-rows over the boundary: APPROVE-WITH-CONSTRAINT, settled within rules (no ratification).**
- The derived-only contract rule (tool-contract.ts) is a MARKET-DATA rule — its text/justification are entirely about `scannerCandleFetcher`/pool fetch ("must not fetch trading CANDLE/pool data"), i.e. keeping the platform out of the market-data pipeline. It does NOT reach trading STATE rows. Trading-state-to-the-owning-consumer is a different, permissible category.
- **Decisive precedent (A2):** `get_owner_bot_journal` already returns RAW journal rows (`{events}`, "a filtered read, NOT aggregation, passed through verbatim") — raw trading-state row-reads over the boundary to the consumer were ALREADY settled in A2. D1-c1 is an in-category extension (fills + positions, agent-scoped), not a new line.
- Isolation is STRENGTHENED (removes local table reads → tables can drop; Traderton is the authority; platform gets a read-only copy of the agent's OWN audit trail; no execution/authority returns to the platform).
- Full-row read is the right seam; relocating evaluation Traderton-side would violate its PLATFORM/Intentional-Divergence classification (redaction/timing/security-scan are platform concerns) and no derived view suffices.
- **Constraint:** scoping enforced Traderton-side (agent/owner-scoped; other agents' rows → not_found, no leak); read-only (`read-database`); NO secrets in rows (fills/journal/positions carry trade state, not credentials); herobids passes rows through verbatim (redaction/analysis applied after receipt, as today); re-point BOTH consumers (evidence-assembler + exports.ts) or the table drop is blocked.

**Scope narrowing — `agent_runtime_sessions` is PLATFORM, STAYS LOCAL: settled by parity.** It hard-FKs `agents.id`, is agentId-scoped, written by the agent-container lifecycle, is NOT one of the four D1-c4 trading tables (fills/journal_events/positions/bots), and is absent from `@traderton/db`. So `loadAgentRuntimeSessions`/`sessions.json`/`/export/sessions` stay local (out of D1-c1/D1-c4). D1-c1 re-points FOUR loaders (fills, journal, positions, botIds), not five. Integration note: in evidence-assembler + /export/bundle, the sessions read STAYS a local `loadAgentRuntimeSessions` call alongside the boundary reads — those paths become mixed (expected, not a smell).

**Tool granularity (mechanical, in-plan):** three granular tools `get_agent_fills`/`get_agent_journal_events`/`get_agent_positions` (botIds folded in server-side via the existing `getBotsByCreator('agent',agentId)` = byte-identical to `loadAgentBotIds`); no bundle, no separate botIds tool. Documented Traderton-first (005/006).


### D1-cred-Q4 — RESOLVED (2026-09-12, human): REMOVE the standalone /credentials flow ENTIRELY
Human ruled **A — remove entirely** (not re-point to Traderton). The standalone reusable-venue-credential flow is superseded by the holistic setup flow (`provision_venue_account`, incl. generate mode); greenfield = no data/users to preserve; removal best serves isolation and lets `user_credentials` drop.

**Scope of removal (its own slice, folded into the D1-c4 trading-drop pass):**
- herobids API: delete `apps/api/src/routes/credentials.ts` (`credentialRoutes`: POST/GET/DELETE/rotate `/credentials`) + its registration in `apps/api/src/index.ts` + `credentials.test.ts`; the credential audit events (`credentialCreatedEvent`/`credentialRotatedEvent`/`credentialDeletedEvent`) usage; `CreateCredentialSchema`/`RotateCredentialSchema`; `findCredentialDependents`/`credential-dependents.ts` if only used here.
- herobids API: remove the `credentialId`-referencing branches in `accounts.ts` (POST /venue-accounts credentialId validation) and `connections.ts` (POST /connections credentialId validation) — the holistic flow supplies `credentialId=null` and provisions to Traderton; standalone credentialId linking goes away with the endpoint.
- herobids WEB: remove the Credentials page + route + nav — `apps/web/src/features/credentials/CredentialsPage.tsx` (+ its tests), the `/credentials` route in `app/router.tsx`, the sidebar entry in `app/layout/Sidebar.tsx`, the `credentials` client in `lib/api-client.ts`, the `nav.credentials`/`credentials.*` i18n strings, and the `AgentCapabilityPage` "manage credentials" link. (ProviderSetupForm imports `PROVIDER_TEMPLATES` from CredentialsPage — relocate that constant so setup keeps working.)
- After removal + the D1-c1/c2/c3 re-points, `user_credentials` has NO remaining writer/reader → drops at D1-c4 (greenfield, empty).

Sequenced as part of the D1-c4 trading-drop pass (it is the last thing keeping `user_credentials` alive alongside the c1–c3 read re-points). Settled — no remaining Q4 ambiguity.


### D1-c2 — assessment-identity venue-binding read (2026-09-12, coordinator; settled by the D1-c1 ruling)
`market-intelligence/assessment-identity-resolver.ts` `resolveAgentBinding` reads `bots.venueAccountId` (agent-owned) → `venueAccounts.venue`/`venueProfile` to infer the agent's venue binding (venueFamily + instrumentKind). GROUNDED: `AssessmentIdentityResolverImpl` is exported + fully unit-tested but **NOT instantiated in any live worker/api path** (only its own test constructs it) — the `bots`/`venueAccounts` read is DEAD-but-compiled (a schema dependency, never executed at runtime). Still, it compile-depends on the trading tables the D1-c4 drop removes, and it's exported kept-platform infrastructure (market-assessment identity).
**Decision:** re-point it over the boundary (same pattern + ruling as D1-c1 — an agent-scoped trading-state read → boundary; settled by the A2 precedent, no new ratification). Author a small Traderton read tool `get_agent_venue_binding` that resolves the agent's bot → venue account server-side and returns `{ venueFamily, venueType } | null` (derived binding metadata; no raw trading rows, no secrets). herobids `resolveAgentBinding` consumes it, keeping the `agents.unifiedConfig` fallback + `agentPresetBindings` styleTier read LOCAL (platform tables). This removes the resolver's compile-dependency on `bots`/`venueAccounts` ahead of the D1-c4 drop and makes it isolation-compliant if/when wired. Rejected "remove it as vestigial" (it's exported public API with a full test suite = intended infrastructure, not accidental dead code; removing a public surface is a bigger call than re-pointing).
**Outstanding (MEDIUM, non-blocking — CodeReviewer D1-c2):** the old resolver had micro-coverage of a `venueFamily`-falsy branch that is schema-dead (the column is non-null). The re-pointed derived tool returns `{venueFamily, venueType}|null`, so that specific falsy-family sub-branch is no longer exercised. No behaviour change (branch was unreachable); noted here rather than carrying a dead test.


### D1-c3 — startup-context resolver disposition (2026-09-12, decision agent Contemplator; settled by parity)
**Question:** disposition of herobids `apps/worker/src/startup-context.ts` (`resolveBotStartupContext`) in the consume-traderton branch, given it compile-depends on trading tables (`venueAccounts`, `bot.venueAccountId`) the D1-c4 drop removes. It is dead-but-exported+tested (same surface shape as D1-c2's resolver).
**Grounded facts:** ONLY the module + its own test reference it (grep across herobids apps/**/*.ts, excl. dist) — NO live worker/api caller. The LIVE grant path does NOT use it: `index.ts:486` `approvalVenueAccountResolver` uses `botRepo.getResolvedVenueAccount(connectionId)`; `apps/api/routes/bots.ts:216` reads `connections.resolvedVenueAccountId` and forwards `connectionId` to Traderton (bots.test.ts:293 "venue-account resolution MOVED behind the boundary"). Traderton's own runtime (`create-trading-runtime.ts` §424–445) DELIBERATELY DELETED the equivalent grant front-end in Phase 8 (decisions 11–13) — the runtime reads an INJECTED `venueAccountId` instead. No 013/024/CANONICAL-STATE note plans re-adoption (grep startup-context across both repos' .md = 0 matches).
**Ruling: B — REMOVE `startup-context.ts` + its test entirely** (NOT re-point like D1-c2). Reasoning traced to rules: (1) copy-never-author + top-rule override — the source RETIRED this front-end; re-pointing would AUTHOR a new derived boundary tool + reconstruct a consumer the source deleted (authoring, not copying); deletion matches the copied source shape. (2) legal isolation — B removes the trading-table compile-dep with ZERO new coupling; A would add a boundary read solely to keep a dead function alive. (3) parity-not-liveness — nothing LIVE is dropped; behaviour is superseded (Traderton owns injection; herobids forwards connectionId), removal is RECORDED (not silent). (4) the D1-c2 tie-breaker ("removing exported+tested surface is a bigger call than re-pointing") breaks TIES only — here the rules are not tied: the source's deliberate deletion + absence of any re-adoption plan tip decisively to REMOVE.
**Gate result (008 §9.1): settled by parity** — capability moved behind the boundary (not lost); grounded + reversible (git history); no rule/decision/objective violated. NOT escalated.
**Parity-ledger disposition:** Intentional-divergence (recorded in 001).
CodeReviewer PASS (no CRITICAL/HIGH/MEDIUM). LOW: stale git-ignored `dist/startup-context.js` artifact (non-blocking).


## D1-c4 — terminal drop wave decomposition + reader audit (2026-09-12, decision agent = Contemplator; audit)
The D1-tables ruling enumerated THREE readers (evidence-assembler/assessment-identity/startup-context = the WORKER/evaluation path) — all now DONE (c1/c2/c3). A full `apps/api` audit found a DOZEN more in-process readers/writers of the trading tables that also block the drop, plus TWO findings:
- **F1 — `positions` is a SIXTH trading table missing from the drop-set.** It is boundary-owned trading state: `@traderton/db` has the schema + `PositionRepository.loadAgentPositions` copied VERBATIM from herobids (repositories.ts:452 "Copied verbatim"), and the c1 `get_agent_positions` tool already reads it over the boundary. Leaving it local re-homes trading state on the payment deployment (the §3.1 violation the ruling forbids). RESOLUTION: drop `positions` with the five (→ six tables) and re-point every `positions` reader (capabilities/trading.ts, analytics.ts, blueprint-performance-scorer.ts, exports.ts bot/account, views.ts) exactly like a `fills` reader. Settled by the ruling's governing principle (no new decision).
- **F2 — two significant readers were missing/mis-framed:** `capabilities/trading.ts` (the LARGEST live reader — agent state/activity/outcomes/positions for the web UI; agent-scoped → c1 tools cover it, seam: `/positions` exit-price correlated `fills` subquery) and `accounts.ts POST /venue-accounts` (a live `venueAccounts` WRITE, self-documented as a transitional isolation violation — must re-point to `provision_venue_account` manual mode, NOT merely a read).

**Decomposition (9 sub-slices c4.1–c4.9; full text in 011).** Sequencing law: author boundary read → re-point consumer → remove ruling-5 fallback → drop table LAST (no broken intermediate). c4.1 agent-scoped API re-points (reuse c1 tools); c4.2 owner/bot-scoped read tools + export re-point; c4.3 Q4 `/credentials` removal; c4.4 venue-account WRITE re-point + provisioner deletion; c4.5 ruling-5 fallbacks + DELETE local `bots` mirror; c4.6 409-backstop test; c4.7 admin `count(bots)` re-point; c4.8 billing `/trading/fills` ledger (ROUTE); c4.9 drop tables (last).

**§9 gate results.** c4.1/c4.2/c4.5 → settled within rules (A2-shaped re-points; new owner/bot-scoped read tools = the surface class ruling B pre-approved). c4.3 → already human-ratified (D1-cred-Q4). c4.4 → settled by parity (decision 12; provisioner deletion — `provisionTradingTarget` has NO live caller, confirmed). c4.6 → settled within rules (test only). c4.7 → settled within rules (re-point the count; keeping in-process would contradict §3.1). **c4.8 → Option A (re-point over owner-scoped fills read) settled by parity; Option B (relocate the fill-ledger as Traderton-native usage metering — 004 open Deferred concern) is ungroundable in current rules → ROUTE to the decision agent when c4.8 is reached; escalate to human only if the agent says it needs a product call.** c4.9 drop → mechanical once c4.1–c4.8 land. Merge-to-`main` remains the ONE hard stop.


### c4.1 — capabilities/trading.ts agent-bot scoping (2026-09-12, decision agent Contemplator; settled by parity)
**Question:** re-pointing `apps/api/src/routes/capabilities/trading.ts` (`/agents/:agentId/capabilities/trading/{state,activity,outcomes,positions}`) onto the c1 tools changes agent-bot scoping from `bots.connectionId IN (granted connectionIds)` to the c1 tools' `creatorType='agent' AND creatorId=agentId`. Behaviour-contract four-risk (UI PnL/activity/outcomes/positions numbers).
**Decisive fact:** traderton `bots` has NO `connectionId` column — decision 13 deleted it ("connection indirection is platform-only; Traderton binds bots directly to venueAccountId"; schema/bots.ts:17-18). connectionId-scope is STRUCTURALLY INEXPRESSIBLE over the boundary; creatorId-scope is the only faithful re-point. Moreover connectionId-scope is the source-side mis-scope (over-counts foreign USER-created bots sharing a granted connection; under-counts agent bots after grant revocation) — the canonical platform agent-scope is `creatorId` (evidence-assembler + getAnalyticsByCreator/getRecentFillsByCreator/getOpenPositionsByCreator all use it). capabilities/trading.ts was the lone outlier.
**Ruling: A — re-point all four endpoints onto `get_agent_fills`/`get_agent_journal_events`/`get_agent_positions` as-is (creatorId scope); drop the `selectAgentTradingAssignmentRows`→`bots.connectionId` botId resolution; keep the agent-native union arm + all response shapes/fields/limits/ordering intact.** Rejected B (preserve connectionId-scope via new boundary tool — would RE-AUTHOR the connection indirection decision 13 deleted + author a 2nd agent-scoping semantics; violates copy-never-author + isolation) and C (collapses into A).
**Gate: settled by parity** — the divergent scope is inexpressible in the authority + a latent source defect; re-pointing RESTORES parity with the canonical agent-scope. Autonomous, NO ratification. Ledger disposition: parity correction (clarifying note, NOT an Intentional-divergence — nothing lost).
