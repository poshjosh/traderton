# Parity Ledger

**Status:** living
**Purpose:** track every source-system trading capability against its status in
Traderton. Feature parity is the standard (see [000-vision.md](./000-vision.md)).
The source repo (`herobids`) is the specification. We may improve, not degrade.
The exhaustive source inventory lives in
[006-source-capability-manifest.md](./006-source-capability-manifest.md); this
ledger carries the live status against that inventory.

## Status meanings

| Status | Meaning |
|--------|---------|
| **Pending** | In inventory, but not yet copied or verified. Transitional status before work reaches that slice. |
| **Met** | Reproduced; verified against source behaviour (copied code + copied tests green). |
| **Improved** | Reproduced and made better. Note what changed and why. |
| **Deferred (optional)** | Deliberately not done yet, with **no herobids parity obligation** (genuinely new/nice-to-have, e.g. bot cloning). May remain unbuilt without harm. Note reason. |
| **Deferred (required for cutover)** | Deliberately not done yet, but herobids will **rely on Traderton to provide it** in the end state (see "herobids becomes a consumer" in [000](./000-vision.md)). Deferred only in *when*, not *whether* — **blocks cutover until resolved.** Note reason + the tool/subsystem row it belongs to. |
| **Gap** | Attempted; fell short. Note exactly what is missing and why. Requires sign-off. |
| **Intentional divergence** | Source behaviour deliberately NOT copied because it was platform coupling, not trading capability. Note the seam. |

Rules: nothing is silently dropped — every source capability appears here.
Nothing regresses without an explicit **Gap** entry that someone signed off.

## Ledger

### Phase 1 (domain slice) — DONE

**Status: DONE.** The `@traderton/domain` trading slice compiles under strict TS, lint is clean, and all copied domain parity tests pass (230). No platform imports remain in the slice; no `@herobids` references; no LLM coupling.

**Phase 2 (`db`): DONE** — see "Trading data model" row (Met) + the Phase 2 Intentional Divergence rows. `@traderton/db` compiles strict, lint clean, copied unit tests green (11 pass; 9 integration gated on DATABASE_URL), fresh initial migration generated, no platform imports/FKs.

**Next action:** Phase 3 (`engine`), per the roadmap [009-extraction-roadmap.md](./009-extraction-roadmap.md). `engine` is a clean-package phase, domain-only (137 imports all via domain ports). Phases 3–10 governed by 009; execute each via its per-phase pattern, honoring the stop-gates.

**Phase 1 evidence:**

