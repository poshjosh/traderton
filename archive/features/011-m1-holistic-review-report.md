# 011 — M1 Pre-Authoring Holistic Review Report

**Status:** complete
**Created:** 2026-09-07
**Reviewer:** holistic review agent (read-only)
**Instruction:** [010-m1-holistic-review-instruction.md](./010-m1-holistic-review-instruction.md)
**Scope:** the pre-authoring Traderton library (Phases 1–9a) — domain, db, engine,
market-data, venues, strategy, backtesting, worker (mechanical loop + 18/25 tools).
Phase 10 (infra) is explicitly out of scope (shared versioned module, not copy-and-delete).

> **This is the single, consolidated M1 review document.** It incorporates the evidence
> and findings from a second validation pass (originally drafted as a separate addendum,
> now folded in and re-adjudicated against the herobids source). The addendum file has been
> removed so there is exactly one review of record. The second-pass findings and their
> re-tagging are in §4 (see the "Second-pass findings" block) and §6.

---

## 1. Verdict

**The M1 pre-authoring library is SOUND, FAITHFUL, and COMPLETE-AS-POSSIBLE. Proceed to
9b authoring** after correcting the small set of documentation-accuracy findings below.

- **Fidelity:** every surviving trading file I checked is a verbatim copy modulo the
  `@herobids/*`→`@traderton/*` rename. No authored trading logic, no reformatting, no
  weakened test assertions. The highest-stakes surface (`risk-gate.ts` + its 83 parity
  tests) is **byte-identical**.
- **Completeness:** everything copy-and-delete can reach has been copied. Every deferral
  I challenged is genuinely blocked on authoring or on a platform coupling — none is a
  missed copy or an un-requested source-fix.
- **Accounting:** the ledger is substantially honest. Three documentation-accuracy defects
  (2 MEDIUM, 1 LOW) should be corrected so the "Inventory fully accounted for" cutover
  gate can pass truthfully. None is a silent drop or a status unsupported by code that
  affects behaviour.
- **Coherence:** the package dependency graph is acyclic and correctly layered; the
  ports-carry-values invariant holds (the risk gate / planner / executors are engine-owned
  and not injectable through any seam); the lower seven packages are consumable in-process
  today. One by-design caveat: the `@traderton/worker` public barrel is intentionally empty
  (the composition root is 9b).
- **Authoring scope:** the 9b work is fully enumerable and precisely bounded (§6).

**No CRITICAL or HIGH copy-fidelity findings. No cardinal sins found** (no authored logic
where a copy belongs; no silently dropped/degraded capability; no ledger status unsupported
by code that misrepresents behaviour; no port carrying trading behaviour).

