# Bug Report: Protective `watch_token` calls cannot link to positions opened through `submit_decision`

- **Status:** FIXED (2026-10-06) in `watch_token`. What `positions.instrument_id` should hold is still undecided (see "Remaining gaps").
- **Severity:** Medium.
  - **Impact:** agents could not attach `stop_loss` / `take_profit` / `exit` price watches to positions opened through `submit_decision` unless they sent an exact `coverage.targetPosition` without an `instrumentId`. `position-coverage.ts` then counts those positions as uncovered (`hasUncoveredPosition`).
  - **Not affected:** per-trade `stopLoss` / `takeProfit` levels set on `submit_decision`. They are stored on the position and enforced by the agent actor's own exit-level check, which forces `go_flat` and does not use `watch_token`.
- **Date found:** 2026-10-06
- **Found via:** manual evaluation of a herobids `tintel` agent session (Hyperliquid perps, shadow mode), then source tracing and a probe test against `watch_token`.
- **Components:** `packages/worker/src/tools/watch.ts` (`watch_token`). Its tool descriptions are mirrored in herobids `apps/worker/src/tools/watch.ts`.

## Symptom (as reported from the session)

The agent opened a Hyperliquid perp position with `submit_decision` (`instrumentId: "NEAR"`, `go_long`), and the decision succeeded. Its follow-up protective `watch_token` call failed with:

```
Protective watch (purpose=stop_loss) requires either a matching instrument identity or a resolvable target position. Create the position first, or use a non-protective purpose (e.g. "monitor", "alert") for manual tracking.
```

An identical retry about 6s later failed the same way. The agent did not try a protective watch again for the rest of the run.

These session details come from the evaluation notes. They were not re-checked here: no database was available, so the `agent_messages` tool-call arguments and the `positions` rows were not inspected directly.

## What the error text tells us

`watch_token` returns that exact message only from its last fail-closed guard. That guard is reachable only when `coverage.targetPosition` never reaches `execute()`. A protective call that includes `targetPosition` either links or returns its own error ("No open position found…" or "Ambiguous target…") before the guard runs.

A probe test checked this. It ran each candidate payload through the real Zod schema and `execute()`, against production-shaped data:
- a position with `venue: "hyperliquid"`, `symbol: "NEAR"`, `instrumentId: null`;
- an instruments row with ccxt symbol `NEAR/USDC:USDC` and a UUID `id`.

Results on the pre-fix code:

| Payload | Result |
|---|---|
| `coverage.targetPosition` `{ venue, symbol, side, instrumentId: "NEAR" }` | `No open position found matching venue=hyperliquid symbol=NEAR side=long. …` |
| `coverage.targetPosition` without `instrumentId` | success |
| no `coverage` | the reported error |
| `venue`/`symbol`/`side` placed directly on `coverage` (Zod strips them) | the reported error |
| `targetPosition` at the top level, outside `coverage` (Zod strips it) | the reported error |

So the agent most likely omitted or misplaced `targetPosition`. Which of those three shapes it sent is unconfirmed. The fix covers all of them.

## Root cause

**1. Auto-link could never link a decision-intake position.** Without `coverage.targetPosition`, `watch_token` tried to auto-link a protective watch by canonical identity only. That needed two things, and production data satisfies neither:
- **An instrument match.** `instrumentRepo.search` results must contain an exact symbol match. `instruments.symbol` holds ccxt unified symbols (`NEAR/USDC:USDC`), but agents pass tickers (`NEAR`). So no instrument resolved, auto-link was skipped, and the fail-closed guard fired. That is the reported error.
- **An id match.** `instruments.id` must equal `positions.instrument_id`. `instruments.id` is a random UUID (`instrument-population.ts`), and positions opened through decision intake store `instrument_id = null`. So even a resolved instrument found zero matches, which was a hard reject.

