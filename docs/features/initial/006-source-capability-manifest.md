# Source Capability Manifest

**Status:** living
**Created:** 2026-09-05

## Purpose

Record the exhaustive source-system trading capability inventory that Traderton
must reproduce, improve, defer, or explicitly diverge from. This doc is the
static inventory authority. Live implementation status belongs in
[001-parity-ledger.md](./001-parity-ledger.md), which is the working parity
acceptance tracker.

## Scope

This doc includes:

1. the exhaustive trading tool inventory copied from the source system
2. the mandatory subsystem coverage Traderton must preserve
3. the extraction-complete rule that forbids calling a partial tool slice
   "done"

This doc does not include:

1. live status updates
2. consuming-platform route, skill, or capability-taxonomy semantics
3. internal package layout choices inside Traderton

## Rules

1. Every source trading tool appears exactly once in this manifest.
2. Every item in this manifest appears in
   [001-parity-ledger.md](./001-parity-ledger.md) with a live status.
3. Parity sign-off happens in the ledger, but only against the inventory fixed
   here.
4. A capability may be marked **Deferred**, **Gap**, or **Intentional
   divergence** only through the ledger, never by silently dropping it here.
5. Full tool coverage is required. A partial first-tool slice is not complete
   extraction.
6. Copied source tests are the primary parity harness for each covered surface.

## Tool Inventory

All tools below are trading-owned in Traderton. The old platform distinction
between native capabilities, external backends, and general tools does not
apply inside Traderton itself.

| Tool | Area | Notes |
| --- | --- | --- |
| `submit_decision` | decision execution | Highest-stakes parity surface. |
| `create_bot` | bot lifecycle | |
| `start_bot` | bot lifecycle | |
| `stop_bot` | bot lifecycle | |
| `list_bots` | bot lifecycle | |
| `resolve_bot` | bot lifecycle | |
| `get_bot_status` | bot lifecycle | |
| `adjust_bot_config` | bot lifecycle | |
| `adjust_risk_limits` | risk policy | User-configured limits remain authoritative. |
| `get_risk_limits` | risk policy | |
| `get_account_summary` | account state | |
| `list_positions` | account state | |
| `get_price` | market data | |
| `get_funding_rates` | market data | |
| `get_market_overview` | market data | |
| `get_analytics` | analytics | |
| `check_regime` | market analysis | Mechanical only; no LLM dependency. |
| `discover_tokens` | discovery | |
| `search_tokens` | discovery | |
| `find_instrument` | discovery | |
| `watch_token` | watch lifecycle | |
| `check_watches` | watch lifecycle | Success `data` = `{ ok, triggered[], reset[], unchecked[], totalWatches }`. `reset[]` (watchIds that went true→false this cycle) added for B3-monitor — lets the platform wake-monitor clear its dedupe on reset (parity). |
| `list_watches` | watch lifecycle | |
| `remove_watch` | watch lifecycle | |
| `resolve_watch` | watch lifecycle | |

## Mandatory Subsystem Coverage

Traderton extraction is not complete until the following subsystem groups are
covered as copied behavior or explicitly accounted for in the ledger.

| Subsystem group | Coverage expectation |
| --- | --- |
| Risk gate | Exact rules, bypass behavior for risk-reducing plans, and exact error codes preserved. |
| Venue adapters | Order ops, swap ops, streams, confirmation, mark sources, and rate limiting preserved per venue. |
| Trading loop | Scan, plan, risk, execute, fill, reconcile orchestration preserved. |
| Position and equity tracking | Open-position state, fills, equity, daily-loss tracking, and rehydrate preserved. |
| Watch lifecycle | Create, evaluate, list, resolve, and remove watch behavior preserved. |
| Market data and discovery | Price, funding, discovery, and non-LLM analysis inputs preserved. |
| Backtesting and replay | Historical execution and replay surfaces preserved when present in source. |
| Trading data model | Trading tables and repositories listed in [002-phase-0-subtraction-plan.md](../archive/002-phase-0-subtraction-plan.md) preserved or intentionally cut. |
| Mechanical strategies | `Dca`, `Mechanical`, `scan-engine`, and `regime` preserved; LLM-driven strategies stay outside Traderton by design. |

## Extraction-Complete Rule

Traderton is not "extracted" when one or two tools can call through the new
boundary. Extraction is complete only when:

1. every tool in the tool inventory executes through the Traderton boundary
2. every mandatory subsystem group is either preserved or explicitly accounted
   for in the ledger
3. copied tests and targeted integration checks prove the covered behavior
4. remaining omissions, if any, are recorded as **Deferred** or **Gap** and are
   accepted deliberately

## Validation Expectations

Once code exists, validation should fail loudly on:

1. a missing or extra tool relative to this manifest
2. a ledger entry that has no manifest row
3. a manifest row with no ledger status
4. an extraction milestone being declared complete while only a subset of tools
   or subsystem groups has crossed the boundary