**One design question surfaced (mechanical-only enforcement at the config boundary)** — see
§4 "Second-pass findings" S-1. It is *not* a copy defect and *not* a pre-9b blocker: the
current state is a faithful copy of herobids' `StrategySchema` (which accepts `mechanical | llm |
hybrid`), and the mechanical-only guarantee is enforced one layer down (the strategy registry
never registers the llm/hybrid modes; the strategy package exports only `Mechanical`/`Dca`).
Narrowing the config enum would be an *authored* behavioural divergence that the decision log
explicitly reserves for a signed-off decision — the natural home for which is the 9b authored
config/composition surface (Traderton owns its config, decision 2). It is therefore recorded as
an explicit **9b design decision** (§6 item 9), not a defect to fix during the copy phase.

There is **no crux/shape question that requires halting the handback**: the findings are
documentation corrections, one harness-hygiene note, and one deliberate 9b design decision —
none is a boundary or invariant risk to the copied foundation.

---

## 2. Evidence (build / lint / test — actually run)

Run in this repo, this review session (Node v22.22.3, pnpm 10.33.2):

| Command | Result |
|---------|--------|
| `pnpm build` (`pnpm -r run build`) | **GREEN** — all 8 packages compile strict (domain, db, engine, market-data, venues, strategy, backtesting, worker). Exit 0. |
| `pnpm lint` (`tsc --noEmit`) | **CLEAN.** Exit 0. |
| `pnpm test` (`vitest run`) | **2131 passed / 15 skipped / 0 failed** (119 test files passed, 5 skipped). Exit 0. |

The **15 skips are all credential-gated integration suites**, correctly skipping without a
live Postgres / venue credentials — they are a CI / Phase-10 obligation, not counted as Met
runtime validation:

- db: `journal-pg.integration.test.ts` (5), `position-repository.integration.test.ts` (4) — gated on `DATABASE_URL`.
- venues: `hyperliquid.integration.test.ts` (2), `bybit.integration.test.ts` (2), `oneinch.integration.test.ts` (2) — gated on venue credentials.

These counts match the ledger's post-9a claim (2131 / 15 / 0) exactly.

**Forbidden-import sweep (run across all live `packages/**/src/**/*.ts`):**
- `from '@herobids…'` imports: **ZERO.**
- `from '@herobids/llm'` / `from '@traderton/llm'`: **ZERO.**
- platform-coupling identifiers (`capability-policy`, `runtime-composition`, `agentConfigOps`,
  `CapabilityDenial`, `@aws-sdk`, `nodemailer`) as **imports**: **ZERO** in live code.
- All `@herobids` textual hits are verbatim source-citing **comments** or the one sanctioned
  test `describe()` string (`backtesting.test.ts:355`) — allowed under copy-never-author.
- No package.json declares a forbidden external dependency.

---

## 3. Fidelity findings (Audit A)

**Verdict: faithful. No fidelity defects.**

Verified directly (byte-diff modulo namespace):
- `packages/engine/src/risk-gate.ts` — **byte-identical**.
- `packages/engine/src/risk-gate.parity.test.ts` — **byte-identical** (the 83-test parity harness is unmodified).
- `packages/worker/src/tools/account.ts` — **byte-identical**; reads the `ctx.executionConfig` port (source-fix #3b), not `agentConfigOps`.
- strategy split: `llm.ts` / `llm-provider.ts` / `hybrid-strategy.ts` (+ tests) absent; mechanical files present.

Delegated broad per-file diff (semantic_reviewer, every surviving src file across all 8
packages incl. tests and both quarantine dirs): **no fidelity defects**. Coverage — domain 46,
db 39, engine 66, market-data 44 (44/44 byte-identical), venues 38, strategy 7, backtesting 14,
worker main 87, `_deferred-config` 9, `_deferred-authoring` 19. Every non-empty diff classifies
as benign scaffolding, sanctioned barrel trim, the sanctioned `userId`→`ownerId` soft-reference
seam (db), a documented Intentional Divergence, or a sanctioned seam relocation. No surviving
file lacks a herobids source counterpart.

Sanctioned seams confirmed as verbatim relocations (not authored shapes):
`scan-types.ts`, `watch-summary.ts`, `trading/trading-protocol.ts`, `trading/tool-contract.ts`,
`tool-schemas.ts`.

---

## 4. Findings by severity

No CRITICAL. No HIGH.

### MEDIUM-1 — Stale source-fix status: #3b is recorded as OPEN but is resolved

- **Where:** `docs/003-anomalies-and-deviations.md`, final row (source-fix request #3b).
- **What:** The row's decision cell reads *"OPEN — awaiting herobids owner."* In reality
  #3b was implemented and released: `apps/worker/src/tools/account.ts` in herobids now reads
  `ctx.executionConfig.getExecutionConfig()` (the trading-owned port), and Traderton's
  `packages/worker/src/tools/account.ts` is a byte-identical copy of it (verified). The
  `TradingToolContext.executionConfig` port is present in `packages/domain/src/trading/tool-contract.ts`.
  The 9a ledger block and the `get_account_summary` row already reflect the resolution;
  only doc 003's #3b row is stale.
- **Why it matters:** the anomalies log is the authority for source-fix status; a stale
  OPEN row implies an outstanding blocker that does not exist, and contradicts the ledger.
- **Recommended action:** update the #3b row to **RESOLVED**, noting the release and the
  verbatim `account.ts` copy. (Recorded here per the review guardrail; see §8.)

### MEDIUM-2 — Ledger subsystem row "Price-watch lifecycle" is stale (`Pending`, empty note)

- **Where:** `docs/001-parity-ledger.md`, Subsystems table, row `Price-watch lifecycle | Pending |` (empty notes).
- **What:** The watch lifecycle capability is substantially **Met**: the 5 watch tools
  (`watch_token`, `check_watches`, `list_watches`, `remove_watch`, `resolve_watch`) were
  copied verbatim in 9a (`tools/watch.ts` + `tools/resolvers.ts` + the `watch-summary.ts`
  seam), the threshold-evaluation **logic** (`isThresholdMet`, trigger detection) lives
  inside the copied `check_watches` tool, and `watch-types.ts` landed in Phase 8. The only
  uncopied piece is `apps/worker/src/market-intelligence/monitor.ts` — the **agent-wake push
  loop** (emits `agent.wake`, depends on `InstanceEventPublisher` / `AgentWakePayload`),
  which is platform (agent reasoning, decisions 7–9) and already classified Intentional
  Divergence via the Phase-8 `market-intelligence` deletion.
- **Why it matters:** a `Pending` row with no note reads as an un-accounted capability. The
  cutover gate "Inventory fully accounted for" cannot honestly pass while a substantively
  landed capability is marked `Pending`. This is exactly the "ledger status unsupported by
  code" class the review guards against — here, understating done work.
- **Recommended action:** update the row to **Met** (watch tools + evaluation logic +
  types) with a note that `monitor.ts`'s agent-wake push loop is Intentional Divergence
  (platform), cross-referencing the Phase-8 `market-intelligence` divergence. (Recorded per §8.)

### MEDIUM-3 — Copied tool parity tests are not type-checked against the Traderton surface

- **Where:** the 8 live tool tests `packages/worker/src/tools/{account,analytics,market-data,
  watch,find-instrument,price,resolvers,risk-limits}.test.ts` (and the quarantined
  `_deferred-authoring/schema.test.ts`), which `import type { ToolContext } from '@traderton/domain'`
  and reference platform fields (`phase`, `agentConfigOps`).
- **What:** `@traderton/domain` exports `TradingToolContext`, **not** `ToolContext` (the full
  platform contract was intentionally left in herobids). These tests are **faithful verbatim
  copies** — the stale `ToolContext` reference comes straight from herobids source. They pass
  at runtime because vitest strips the type-only import and the tests build plain objects.
  They do **not** fail the build/lint because every package `tsconfig.json` excludes
  `src/**/*.test.ts`, and `pnpm lint` (`tsc --noEmit` over the project references) therefore
  never type-checks any test file.
- **Why it matters:** it is not a fidelity or behaviour defect, but it means the tool parity
  harness is **not type-verified against the actual Traderton contract**. A drift between a
  tool's real context needs and the domain contract would not be caught by `tsc`. It is also
  an unstated consequence — the ledger implies tools were "narrowed to `TradingToolContext`"
  (the tool *sources* were; the *tests* still name the absent `ToolContext`).
- **Recommended action (9b, non-blocking now):** when the composition root lands in 9b, either
  narrow these copied tests' context import to `TradingToolContext` as part of un-quarantining
  / wiring (an authored test-harness adjustment, logged), or export a `ToolContext` alias from
  the Traderton domain surface. Until then, note the limitation so "tests green" is not read as
  "tests type-check against Traderton."

### LOW-1 — Barrel reshape in `packages/worker/src/tools/index.ts`

- **What:** the tool barrel is a documented **reshape** rather than a pure trim: the source
  barrel's `createToolRegistry` composition root + `assertToolCatalogMatchesRegistry` are not
  copied (deferred to 9b); the Traderton barrel re-exports the individual verbatim tool
  modules + the registry surface. Every re-exported symbol exists as a verbatim copy.
- **Why LOW:** a barrel is the one place a "trim" legitimately becomes a small authored shape,
  and this is fully documented in the file header and consistent with the 9a/9b split. Flagged
  only so 9b re-materializes `createToolRegistry` (+ the catalog assertion) as the copied/authored
  composition root.

### LOW-2 — Platform preset tools not explicitly in the Intentional Divergence table

- **What:** the source tool modules `assess-strategy-preset.ts` and `change-strategy-preset.ts`
  (registering `assess_strategy_preset` / `change_strategy_preset`) are not in the 006 25-tool
  inventory and are correctly dropped as platform (they depend on `tool-errors.ts` /
  `CapabilityDenial`, the dropped `PresetTransitionPort`, and market-assessment machinery — the
  agent preset-review concern, decisions 7–9). They are named as DELETE in the 9a plan but do
  not have an explicit row in the ledger's Intentional Divergence table.
- **Why LOW:** their disposition is correct and covered by the generic "platform tools = DELETE"
  classification; but because they are *strategy-preset-named* they could be mistaken for trading.
  A one-line Intentional Divergence entry would close the loop.

### LOW-3 — Known/ledgered verbatim string (no action)

- `packages/backtesting/src/backtesting.test.ts:355` — a `describe('@herobids/backtesting …')`
  regression label. Verbatim non-import string; the test asserts the correct Traderton
  package.json and passes. Already ledgered as LOW; left verbatim per copy-never-author. No action.

---

## 4b. Second-pass findings (folded in from the former addendum)

A second validation pass re-ran the baseline (identical result: `pnpm build` green, `pnpm lint`
clean, `pnpm test` **2131 passed / 15 skipped / 0 failed**) and re-checked several high-risk
surfaces against herobids. It raised four findings. Each was **re-adjudicated against the source**
(byte-diff, read-only) for this consolidated report. The facts are accurate; the key judgment is
whether each is an *authored defect* or a *faithful copy*. All four are faithful copies — so the
severities are re-tagged accordingly, and none reopens the copy-fidelity verdict.

### S-1 (re-tagged → 9b DESIGN DECISION; originally raised as HIGH) — mechanical-only is not enforced at the config boundary

- **Fact (verified):** `packages/domain/src/config/schema.ts` `StrategySchema.decisionMode` is
  `z.enum(['mechanical','llm','hybrid']).optional()`, and `packages/domain/src/config/schema.test.ts`
  has a passing test asserting `{ type: 'momentum', decisionMode: 'llm' }` parses. `BotConfigSchema`
  uses `StrategySchema`, so llm/hybrid strings pass domain config parsing. `StrategyIdentitySchema`'s
  `superRefine` returns early ("let the base schema handle it") when the registry has no entry, so
  `momentum:llm` is accepted at parse time.
- **Adjudication (verified against source):** this is a **faithful copy, not a defect.** herobids'
  `StrategySchema` is **identical** (`decisionMode: z.enum(['mechanical','llm','hybrid'])`), and
  herobids' `schema.test.ts` has the **identical** "accepts llm decisionMode" test. Traderton's
  `StrategySchema` block and test were copied verbatim. The mechanical-only guarantee is — by design
  — enforced one layer down and is already an Intentional Divergence: the registry never calls
  `registerAgentDecisionModes({ llm, hybrid })`, `validateStrategyParams` reports `momentum:llm` /
  `momentum:hybrid` unsupported, and `@traderton/strategy` exports only `MechanicalStrategy` /
  `DcaStrategy`. The decision log (source-fix #1) explicitly states that **narrowing
  `StrategySchema.decisionMode` is a consequential behavioural change requiring a signed-off
  Intentional Divergence — deliberately not done during the copy phase.**
- **Why not a pre-9b blocker:** removing `llm`/`hybrid` from the enum now would be *authored*
  subtraction of copied trading surface (violating copy-never-author + 1:1 diffability). Traderton
  owns its config (decision 2); the correct place to narrow the boundary is the **9b authored
  config/composition surface**, with sign-off. Recorded as **9b design decision (§6 item 9)**.

### S-2 (re-tagged → LOW; originally MEDIUM) — `get_schema` still advertises `change_strategy_preset`

- **Fact (verified):** `packages/domain/src/tool-schemas.ts` retains the `change_strategy_preset`
  schema entry; the copied `get_schema` tool enumerates all registered entries.
- **Adjudication:** `tool-schemas.ts` is a **faithful copy** — its only divergence is the *omission*
  of three platform entries (`publish_artifact.*`, `execute_code.dependencies`) with an Intentional
  Divergence comment. The `change_strategy_preset` entry is present in the herobids source and was
  retained verbatim. Trimming it now would be authored surgery on a copied file. It is
  **faithful-copy residue** to reconcile when 9b authors the tool catalog / get-schema surface
  (where "which schemas are advertised" is a composition-layer decision). Not a copy defect.
  Cross-references LOW-1 (the deferred `createToolRegistry` / catalog surface).

### S-3 (re-tagged → LOW; originally MEDIUM) — `resolvers.ts` also exports the non-trading `resolve_task`

- **Fact (verified):** `packages/worker/src/tools/resolvers.ts` exports `resolve_task` alongside
  `resolve_bot` / `resolve_watch`, and `resolvers.test.ts` tests it; `resolve_task` is not in the
  006 25-tool inventory.
- **Adjudication:** `resolvers.ts` is **byte-identical to source modulo namespace** — `resolve_task`
  rides along in the same verbatim module. No trading tool is missing; the live copied surface is
  merely not yet trimmed to trading-only. Trimming it now = authored edit of a verbatim copy.
  **Faithful-copy residue** to reconcile at 9b (the composition layer chooses which tools the catalog
  exposes). Not a copy defect.

### S-4 (confirmed → already covered) — `@traderton/worker` has no usable public surface

- Same observation as the §7 coherence caveat / §6 item 2 (empty `src/index.ts`; composition root is
  9b). No new information; retained for completeness.

**Net effect of the second pass:** it strengthens the evidence base and surfaces one genuine design
question (S-1). It does **not** downgrade the copy-fidelity verdict and does **not** introduce a
pre-9b blocker. S-1 becomes an explicit, signed-off 9b decision; S-2/S-3 become faithful-copy
residue reconciled at the 9b composition layer; S-4 is already tracked.

---

## 5. Inventory reconciliation (006 → 001 → evidence)

### 5.1 The 25 trading tools

| Tool | 001 disposition | Evidence (verified) |
|------|-----------------|---------------------|
| `submit_decision` | Deferred (required for cutover) — engine core Met; tool+intake 9b | Engine `submitDecisionForExecution`/planner/risk-gate/executors Met (Phase 3). Tool `tools/trading.ts` NOT copied — uses `AGENT_MESSAGE_TYPES.DECISION_SUBMIT` via `publishToInbound` (drive path). |
| `create_bot` | Deferred (9b — drive path + per-owner limit) | `tools/bots.ts` NOT copied — `AGENT_MESSAGE_TYPES.MANAGE_BOT` drive path. |
| `start_bot` | Deferred (required for cutover) — limit | Same as `create_bot`. |
| `stop_bot` | Deferred (9b — drive path) | In `tools/bots.ts` (not copied). |
| `list_bots` | Deferred (9b — drive path) | In `tools/bots.ts` (not copied). |
| `resolve_bot` | **Met (9a)** | `tools/resolvers.ts` copied verbatim; tests green. |
| `get_bot_status` | Deferred (9b — drive path) | In `tools/bots.ts` (not copied). |
| `adjust_bot_config` | Deferred (9b — drive path) | In `tools/bots.ts` (not copied). |
| `adjust_risk_limits` | **Met (9a)** | `tools/risk-limits.ts` verbatim; tests green. |
| `get_risk_limits` | **Met (9a)** | `tools/risk-limits.ts` verbatim; tests green. |
| `get_account_summary` | **Met (9a)** | `tools/account.ts` verbatim via #3b `executionConfig` port; tests green. |
| `list_positions` | **Met (9a)** | `tools/analytics.ts` verbatim; tests green. |
| `get_price` | **Met (9a)** | `tools/price.ts` verbatim; tests green. |
| `get_funding_rates` | **Met (9a)** | `tools/market-data.ts` + `intelligence-tools.ts` verbatim; tests green. |
| `get_market_overview` | **Met (9a)** | `tools/market-data.ts` + `intelligence-tools.ts` verbatim; tests green. |
| `get_analytics` | **Met (9a)** | `tools/analytics.ts` verbatim; tests green. |
| `check_regime` | **Met (9a)** | `tools/market-data.ts` verbatim; tests green. |
| `discover_tokens` | **Met (9a)** | `tools/market-data.ts` + `intelligence-tools.ts` verbatim; tests green. |
| `search_tokens` | **Met (9a)** | `tools/market-data.ts` verbatim; tests green. |
| `find_instrument` | **Met (9a)** | `tools/find-instrument.ts` verbatim; tests green. |
| `watch_token` | **Met (9a)** | `tools/watch.ts` (+ `watch-summary.ts` seam) verbatim; tests green. |
| `check_watches` | **Met (9a)** | `tools/watch.ts` verbatim (threshold-eval logic included); tests green. |
| `list_watches` | **Met (9a)** | `tools/watch.ts` verbatim; tests green. |
| `remove_watch` | **Met (9a)** | `tools/watch.ts` verbatim; tests green. |
| `resolve_watch` | **Met (9a)** | `tools/resolvers.ts` verbatim; tests green. |

**18/25 Met (copied verbatim); 7/25 Deferred to 9b (all drive-path / intake — genuine
authoring blockers, verified). No tool is silently dropped or unaccounted.**

### 5.2 Mandatory subsystem groups (006)

| Subsystem group | 001 disposition | Evidence (verified) |
|-----------------|-----------------|---------------------|
| Risk gate | **Met** | `risk-gate.ts` byte-identical; 83 parity tests unmodified green. |
| Venue adapters | **Met** (unit; integration credential-gated) | 40 files verbatim (Phase 5); 177 unit green; 6 integration credential-gated (skip). |
| Trading loop | **Met** (modules; composition Deferred-required) | Engine `runTradingCycle`/intake/planner/executors/reconcile (Phase 3) + scan front-end (Phase 4/6) + worker loop modules (Phase 8, 681 tests). Composition root → 9b. |
| Position & equity tracking | **Met** | position/swap/equity/daily-loss trackers + rehydrate verbatim (Phase 3). |
| Watch lifecycle | **Met** (see MEDIUM-2) | watch CRUD tools + eval logic + types landed; agent-wake `monitor.ts` = Intentional Divergence. **Ledger's `Price-watch lifecycle` row is stale (Pending) — MEDIUM-2.** |
| Market data & discovery | **Met** | 44 files verbatim (Phase 4); 354 tests green. |
| Backtesting & replay | **Met** | 13 files verbatim (Phase 7); 49 tests green. |
| Trading data model | **Met** (schema + repositories) | 23 trading tables (Phase 2); soft-`ownerId` seam; 11 unit green + 9 integration credential-gated. |
| Mechanical strategies (`Dca`/`Mechanical`/`scan-engine`/`regime`) | **Met** | strategy mechanical slice + market-data regime/indicators verbatim; 56 + tests green. LLM/Hybrid = Intentional Divergence. |

Every 006 inventory row has a 001 disposition. The only accounting corrections are MEDIUM-1
(#3b status), MEDIUM-2 (Price-watch row), and LOW-2 (preset tools) — all documentation, not code.

---

## 6. The bounded 9b authoring list

This is the definitive, itemized set of authored work for 9b. Each item states **what it is**,
**why it must be authored** (not copyable), the **ledger row(s) it resolves**, the
**invariant(s) it must honor**, and the **quarantined file(s) it un-quarantines**. Nothing
beyond this list is authoring; everything else already arrived by copy.

**Global invariant for all 9b items (000/004):** *ports carry values, never trading behaviour.*
The risk gate, planner, executors, reconciliation, and fill/position accounting are Traderton's
(already copied, engine-owned) and MUST NOT become injectable/overridable through any authored
seam. The authored layer only **wires and injects values**. Also: **M1 in-process composition
before M2 REST**; per-`ownerId` is the limit key.

1. **Traderton-owned config shape** — `AppConfig` / `AppConfigSchema` / `AgentRiskDefaultsConfig`
   (the worker `config.ts` loader shape + `public-stream-routing.ts` config).
   - *Why authored:* herobids' `config.ts`/`AppConfig` is the platform config monolith; Traderton
     owns its config (decision 2). No faithful copyable subset exists.
   - *Resolves:* the Phase-8 `Deferred (required for cutover)` config-shape entry (trading loop row).
   - *Invariant:* operator vs instance layering; user-configured limits immutable at runtime
     (decision 3). Config is a value surface, not behaviour.
   - *Un-quarantines:* `_deferred-config/config.ts`, `config.test.ts`, `agent-risk-limits.ts`,
     `agent-risk-limits.test.ts`, `agent-risk-limits.parity.test.ts`, `public-stream-routing.ts`,
     `public-stream-routing.test.ts`.

2. **Trading composition root** — the in-process wiring that constructs the actors + `WorkerRuntime`
   + tool registry (replacing herobids `apps/worker/index.ts`) and the currently-empty
   `packages/worker/src/index.ts` public barrel + `tools/index.ts` `createToolRegistry` (LOW-1).
   - *Why authored:* the actors are constructed inside deleted startup/session/intake wiring;
     herobids `index.ts` has no faithful subset (confirmed Phase 8).
   - *Resolves:* the Trading loop row's "assembled runtime / composition Deferred-required."
   - *Invariant:* wire only — do not re-implement any engine primitive; re-materialize
     `assertToolCatalogMatchesRegistry` against the trading tool catalog.
   - *Un-quarantines:* makes `@traderton/worker` consumable through its public barrel (§7 caveat).

3. **Decision-intake / approval / session surface** — the venue-account-direct binding resolver,
   `submit_decision` intake wiring, and human approve/reject, driving the engine core in-process.
   - *Why authored:* herobids' `agent-intake-resolver` cluster is built on the dropped
     `connections`/`agentConnections` grant model + Telegram approval/session-ownership; a
     venue-account-direct resolver is authored, not copied (Phase-8 reclassification DELETE).
   - *Resolves:* `submit_decision` intake surface (Deferred-required); the reclassified 5-file cluster.
   - *Invariant:* the resolver takes an **injected `venueAccountId`** (consumer resolves grants
     + connection-status guards; Traderton runs only the venue-account guards it owns). Intake
     drives, it does not execute — execution stays in the engine.

4. **The 7 drive-path tools** — `tools/trading.ts` (`submit_decision`) and `tools/bots.ts`
   (`create_bot` / `start_bot` / `stop_bot` / `list_bots` / `get_bot_status` / `adjust_bot_config`).
   - *Why authored (partly copyable):* the tool bodies are copyable **verbatim** once the intake
     drive surface exists — their only Traderton-absent dependency is `AGENT_MESSAGE_TYPES`
     (a mixed agent-messaging enum intentionally not brought in) used via `publishToInbound`.
     9b authors the drive/intake target these publish to, then copies the tool modules. (All other
     domain symbols `bots.ts` needs — `checkModeEscalation`, `deriveStrategyPreset`,
     `extractStrategyFromConfig` — are already in the Traderton domain barrel; **no further
     source-fix is required**.)
   - *Resolves:* the 7 Deferred tool rows in §5.1.
   - *Invariant:* the drive path carries a decision **value** to Traderton's owned intake; it
     does not let the caller inject planning/risk/execution.

5. **Per-`ownerId` `maxBots` enforcement** — the limit-enforced `create_bot`/`start_bot` path.
   - *Why authored:* herobids' limit is `agents.maxBots`/`plan.entitlements`-keyed (platform);
     the atomic `BotRepository` limit methods were deleted in Phase 2. The per-`ownerId` key is
     a Traderton tenancy decision (decided 2026-09-06), authored here.
   - *Resolves:* the `create_bot`/`start_bot` `Deferred (required for cutover)` sub-capability;
     the cutover gate "All Deferred (required for cutover) entries resolved."
   - *Invariant:* the **limit decision** may be injected as a value by the consumer at M1; the
     enforcement point is Traderton's. Must not ship weaker than herobids-today.

6. **The 10 API route handlers** — `bots`, `accounts`, `analytics`, `backtests`, `credentials`,
   `reconciliation`, `actor-health`, `exports`, `datasets`, `capabilities/trading`.
   - *Why authored:* each is blocked on (a) the platform auth augmentation `request.userId`,
     (b) the `userId`→`ownerId` soft-reference adaptation (the copied handlers reference
     `bots.userId`/`datasets.userId` columns that no longer exist — verified), and/or (c) the
     9b config shape + platform tables. Adapting a copied handler is an authored edit.
   - *Resolves:* the API-surface rows; part of the M2 adapter.
   - *Invariant:* these belong to **M2** (REST), sequenced after M1 in-process composition.
   - *Un-quarantines:* `_deferred-authoring/api-routes/*` (handlers + their tests).

7. **The M2 REST/boundary adapter** — the Fastify app shell, auth/HMAC, idempotency, deadline,
   health, and the `POST /internal/v1/tools:invoke` surface per
   [005-consumer-boundary-contract.md](../../docs/005-consumer-boundary-contract.md).
   - *Why authored:* boundary infrastructure is legitimately new seam code (the HTTP expression
     of the M1 ports), never copied trading logic.
   - *Resolves:* "Consumer boundary contract validated" cutover gate.
   - *Invariant:* the adapter is a driver over the **same ports** as M1; it injects values, not
     behaviour; unknown tool/payload/envelope → terminal validation failure before side effects.

8. **Test-harness reconciliation (small, 9b)** — narrow the copied tool tests' `ToolContext`
   import to `TradingToolContext` (or export a `ToolContext` alias) so the tool parity harness
   type-checks against the Traderton surface (MEDIUM-3); un-quarantine `_deferred-authoring/schema.test.ts`
   and `_deferred-config/{tick-gates,validate-trade-instrument}.test.ts` once their deferred
   subjects (market-event digest types, `tools/trading.ts`) land.

9. **Mechanical-only boundary decision (design decision; from second-pass S-1)** — decide, and
   record with sign-off, how Traderton enforces mechanical-only at its **own** config boundary.
   - *Why authored / why 9b:* the copied `StrategySchema` inherits herobids' permissive enum
     (`mechanical | llm | hybrid`). Narrowing it is a consequential behavioural change the decision
     log reserves for a signed-off Intentional Divergence — not a copy-phase edit. Traderton owns
     its config (decision 2), so the narrowing (if chosen) belongs to the authored config surface.
   - *Resolves:* the mechanical-only Intentional Divergence row (config-boundary half); makes the
     "green tests" claim backed by an explicit product-level guarantee rather than inherited source
     behaviour.
   - *Options (DECIDED 2026-09-07, human): **option (a) — narrow-and-diverge**.*
     - **(a) Narrow-and-diverge (CHOSEN):** tighten the Traderton-owned config schema (or a
       Traderton wrapper over the copied `StrategySchema`) to `decisionMode: ['mechanical']`, and
       update the copied acceptance test accordingly — a sanctioned authored divergence at the
       boundary Traderton owns. Crispest product guarantee. See [004](../../docs/004-decision-log.md).
     - **(b) Accept-and-reject-downstream (not chosen):** keep the copied enum; rely on the registry
       rejecting `momentum:llm` / `momentum:hybrid` at `validateStrategyParams` / bot start.
   - *Invariant / process check:* add an explicit assertion that the **live** mechanical-only
     guarantee holds at whatever boundary Traderton chooses to own (dovetails with item 8 /
     MEDIUM-3 — the harness must type-check and assert against the Traderton surface, not inherit
     source permissiveness). The risk gate / planner / executors remain engine-owned regardless.

**Not 9b, not copy-and-delete:** Phase 10 (infra) — shared versioned Terraform module, consumed
at a pinned version (doc 012). Out of scope here.

---

## 7. Coherence caveat (by design — not a defect)

`packages/worker/src/index.ts` is `export {};` and the package `exports` field points to an empty
`dist/index.js`. The worker loop modules and the 18 copied tools build and are reachable only via
deep paths; **`@traderton/worker` is not consumable through its public barrel yet.** This is the
deferred composition root (9b item 2), not a gap. The lower seven packages (domain → venues /
backtesting) expose populated barrels and are consumable in-process today. The M1 library's public
surface is realized when 9b authors the composition root + barrel.

---

## 8. Ledger / anomaly corrections recommended (record, do not silently fix)

Per the review guardrail (§5 of the instruction: "update 001/003 only if the review uncovers an
inaccuracy to correct — record, don't silently fix"), the following inaccuracies are **recorded
here** and should be corrected in place:

1. **`docs/003` #3b row** → change status from *"OPEN — awaiting herobids owner"* to **RESOLVED**
   (account.ts copied verbatim via the released `executionConfig` port). [MEDIUM-1]
2. **`docs/001` Subsystems row `Price-watch lifecycle`** → change from `Pending` (empty) to **Met**
   (watch tools + eval logic + types), noting `market-intelligence/monitor.ts` agent-wake loop is
   Intentional Divergence. [MEDIUM-2]
3. **`docs/001` Intentional Divergence table** → add an explicit row for the platform preset tools
   `assess_strategy_preset` / `change_strategy_preset`. [LOW-2]
4. **`docs/001` mechanical-only Intentional Divergence row + `docs/004`** → record that the
   config-boundary half of the mechanical-only divergence is *deliberately deferred*: the copied
   `StrategySchema` still accepts `llm`/`hybrid` (faithful copy), enforcement lives at the registry
   layer, and the config-enum narrowing is a signed-off **9b design decision** (§6 item 9). [S-1]

Applied during consolidation (with review attribution, not silent): items 1–4 have been recorded
in `docs/001` / `docs/003` / `docs/004`. They are documentation-only and do not touch product code.

---

## 9. Handback

- **Verdict:** M1 pre-authoring library is sound and complete-as-possible. **Proceed to 9b.**
- **Blocking findings:** none. No CRITICAL/HIGH copy-fidelity defects. The MEDIUM + LOW items are
  documentation-accuracy and harness-hygiene; the second-pass items (§4b) are faithful-copy residue
  or a deliberate design decision, not defects.
- **One deliberate 9b design decision:** the mechanical-only config-boundary narrowing (§4b S-1 /
  §6 item 9) — decide (option a or b) and sign it off as part of 9b's authored config surface. It is
  explicitly *not* a copy-phase edit and *not* a pre-9b blocker.
- **9b scope:** precisely bounded in §6 (9 authored items + the un-quarantine map). No further
  herobids source-fix is required to copy the 7 drive-path tools.
- **Single doc of record:** this file consolidates both review passes; the separate addendum has
  been removed.
- **Next step is the human's go-ahead.** 9b proceeds only on approval, honoring the ports-carry-values
  invariant and M1-before-M2 sequencing.