The unit tests passed only because their fixtures set `instruments.id` equal to the position's `instrumentId`, which production never produces. The code comments also ruled out symbol matching on purpose, citing perp-vs-spot ambiguity. That ambiguity only arises across venues.

**2. A caller-supplied `targetPosition.instrumentId` vetoed an exact match.** The explicit matcher required `p.instrumentId === targetInstrumentId` whenever the caller sent one. A stored `null` therefore rejected an otherwise exact venue + symbol + side match. This is a real defect, but the error it produces is not the one in the session.

**3. Tool descriptions steered agents wrong.**
- `targetPosition.instrumentId` said "provide when available", which invites the ticker the agent passed to `submit_decision`.
- `targetPosition.symbol` didn't say what value positions store.
- The top-level description didn't explain when auto-link works.

## Fix (applied)

All behaviour changes are in `packages/worker/src/tools/watch.ts`.

**Auto-link (no `coverage.targetPosition`, protective purpose, position lookup available):**
- **Tier 1, canonical identity (unchanged):** venue + `instrumentId`. More than one match is rejected as ambiguous. Zero matches is no longer a hard reject; it falls through to tier 2.
- **Tier 2, venue + symbol (new):**
  - Only positions on the venue the watch is priced on (`resolvedChain ?? chain`) are considered. A watch priced on another chain, for example via the DexScreener fallback, never links.
  - The symbol must equal the resolved or input symbol, case-insensitive.
  - A position whose stored, non-null `instrumentId` conflicts with the resolved instrument is skipped.
  - When the purpose implies a side, only that side is eligible:

    | purpose | `below` | `above` |
    |---|---|---|
    | `stop_loss` | long | short |
    | `take_profit` | short | long |
    | `exit` | any side | any side |

  - The watch links only when exactly one position matches. If the only match is on the opposite side, the rejection says so ("a stop_loss with condition "above" protects a short position, but your open hyperliquid NEAR position is long").
- **Swap venues:** `jupiter` and `1inch` never equal a chain name, so tier 2 does not link swap positions. Those need an explicit `coverage.targetPosition`.

**Explicit `coverage.targetPosition`:** a caller-supplied `instrumentId` now narrows the match only when the stored position has one: `(!targetInstrumentId || !p.instrumentId || p.instrumentId === targetInstrumentId)`. A conflicting non-null id is still rejected.

**Rejections say how to retry.** When the position lookup succeeds, every protective linkage rejection (no match, ambiguous, side mismatch, in both the auto-link and explicit-target paths) lists the caller's open positions as `venue symbol side` (up to 10, then `(+N more)`). It also says to retry with `coverage.targetPosition` from that list. If the lookup itself fails, auto-link returns a retryable error and the explicit path returns "No open position found" without a list. The generic fail-closed message now fires only when positions can't be looked up at all (no `botRepo` in the context), and it says so.

**Tool descriptions (traderton and herobids, identical wording):**
- The top-level description now explains the auto-link rule and the implied sides.
- `targetPosition.symbol` explains that it is the `instrumentId` submitted to `submit_decision`.
- `targetPosition.instrumentId` says to omit it unless `list_positions` shows a non-null value.

**Not changed:**
- No write to `positions.instrument_id`.
- No schema or database change.
- No change to other position writers or to `position-coverage.ts`.
- Auto-linked watches get their `positionKey` from the matched stored position, so coverage evaluation sees the same key it derives itself.

### Corrections to the first version of this report

An earlier version (`001-instrument-id-dropped-breaks-protective-watch-linking.md`, now removed) had the cause wrong:
- **It said the agent sent `coverage.targetPosition.instrumentId`.** That payload returns "No open position found…", not the reported error.
- **It said `find_instrument` tells agents to reuse its `instrumentId` for `watch_token`.** The description actually says "use the symbol or base field".
- **It blamed `getIntakeDeps()` for "dropping" `instrumentId`.** The submitted `instrumentId` is persisted, as `positions.symbol`. `positions.instrument_id` is documented as a separate canonical id.
- **Its primary fix, copying the ticker into `instrument_id` from `getIntakeDeps()`, would not help and carries a regression risk:**
  - It leaves `derivePositionKey` unchanged, and auto-link would still compare against UUIDs.
  - `PositionRepository.upsert` treats `instrumentId` as part of identity: a write without one matches only rows where `instrument_id IS NULL`. Writers that omit it would then miss or duplicate rows. Examples are `cleanupOrphanedPositions` (shadow/paper flat closes) and private-stream persistence when the in-memory position lacks an id.
