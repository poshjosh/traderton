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
- [ ] **B1. Hybrid sizing + `get_price`/`resolvePriceTarget` contract.** herobids `agent.ts:~3297` + basis for price/watch. 4-risk (behaviour-contract) → route FIRST (B3/B4 depend on it).
- [ ] **B2. `tools/price.ts` → boundary `get_price`.** Depends on B1.
- [ ] **B3. Watch tools → boundary** (`watch_token`/`remove_watch`/`check_watches`/`list_watches`/`resolve_watch`). herobids `tools/watch.ts`. Pull-based. Depends on B1.
- [ ] **B4. `tools/market-data.ts` → boundary.** Re-point the tool surface (regime/overview/discovery/search tools already exist).
- [ ] **B5. Volatility-candle series behind the boundary.** herobids `agent.ts:~2958` `fetchVolatilityCandles` → no boundary tool exists. New Traderton tool. 4-risk (new surface/contract) → route.
- [ ] **B6. Economic-calendar acquisition behind the boundary.** herobids `agent.ts:~1011`. Human-ruled trading-adjacent → Deferred-required. Boundary shape TBD (read tool vs boundary-populated cache). 4-risk → route.
- [ ] **B7. Remove in-process regime fallback + drop `createProviderRegistry`/`createPriceService` from the agent container.** herobids `agent.ts:~920/932/2951`. Satisfies "no market-data in the agent process." Depends on B1–B6.

## Wave C — swap-path safety + swap scoring
- [ ] **C1. Swap-venue token-safety gating** (`enrichTokenWithDiscovery` not copied; `swapTokenSafety: undefined` + dropped 1inch swapNetwork guard). Deferred-required (swap-venue bots ONLY). Copy or herobids source-fix. 4-risk (parity) → route.
- [ ] **C2. Swap `score_candidate` build (token→pool, T2).** Approach ratified. VERIFY blocking-vs-optional: ledger says swap scoring is INERT today (null candles) → likely OPTIONAL for gate; confirm the inert claim at build. Open build items: quote-asset default (ratified: none), GeckoTerminal Pro endpoint (free tier works).

## Wave D — teardown, data migration, proofs (LAST)
- [ ] **D1. Delete herobids in-tree trading packages + tables + remaining value imports.** After A–C: remove `@herobids/{engine,venues,market-data,strategy,backtesting}` value imports (index.ts PublicStreamPool + registry + economic-calendar; scanner-candle-fetcher; public-stream-routing); drop local bots/fills/journalEvents/venue_accounts/user_credentials tables + trading-provisioner.ts. Defines "trading retired." Depends A–C.
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

## Hard stops (008 §8.2) — the loop halts ONLY for: merge-to-main; a decision-agent-escalated product/policy call; an on-branch-unresolvable blocker; backlog exhausted.
