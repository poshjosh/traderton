# 011 — Pre-merge backlog (autonomous driver-loop execution order)

**Status:** living. **Created:** 2026-09-12. The sequenced, cutover-BLOCKING work the
continuous driver loop (008 §8) executes top-to-bottom. Grounded by a code-verified inventory
(Contemplator, 2026-09-12) — no stale "done-but-marked-open" among blocking items. Optional /
non-blocking items are in §2 (NOT gate obligations). Update as slices land.

Legend: [ ] open · [~] in progress · [x] done (→ ledger row). "4-risk" = must route via 008 §3.

## Wave A — Traderton-side boundary tools (prereqs; mostly copy/adapt)
- [ ] **A1. `delete_bot` boundary tool + herobids DELETE re-point.** Both repos. Owner-scoped delete tool (adapt copied DELETE handler + deprovision-style guards); herobids `bots.ts:610` re-points (or refuses when boundary present). 4-risk: authoritative-removal vs local-only contract.
- [ ] **A2. Owner/bot-scoped read wave: costs / journal / journal-summary / sessions / events.** Both repos. Add owner-scoped read tools + repo methods (copy/adapt agent-scoped, re-key to ownerId); herobids `bots.ts:418–550` re-points off local fills/journalEvents. Prereq for retiring local trading tables. Mostly clean copy/adapt (ownerId semantics = ratified default C).

## Wave B — agent-container market-data read-tools (long pole; gates registry removal)
- [x] **B1. Hybrid sizing + `get_price`/`resolvePriceTarget` contract.** DONE (traderton `resolve_price_target` tool + herobids boundary adapter; settled by parity; HIGH parity-break fixed in review). Provides the `resolve_price_target` shared surface for B3.
- [x] **B2. `tools/price.ts` → boundary `get_price`.** DONE (herobids agent `get_price` tool → boundary get_price; boundary-first branch mirroring risk-limits.ts, in-process fallback preserved; settled by parity — byte-identical boundary tool). Lint clean; 18/18 price tool tests pass. No CRITICAL/HIGH in review.
- [x] **B3. Watch tools → boundary (Option C landed; B3-monitor Deferred as own slice).** herobids `tools/watch.ts`. Corrected scope (`resolve_watch` is NOT here — it lives in `resolvers.ts`, routes with the resolvers group later). Decision agent ruled Option D (settled within rules, no ratification): Traderton `check_watches` = evaluation authority; the herobids platform monitor becomes a thin boundary consumer. Must land ATOMICALLY:
  - [ ] **B3-pre** (traderton `bin.ts`): wire `new InstrumentRepository(db)` into the boundary context factory. Unblocks `watch_token` protective auto-link parity + boundary `find_instrument`. Mechanical/parity-preserving.
  - [x] **B3-tools** (herobids `tools/watch.ts`): DONE (herobids `353f584e`). `list_watches` read path + in-process fallback; `watch_token`/`remove_watch`/`check_watches` fail-CLOSED writes (mirror `adjust_risk_limits`), in-process write bodies DELETED (net −1719 LOC; removes trading-state authority from the agent process). Lint clean; watch tests green.
  - [x] **B3-summary** (herobids `agent.ts`): DONE (herobids `353f584e`). New pure `agent-watch-view.ts` helpers + `loadActiveWatches(agentId)` → single `list_watches` boundary fetch per tick derives both raw list + summary; empty→stable-digest + local fallback preserved. 8 helper unit tests.
  - [x] **B3-monitor-disable** (herobids `index.ts`): DONE (herobids `353f584e`). `watchThresholds` family forced `false` — the local watch push loop no longer evaluates the now-remote set (no split-brain). Watch-threshold WAKES are OFF until B3-monitor below. Discovery/regime families untouched.