- Workspace shell scaffolded (pnpm workspace, strict TS ES2022 ESM, vitest) mirroring herobids toolchain (Node ≥22, pnpm 10.33.2). `git init` done for delete-visibility.
- `@herobids/domain` copied verbatim (97 files) and renamed to `@traderton/domain`. Trading `config/strategy-presets/*.yaml` copied. **Verbatim-copy baseline was green: 981/981 tests, build + lint clean** (the parity harness).
- Leaf-first platform deletions completed cleanly (build green after each): removed `agent-evaluation`, `agent-goal`, `assessment-billing`, `plan-entitlements`, `platform`, `provider-catalog`, `runtime-composition`, `skills*`, `skill-resolution`, `tools`, `tool-schemas`, `llm-selection`, `external-skill-provider-http`, `text-search`, `review-pre-check`, `browser-pool-feature.test`, dirs `email/ infra/ skills/ __tests__/`, platform ports (`assessment-identity-resolver`, `assessment-request`, `preset-transition`, `blueprint-execution-capability`, `browser-pool`, `document-store`, `document-text-extractor`, `runtime-document-materializer`, `runtime`, `external-skill-provider`), `models/llm-models`. Barrels (`index.ts`, `ports/index.ts`, `models/index.ts`) trimmed accordingly.
- Config seam RESOLVED: `config/schema.ts` reduced to trading-only (2568→844 lines, 77 exports) by clean leaf-first in-place deletions — no authored restructuring. Removed the `WakePreferences`/`agent-protocol` seam, then (after `blueprint.ts` deletion freed the agent-policy schemas and herobids source-request #1 freed the LLM schemas) all platform schemas: AppConfig, agent-runtime-policy island, LLM block, billing/plans, auth, alerts/telegram/gmail, nomad/sharedServices, worker/services/browser/http/sessionCircuit/agentRuntime(+Policy), marketIntelligence, platformAssessment*, evaluation, Intelligence/UnifiedAgent/preset/capability/hybrid schemas, WakeGate, validateReviewInterval, and agent `PermissionLevel`/`AgentStyle`. Details in [003](./003-anomalies-and-deviations.md).
- Deleted `blueprint.ts` + `blueprint.test.ts` (platform marketplace/authoring — Intentional Divergence, confirmed not on the trading path).
- Strategy-registry seam RESOLVED via herobids source-request #1 (commit `648f9110`, released). Traderton copies a mechanical-first registry and omits the `registerAgentDecisionModes({llm,hybrid})` call → mechanical-only (`mechanical`+`dca`); `momentum:llm`/`momentum:hybrid` unsupported (Intentional Divergence). See [003](./003-anomalies-and-deviations.md).
- **No open herobids requests.** (#2 was withdrawn — `blueprint.ts` is platform marketplace, not the trading path; bots use `BotConfigSchema`, execution path is blueprint-free.)
- **Domain slice green: build + lint clean, 230 copied tests pass.** Surviving trading files match the Phase 0 COPY list (trading/, values/, named ports, result/enums/pagination/scanner-types/cost-profile, agent-risk-contract, market-assessment, models/decision, config trading schemas + strategy-parameters + presets).

### Cross-cutting

| Capability (from source) | Area | Status | Notes |
|--------------------------|------|--------|-------|
| Traderton-native usage metering / payments / caps | cross-cutting | Deferred (optional) | Platform billing authority stays outside Traderton by design. Service-owned metering, billing, and caps are cut for initial extraction and can return later. No herobids parity obligation (platform keeps its own billing). |
| Bot reproduction / cloning (Traderton-native) | cross-cutting | Deferred (optional) | **New Traderton-native capability, not a source parity item.** Reproduce/clone a bot from its stored `BotConfigSchema` recipe (strip instance-only fields `venueAccountId`/`connectionId`/`status`; create a new bot bound to a venue account). Built on `BotConfigSchema`; does NOT require the platform blueprint marketplace machinery. Intended from day one; to be designed/built in a later phase, not authored during Phase 1. See [004](./004-decision-log.md). |

### Trading tools (25 — authority:
[006-source-capability-manifest.md](./006-source-capability-manifest.md))

| Tool | Status | Notes |
|------|--------|-------|
| `submit_decision` | Pending | Decision execution — highest-stakes parity surface. |
| `create_bot` | Pending | **`Deferred (required for cutover)` sub-capability:** limit-enforced bot creation. herobids' per-agent maxBots (agents-row-locked) is Intentional Divergence (platform, not copied — deleted from `@traderton/db` BotRepository, Phase 2). Traderton must provide limit-enforced creation via this tool before cutover (herobids will rely on it); limit key (per-owner / per-venue-account / operator config) decided in the bot-lifecycle phase (worker/api). See [004](./004-decision-log.md) + [003](./003-anomalies-and-deviations.md). |
| `start_bot` | Pending | **`Deferred (required for cutover)` sub-capability:** limit-enforced bot start (was `tryMarkBotRunningWithLimit`, agents-row-locked → Intentional Divergence, deleted Phase 2). Same obligation as `create_bot`. |
| `stop_bot` | Pending | |
| `list_bots` | Pending | |
| `resolve_bot` | Pending | |
| `get_bot_status` | Pending | |
| `adjust_bot_config` | Pending | |
| `adjust_risk_limits` | Pending | Risk policy — parity must be exact. |
| `get_risk_limits` | Pending | |
| `get_account_summary` | Pending | |
| `list_positions` | Pending | |
| `get_price` | Pending | |
| `get_funding_rates` | Pending | |
| `get_market_overview` | Pending | |
| `get_analytics` | Pending | |
| `check_regime` | Pending | |
| `discover_tokens` | Pending | |
| `search_tokens` | Pending | |
| `find_instrument` | Pending | |
| `watch_token` | Pending | |
| `check_watches` | Pending | |
| `list_watches` | Pending | |
| `remove_watch` | Pending | |
| `resolve_watch` | Pending | |

### Subsystems (authority:
[006-source-capability-manifest.md](./006-source-capability-manifest.md))