- **It said private-stream writes could overwrite a stored `instrumentId` with `undefined`.** The repository's update branch sets `instrumentId` only when it is defined, so it never clears one.

## Verification

- **New tests:** 17 in `packages/worker/src/tools/watch.test.ts` (`watch_token — protective linkage by venue + symbol`), using production-shaped fixtures. They cover:
  - the fallback link;
  - implied side (long, short, mismatch, agent-vs-bot disambiguation);
  - same-side ambiguity;
  - `exit` with one or two matches;
  - cross-chain pricing;
  - swap-venue positions;
  - the listing cap;
  - the misnested-coverage shape;
  - the no-lookup message;
  - both explicit-`targetPosition` instrumentId cases;
  - an ambiguous explicit `targetPosition` listing the open positions.
- **The tests guard the fix:** all 17 fail against the pre-fix `watch.ts`, and all 87 tests in the file pass with the fix. The pre-existing "rejects protective watch when instrumentId mismatch cannot be resolved (no symbol fallback)" case still passes unchanged.
- **traderton:** `pnpm lint` and `pnpm build` are clean. `pnpm test`: 170 files and 2976 tests pass. 21 files / 102 tests are skipped; these are DB-backed integration tests, and no Postgres was running.
- **herobids:** `pnpm lint` is clean. `apps/worker` `watch.test.ts` and `runtime-tool-visibility.test.ts` pass (27 tests).
- **Not verified:**
  - an end-to-end run with a live agent session;
  - the actual `watch_token` payloads in the session's `agent_messages`.

## Remaining gaps (not fixed here)

1. **What `positions.instrument_id` means is undecided.** Today:
   - the entry path writes `null`;
   - the stop-loss and crash-policy path (`AgentTradingActor.buildIntakeDeps`) passes the ticker, which promotes the row just before closing it;
   - the schema comment describes a canonical venue id (e.g. `BTC-USD`);
   - `instruments.id` is a UUID.

   Populating it consistently needs a deliberate decision across every writer, because of the upsert identity rule above.
2. **Tier 1 canonical linking effectively never matches in production.** Positions don't carry `instruments.id`. It's left in place: it's harmless and becomes useful if gap 1 is resolved that way.
3. **No auto-link for swap venues.** Agents must pass `coverage.targetPosition`; the rejection lists their positions to copy from. A swap fallback would need the network from the binding profile for 1inch, which `watch_token` doesn't have.
4. **The session payload is unconfirmed.** Check the `watch_token` arguments in that session's `agent_messages` to confirm which shape the agent sent.

## References

- `packages/worker/src/tools/watch.ts`: `watch_token`, `linkByVenueAndSymbol`, `inferProtectedSide`, `formatRetryCandidates`
- `packages/worker/src/position-coverage.ts`: `derivePositionKey`, coverage evaluation
- `packages/worker/src/instrument-population.ts`: `instruments.id` is `crypto.randomUUID()`
- `packages/db/src/repositories.ts`: `PositionRepository.upsert` (instrumentId identity rule), `getOpenPositionsByCreator`
- `packages/worker/src/agent-trading-actor.ts`: `getIntakeDeps`, `buildIntakeDeps`, `buildPersistence`, per-trade exit-level checks
- `packages/worker/src/reconciliation-orphaned-cleanup.ts`
- herobids `apps/worker/src/tools/watch.ts`, the agent-facing `watch_token` schema and description