- [ ] **B3-monitor (Deferred-required; own slice).** Re-point the platform watch-evaluation PUSH loop per Option D: monitor gains a `db` dep + `agentId→ownerId` lookup + a per-agent write-boundary factory; `evaluateWatches` invokes boundary `check_watches` per active+subscribed agent and consumes `triggered[]`, keeping platform work local (session/prefs/scanner-gated filters, dedupe, rate-limit, `emitMarketWatchTriggered`/`enqueueWake`). Re-enables watch-threshold wakes. Restructures the monitor test suite. Within the existing boundary contract (no new surface). RESTORES the temporary gap opened by B3-monitor-disable.
- [x] **B4. `tools/market-data.ts` → boundary.** DONE (settled by parity; herobids re-point of all 5 read tools — search_tokens/discover_tokens/check_regime/get_funding_rates/get_market_overview — over `ctx.tradertonBoundary`, in-process fetch retained as transitional fallback; discovery enrichment + search policy happen Traderton-side, no double-processing). Lint clean; 14/14 tests. No CRITICAL/HIGH in review.
- [ ] **B5. Volatility-candle series behind the boundary.** herobids `agent.ts:~2958` `fetchVolatilityCandles` → no boundary tool exists. New Traderton tool. 4-risk (new surface/contract) → route.
- [ ] **B6. Economic-calendar acquisition behind the boundary.** herobids `agent.ts:~1011`. Human-ruled trading-adjacent → Deferred-required. Boundary shape TBD (read tool vs boundary-populated cache). 4-risk → route.
- [ ] **B7. Remove in-process regime fallback + drop `createProviderRegistry`/`createPriceService` from the agent container.** herobids `agent.ts:~920/932/2951`. Satisfies "no market-data in the agent process." Depends on B1–B6.

## Wave C — swap-path safety + swap scoring
- [ ] **C1. Swap-venue token-safety gating** (`enrichTokenWithDiscovery` not copied; `swapTokenSafety: undefined` + dropped 1inch swapNetwork guard). Deferred-required (swap-venue bots ONLY). Copy or herobids source-fix. 4-risk (parity) → route.
- [ ] **C2. Swap `score_candidate` build (token→pool, T2).** Approach ratified. VERIFY blocking-vs-optional: ledger says swap scoring is INERT today (null candles) → likely OPTIONAL for gate; confirm the inert claim at build. Open build items: quote-asset default (ratified: none), GeckoTerminal Pro endpoint (free tier works).

## Wave D — teardown, data migration, proofs (LAST)
- [ ] **D1. Delete herobids in-tree trading packages + tables + remaining value imports.** After A–C: remove `@herobids/{engine,venues,market-data,strategy,backtesting}` value imports (index.ts PublicStreamPool + registry + economic-calendar; scanner-candle-fetcher; public-stream-routing); drop local bots/fills/journalEvents/venue_accounts/user_credentials tables + trading-provisioner.ts. Defines "trading retired." Depends A–C.
  - **D1 sub-obligation (from A1 review, MEDIUM):** when the DELETE pre-guard + local `bots` mirror are removed at D1, the route's `delete_bot` 409 BACKSTOP (`details.errorCode==='bot.running'` → 409) becomes the SOLE 409 defense. It is untested today (the pre-guard fires first; a divergent stub would test an impossible-today state). ADD a functional test isolating the backstop (read reports stopped / delete returns bot.running → assert 409) AS PART OF D1, when the pre-guard is removed.
- [ ] **D2. Pre-existing trading-credential + venue-account row migration** (DATA step, not code). Migrate/re-provision pre-cutover rows into Traderton. Depends on provision_venue_account (done).
- [ ] **D3. herobids functional/E2E boundary-aware + true cross-stack E2E** (herobids stack + live Traderton boundary, matching signing creds). Gate criterion #3. Some sub-parts 4-risk.
- [ ] **D4. Operational-readiness + rollback proof (007) + staging soak** → then the HUMAN MERGE APPROVAL (the hard stop).