| Capability | Status | Notes |
|------------|--------|-------|
| Domain slice (`@traderton/domain`: trading config schemas, values, ports, models/decision, result/enums/pagination, scanner-types, cost-profile, agent-risk-contract, market-assessment, strategy-parameters, presets) | Met | Phase 1 landed. Copied from herobids + platform slices deleted; strict-TS compile + lint clean; 230 copied parity tests pass. This is the domain layer only — the engine/venues/market-data/db/runtime that *consume* these types remain future phases (rows below stay Pending). |
| Risk gate (all rules, hard invariants, user vs operator defaults) | Pending | `packages/engine/risk-gate.ts` + parity test. |
| Venue adapters (Hyperliquid, Bybit, Jupiter, 1inch) | Pending | order types, streams, mark sources, rate limits. |
| Trading loop (scan→decision→plan→risk→execute→fill→reconcile) | Pending | |
| Position / equity trackers | Pending | |
| Price-watch lifecycle | Pending | |
| Market data / discovery | Pending | Indicators and discovery inputs only, no LLM. Moves to Traderton. |
| Backtesting / replay | Pending | |
| Trading data model (tables listed in Phase 0) | Met (schema + repositories) | **Phase 2 landed** (`@traderton/db`). 23 trading tables copied (trading-core verbatim, all soft-linked); 7 identity FKs → soft `ownerId`, `bots.connectionId` dropped (decisions 10–13 + soft-reference rule, 004); 3 intra-trading FKs preserved. Trading repositories copied (journal-pg, repositories.ts Fill/Position/ExecutionPlan/Order/BalanceSnapshot/Decision/Bot, reconciliation, backtesting, instrument, token-safety-override, decision-approval, decision-failure, llm-artifact). Platform schema/repos deleted. Fresh initial migration `0000_init_trading_schema.sql` generated (herobids migration history not copied — decision 1). Build + lint + copied unit tests green (11 pass). **Note:** 9 db integration tests (`journal-pg`, `position-repository`) are gated on `DATABASE_URL` (skip without a live Postgres) — they must run against Postgres in CI to validate the `ownerId` renames end-to-end (Phase 10 / CI concern). Row is Met for schema+repository extraction; runtime DB validation pending CI. |
| Mechanical strategies (`Dca`, `Mechanical`, `scan-engine`, `regime`) | Pending | Move to Traderton (no LLM). Domain-config foundation landed in Phase 1 (`MechanicalParamsSchema`, indicator/technical schemas, mechanical-only strategy registry); the `packages/strategy` implementation is a future phase. |

### Risk gate — exact rules (highest-stakes parity surface)

Source: `packages/engine/src/risk-gate.ts`, `checkRisk()`. Pure function.
Risk-reducing plans (`close`/`reduce`) bypass entry-side checks. Each rule must
reproduce its exact error code.

| # | Rule | Error code | Status |
|---|------|-----------|--------|
| 1 | Max drawdown (absolute USD) | `risk.max_drawdown_exceeded` | Pending |
| 1a | Max drawdown % (peak→current equity) | `risk.max_drawdown_pct_exceeded` | Pending |
| 1b | Daily max loss % (rolling 24h) | `risk.daily_max_loss_exceeded` | Pending |
| 1c | Stop-loss cooldown | `risk.stop_loss_cooldown` | Pending |
| 2 | Max open positions (on open) | `risk.max_open_positions_exceeded` | Pending |
| 3 | Max position size (resulting) | `risk.max_position_size_exceeded` | Pending |
| 3b | Max position size % of equity | `risk.max_position_size_pct_exceeded` | Pending |
| 4 | Max order notional | `risk.max_order_notional_exceeded` | Pending |
| — | Missing mark for notional | `risk.no_mark_for_notional` | Pending |

