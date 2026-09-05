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
| **Deferred** | Deliberately not done yet. Note reason + what it blocks. |
| **Gap** | Attempted; fell short. Note exactly what is missing and why. Requires sign-off. |
| **Intentional divergence** | Source behaviour deliberately NOT copied because it was platform coupling, not trading capability. Note the seam. |

Rules: nothing is silently dropped — every source capability appears here.
Nothing regresses without an explicit **Gap** entry that someone signed off.

## Ledger

### Phase 1 progress (live)

**Status: IN PROGRESS — blocked, build not green.** Do not mark any slice `Met` until the copied `packages/domain` build + tests are green again.

- Workspace shell scaffolded (pnpm workspace, strict TS ES2022 ESM, vitest) mirroring herobids toolchain (Node ≥22, pnpm 10.33.2). `git init` done for delete-visibility.
- `@herobids/domain` copied verbatim (97 files) and renamed to `@traderton/domain`. Trading `config/strategy-presets/*.yaml` copied. **Verbatim-copy baseline was green: 981/981 tests, build + lint clean** (the parity harness).
- Leaf-first platform deletions completed cleanly (build green after each): removed `agent-evaluation`, `agent-goal`, `assessment-billing`, `plan-entitlements`, `platform`, `provider-catalog`, `runtime-composition`, `skills*`, `skill-resolution`, `tools`, `tool-schemas`, `llm-selection`, `external-skill-provider-http`, `text-search`, `review-pre-check`, `browser-pool-feature.test`, dirs `email/ infra/ skills/ __tests__/`, platform ports (`assessment-identity-resolver`, `assessment-request`, `preset-transition`, `blueprint-execution-capability`, `browser-pool`, `document-store`, `document-text-extractor`, `runtime-document-materializer`, `runtime`, `external-skill-provider`), `models/llm-models`. Barrels (`index.ts`, `ports/index.ts`, `models/index.ts`) trimmed accordingly.
- **BLOCKER:** `config/schema.ts` is a fused trading+platform monolith (2598 lines, 212 exports). Cannot be reduced to trading-only by leaf deletion; doing so is authored surgery on a fused file. Logged in [003-anomalies-and-deviations.md](./003-anomalies-and-deviations.md) (2026-09-05). 3 typecheck errors remain, all rooted in this seam. Awaiting direction before proceeding.

### Cross-cutting

| Capability (from source) | Area | Status | Notes |
|--------------------------|------|--------|-------|
| Traderton-native usage metering / payments / caps | cross-cutting | Deferred | Platform billing authority stays outside Traderton by design. Service-owned metering, billing, and caps are cut for initial extraction and can return later. |

### Trading tools (25 — authority:
[006-source-capability-manifest.md](./006-source-capability-manifest.md))

| Tool | Status | Notes |
|------|--------|-------|
| `submit_decision` | Pending | Decision execution — highest-stakes parity surface. |
| `create_bot` | Pending | |
| `start_bot` | Pending | |
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
| Risk gate (all rules, hard invariants, user vs operator defaults) | Pending | `packages/engine/risk-gate.ts` + parity test. |
| Venue adapters (Hyperliquid, Bybit, Jupiter, 1inch) | Pending | order types, streams, mark sources, rate limits. |
| Trading loop (scan→decision→plan→risk→execute→fill→reconcile) | Pending | |
| Position / equity trackers | Pending | |
| Price-watch lifecycle | Pending | |
| Market data / discovery | Pending | Indicators and discovery inputs only, no LLM. Moves to Traderton. |
| Backtesting / replay | Pending | |
| Trading data model (tables listed in Phase 0) | Pending | |
| Mechanical strategies (`Dca`, `Mechanical`, `scan-engine`, `regime`) | Pending | Move to Traderton (no LLM). |

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
| Bots could run `LlmStrategy` / `HybridStrategy` | Traderton bots are **mechanical-only** (`mechanical`, `dca`) | Intelligence is the agent's job. LLM/Hybrid decision-making relocates to the agent, which submits decisions via the boundary (decisions 7–9). |
| `blueprint.ts` agent/preset/wake policy | Stays platform | Only its risk/execution/token-safety schemas are trading config (decision 14). |
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
| Side-effecting parity validated | Pending | `submit_decision`, bot lifecycle, risk gate, and watch lifecycle have copied-test and cutover-evidence coverage. |
| Consumer boundary contract validated | Pending | [005-consumer-boundary-contract.md](./005-consumer-boundary-contract.md) is implemented and integration-tested end to end. |
| Operational readiness passed | Pending | Latency, equivalence, restart-resilience, and rollback checks from 007 passed in the target environment. |
| Rollback path rehearsed | Pending | Traffic can move back to the prior trusted path without data loss or double execution. |
| Final cutover approval | Pending | Record approver, environment, date, and release note or change ticket here. |

Only mark `Final cutover approval` as `Met` when `Inventory fully accounted
for` is `Met`, and `Side-effecting parity validated`, `Consumer boundary
contract validated`, `Operational readiness passed`, and `Rollback path
rehearsed` are each `Met`. Accepted `Gap` or `Deferred` entries may explain the
inventory state; they do not waive the mandatory contract, readiness, or
rollback gates.