## §2 — Optional / NON-blocking (NOT gate obligations)
- Deprecated `POST /venue-accounts` preview endpoint (delete at cleanup; admin-only; no scripts POST to it).
- Dev `CREDENTIAL_ENCRYPTION_KEY` in committed compose (convenience).
- Code-review LOW/MEDIUM follow-ons (swap M1/M2 dedupe+tie-break test; bin.ts cast comment; B2 DRY helper; regime magic-literal comment).
- 010 backlog B1–B10 (later-options). Traderton-native metering / bot cloning (Deferred-optional).

## §3 — Undetermined (resolve at slice time)
- **C2 blocking-vs-optional:** confirm swap evidence path still returns null candles (inert) → optional for gate.
- **`generateWallet` (from @herobids/venues) in api routes** (setup.ts/chat.ts/index.ts/accounts.ts): trading-owned (must move) or platform-side key-gen herobids keeps? Route classification via 008 if trading-adjacent.

## Outstanding Issues (non-blocking review findings; MEDIUM/LOW only — no CRITICAL/HIGH)
Accumulated from per-slice CodeReviewer passes. Grouped by item. None gate the merge.

- **[B2]** MEDIUM — boundary success payload is `data: unknown` (`TradertonReadResult.success`); success-shape parity (`priceUsd`/`source`/`fetchedAt`/`stale`) is guaranteed only by the external Traderton `get_price` tool, invisible to the herobids type system. Inherent to the transitional boundary design (same as all read re-points, incl. `get_risk_limits`). Mitigation lives at D3 (cross-stack E2E pins the real wire shapes). Not a code defect.
- **[B2]** LOW — no per-tool test for boundary `transport_error` / `in_progress` on `get_price` (mapper handles both and is separately tested). Optional: add a `transport_error → { retryable:true, fault:true, errorCode:'boundary.transport_error' }` case to fully pin the tool's unhappy-infra contract.
- **[B2]** LOW — `fault` intentionally absent on the pre-existing in-process `price_service_not_configured` branch while other branches set it explicitly. Pre-existing, harmless minor inconsistency.
- **[B3]** TEMPORARY GAP (tracked, not a Gap-forever) — watch-threshold agent WAKES are OFF until **B3-monitor** lands (monitor's local watch eval disabled to avoid split-brain; watch state now remote). The agent can still call `check_watches` itself over the boundary (on-demand eval preserved); only the proactive platform PUSH is deferred. On a branch, not merged.
- **[B3]** MEDIUM (no-boundary config) — with the boundary present (the cutover config) isolation holds and the summary is boundary-sourced. In a NO-boundary deployment, disabling the `watchThresholds` family means the `agent:watches:summary:*` cache is no longer written by the monitor (summary now rebuilt per-tick) and watch wakes don't fire. Acceptable for the cutover target (boundary is present); revisit if no-boundary must stay a supported runtime.
- **[B3]** LOW — `parseRuntimeActiveWatch` (in `agent-watch-view.ts`) is exported but covered only indirectly via `parseBoundaryWatchList`; add a direct test or drop the export.
- **[B3]** LOW — `loadActiveWatches` summary error-path fallback may re-fetch `list_watches` on the (rare) error branch; by design, noted for awareness.
- **[B4]** LOW — the `market_data_not_configured` guard block is now duplicated across the 5 tools alongside the boundary guard; pre-existing + transitional (in-process arm slated for deletion at D1), abstracting now would be premature.
- **[B4]** LOW — no per-tool `transport_error`/`in_progress` mapping test for a market-data tool (the mapper is shared + separately tested; one `failure` case is covered here). Optional parity coverage.
- **[B4]** LOW — `market-data.test.ts` missing trailing newline (trivial nit).

## Hard stops (008 §8.2) — the loop halts ONLY for: merge-to-main; a decision-agent-escalated product/policy call; an on-branch-unresolvable blocker; backlog exhausted.