Note: `dailyMaxLossPct`/`maxDrawdownPct` are the agent-facing %-based controls;
`maxDrawdown` (absolute USD) is preserved for non-agent flows. Notional checks
use the worst-case of `referenceMark` vs `order.price`.

### Venue adapters — capabilities

Source: `packages/venues`. Each carries order ops + streams + confirmation.

| Adapter | Kind | Status | Notes |
|---------|------|--------|-------|
| Hyperliquid | perp/orderbook | Pending | adapter + public/private streams + mark source. |
| Bybit | perp/orderbook | Pending | adapter + public/private streams. |
| Jupiter | swap (Solana) | Pending | swap adapter + confirmation poller + Solana signer. |
| 1inch | swap (EVM) | Pending | swap adapter + EVM confirmation + EVM signer. |
| PublicStreamPool | shared streaming | Pending | worker-scoped shared WS connections. |
| Mark sources | Oracle, Hyperliquid | Pending | |
| Rate limiter | token bucket | Pending | per-venue. |
| Wallet generation | EVM/Solana | Pending | |
| Candle fetcher | Gecko | Pending | |

### Engine subsystems (packages/engine)

| Subsystem | Status | Notes |
|-----------|--------|-------|
| Order manager + order-state machine | Pending | transitions, fills. |
| Planner (`planDecision`) | Pending | decision → execution plan. |
| Executors: Paper / Shadow / Live / SwapLive | Pending | incl. live timeout mgr + recovery. |
| Position tracker + swap position tracker | Pending | |
| Fill accounting | Pending | |
| Equity tracker + daily-loss tracker + rehydrate | Pending | feeds risk gate. |
| Stop-loss monitor + per-trade-level validator | Pending | |
| Circuit breaker (per venue) | Pending | |
| Fee simulator + paper slippage | Pending | |
| Journal (event types) | Pending | decision/plan/order/fill/risk/live/credential events. |
| Trading cycle (`runTradingCycle`) | Pending | the orchestration loop. |
| Decision intake (`submitDecisionForExecution`) | Pending | + context-hash guard. |
| Instrument executor (`executeDecision`) | Pending | |
| Reconciliation (orderbook + swap loaders) | Pending | drift detection + thresholds. |
| Wake gate | Pending | |
| Mark source / mark selector | Pending | fill-first mark source. |

### Intentional divergence

Source behaviour deliberately NOT copied because it was platform coupling or a
resolved design decision — not a trading capability. Recorded so parity review
sees it explicitly; none is a silent drop.

| Source behaviour | Divergence | Rationale |
|------------------|-----------|-----------|
| Trading coupled to platform `users` + platform billing tables | Not owned by Traderton | Traderton is multi-tenant but not the identity/platform-billing authority; accepts authenticated `ownerId` + `actor` at the boundary (decision 10). |
| `connections` / `agent_connections` grant layer | Stays platform | Grant/entitlement is platform-owned; Traderton binds bots directly to `venueAccountId` (decisions 11, 13). |
| herobids per-agent maxBots enforcement (`BotRepository.tryCreateBotWithLimit` / `tryMarkBotRunningWithLimit`, row-locking the `agents` table) | Platform implementation not copied (deleted Phase 2) | The per-agent limit keyed on `agents` + agent-row-lock is platform concurrency policy; only the platform agent-broker/worker call it. Deleted from `@traderton/db`. The *capability* (limit-enforced bot creation/start) is trading and tagged **`Deferred (required for cutover)`** on the `create_bot`/`start_bot` rows — Traderton must provide it before cutover (see those tool rows + [004](./004-decision-log.md)). This is the "capability trading, implementation platform-coupled" case from the herobids-becomes-a-consumer model. |
| `bots.userId`/`venue_accounts.userId`/`user_credentials.userId`/`backtest_runs.userId`/`replay_corpora.userId`/`datasets.userId` hard FKs to `users`; `bots.connectionId` FK to `connections` | Converted to soft `ownerId` / dropped (Phase 2) | Soft-reference rule ([004](./004-decision-log.md)): Traderton doesn't own user identity (decision 10); every copied table's `users` FK → soft `ownerId`; `bots.connectionId` dropped, bots bind via `venueAccountId` (decision 13). Sanctioned authored seam, not a gap. |
| Bots could run `LlmStrategy` / `HybridStrategy` | Traderton bots are **mechanical-only** (`mechanical`, `dca`) | Intelligence is the agent's job. LLM/Hybrid decision-making relocates to the agent, which submits decisions via the boundary (decisions 7–9). Config-validation form: the strategy registry that moves to Traderton registers only `mechanical`+`dca` (the `llm`/`hybrid` modes + `LlmParams`/`HybridParams` stay agent-side — herobids source-request #1 in [003](./003-anomalies-and-deviations.md)); `StrategySchema.decisionMode` narrows to the mechanical set. Same decision, seen from config. |
| `blueprint.ts` (whole file — marketplace/authoring: agent+bot revision payloads, publish/fork/browse, revisions, popularity) | Stays platform; **`blueprint.ts` not copied into Traderton** | Confirmed 2026-09-05: blueprint.ts is the marketplace/authoring layer, not the trading path — bots are created/validated/executed via `BotConfigSchema`, and the bot execution path is blueprint-free (see [003](./003-anomalies-and-deviations.md), [004](./004-decision-log.md)). The trading config Traderton owns (`RiskPosture`, `BotRisk`, `ExecutionDefaults`, `TokenSafety`, `BotConfigSchema`) lives in `config/schema.ts`, not blueprint.ts, so decision 14's "risk/execution/token-safety schema slice" is satisfied without copying blueprint.ts. 1:1 parity preserved by deleting the platform file, not repurposing it. |
| market-assessment platform orchestration + platform billing | Left behind (Intentional divergence + Deferred) | Only the domain/analysis is trading-owned; platform-side billing stays outside Traderton, while Traderton-owned usage metering remains Deferred (decision 15). |
| Traderton-native usage metering / payments / caps | Deferred (see Cross-cutting) | Cut for initial extraction. |

## Cutover Sign-Off

This section is the aggregate production cutover gate. The inventory authority
remains [006-source-capability-manifest.md](./006-source-capability-manifest.md),
the row-level live statuses above are the evidence base, and the operational
proof comes from [007-operational-readiness.md](./007-operational-readiness.md).

| Gate | Status | Evidence / notes |
|------|--------|------------------|
| Inventory fully accounted for | Pending | Every inventory row from 006 has a ledger disposition appropriate for the target cutover. |
| All `Deferred (required for cutover)` entries resolved | Pending | Every ledger entry tagged `Deferred (required for cutover)` is now `Met`/`Improved` (or explicitly re-accepted as `Gap` with sign-off). herobids-on-Traderton must not be weaker than herobids-today for any capability herobids relies on Traderton to provide. Enumerate the resolved entries here. |
| Side-effecting parity validated | Pending | `submit_decision`, bot lifecycle, risk gate, and watch lifecycle have copied-test and cutover-evidence coverage. |
| Consumer boundary contract validated | Pending | [005-consumer-boundary-contract.md](./005-consumer-boundary-contract.md) is implemented and integration-tested end to end. |
| Operational readiness passed | Pending | Latency, equivalence, restart-resilience, and rollback checks from 007 passed in the target environment. |
| Rollback path rehearsed | Pending | Traffic can move back to the prior trusted path without data loss or double execution. |
| Final cutover approval | Pending | Record approver, environment, date, and release note or change ticket here. |

Only mark `Final cutover approval` as `Met` when `Inventory fully accounted
for` is `Met`, `All Deferred (required for cutover) entries resolved` is `Met`,
and `Side-effecting parity validated`, `Consumer boundary
contract validated`, `Operational readiness passed`, and `Rollback path
rehearsed` are each `Met`. Accepted `Gap` or `Deferred (optional)` entries may
explain the inventory state; they do not waive the mandatory contract, readiness,
or rollback gates. A `Deferred (required for cutover)` entry does **not** get to
explain-and-pass — it must be resolved (or re-accepted as a signed-off `Gap`)
before cutover.
