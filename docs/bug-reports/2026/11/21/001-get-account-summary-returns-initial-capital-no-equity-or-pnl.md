# Bug Report: `get_account_summary` returns the configured (initial) capital as "available capital"; agents have no accurate equity or P&L
- **Status:** OPEN. Not fixed. This report documents the defect and the approved fix plan. No work started; waiting for the owner's greenlight.
- **Severity:** High. Agents size positions and judge performance from numbers that never change with trading. Percent-based sizing, daily-loss limits and drawdown reasoning all start from a wrong base.
- **Date:** 2026-11-21
- **Environment:** code analysis only (traderton and herobids source). Not reproduced live. Applies to paper, shadow and live modes (see "Not verified").
- **Companion report (herobids side):** `herobids/docs/bug-reports/2026/11/21/002-agent-portfolio-context-mislabels-initial-capital-as-available.md`
- **Related:**
  - `herobids/docs/bug-reports/2026/10/05/006-portfolio-context-block-never-populated.md` (added the plumbing that now carries the wrong value into the prompt).
  - `herobids/docs/bug-reports/2026/07/06/002-agent-mark-source-oracle-only-phantom-pnl.md` (P&L accuracy, mark sources).
  - Origin: `account.ts` was copied from herobids during extraction (`2f2dda4`, `a639d2f`, `93094c6`). The behavior predates traderton and was never extended after capital moved to the trading profile.

## Summary
Reported symptom: LLM agents always report the initial capital as available capital, and their profit and loss knowledge is inaccurate.

Cause: the only tool that exposes capital, `get_account_summary`, returns the static profile capital. It never reads fills, marks or venue balances. Its description promises "usable capital, equity, open positions, P&L", but the code returns none of the last three. The correct equity math exists in the engine and is never exposed to any tool.

## Root Cause
1. **`get_account_summary` returns static capital.**
   - `packages/worker/src/tools/account.ts`: `capital` comes from `ctx.agentRepo.getAgent(ctx.agentId).capital`.
   - `packages/boundary/src/bin.ts` (~lines 676-681): `agentRepo.getAgent` is a stub returning `riskSource.capital` and ignores `_agentId`. `riskSource.capital` is `agent_trading_profiles.capital` (`packages/db/src/schema/agent-trading-profiles.ts`). Nothing updates it after fills, fees or funding.
   - The response has `capital`, `capitalAvailable`, `executionMode`, positions (side, size, entryPrice, openedAt only) and risk limits. No equity, balance, realized or unrealized P&L, or marks.
   - `guidance` says `Available capital: ${capital}`, which tells the agent the initial figure is what it can use.
   - `positionSizeMode` and `fixedPositionSize` are hard-coded null in the stub (`bin.ts` `executionConfig`).
2. **Correct equity exists but is private to the engine.**
   - `packages/engine/src/equity-tracker.ts`: `equity = startingCapital + realizedPnl + unrealizedPnl`, with peak and drawdown. Fed by `fill-accounting.ts` (`recordFill(realizedPnlDelta)`, fee-adjusted) and rehydrated at actor start from `fillRepo.sumRealizedPnlDeltaByVenueAccount` (`agent-trading-actor.ts` ~2934-2953; bot actor `trading-actor.ts` ~793-808).
   - Used only by the risk gate (`decision-intake.ts` ~293-299) and stop-loss. Lives in actor process memory. No tool reads it and nothing persists it for tools.
3. **`get_risk_limits` reads a Redis key nobody writes.**
   - `packages/worker/src/tools/risk-limits.ts` `resolveDrawdownCurrent` reads `equity:{agentId}.currentDrawdown`. Code comments say `decision-intake.ts` writes it. No writer exists in `packages`. It is always null and a `catch {}` hides Redis errors.
   - Daily-loss limit is computed as `capital * pct / 100` from the static capital, and `dailyLoss.current` from the windowed analytics, not from the engine's `DailyLossTracker`.
4. **The other read tools do not close the gap.**
   - `get_analytics` (`tools/analytics.ts`): realized P&L and fees over a `days` window (default 7, max 90). Not lifetime. No unrealized P&L. Scoped by creator, not by venue account.
   - `list_positions`: states "unrealizedPnl not available - mark prices are not cached in the agent process".
   - `get_agent_positions` with `includeMarks` (`tools/bots.ts`, `tools/position-marks.ts`) can compute mark and unrealized P&L, but is opt-in and defaults to false.
   - No tool returns venue balances. `fetchBalances()` exists on the adapters (`venues/src/hyperliquid.ts`, `bybit.ts`, `jupiter-swap.ts`, `oneinch-swap.ts`) and `BalanceSnapshotRepository` exists, but neither is surfaced to agents.
   - Funding payments are not accounted for anywhere.
5. **Skills over-promise.** `traderton-skills/skills/crypto-trading/SKILL.md` (lines ~35, ~55) and `crypto-risk-monitoring/SKILL.md` (~line 20) tell agents to use `get_account_summary` for "usable capital, equity, open positions, and P&L" and to tell the user the capital. Similar wording is in `packages/worker/src/tools/trading.ts:55` and `packages/domain/src/tool-schemas.ts:326,330`.
6. **Capital change muddies the baseline.** `agent-direct-actor-ensure.ts` restarts the actor when capital changes. The tracker is rebuilt as `new capital + all-time realized P&L`, so the baseline is not the new capital.

## Why it was not caught
- The description and skill text describe the intended behavior, and the tool returns `ok: true` with a plausible number.
- No test asserts that the summary changes after a fill or a mark move.
- Initial capital equals equity until the first trade, so early checks look right.

## Impact
- The agent reports initial capital as available capital after any gain, loss, fee or open margin.
- Position sizing that uses capital as the base (percent-of-capital guidance, `equity: this.deps.capital` fallback in `agent-trading-actor.ts` ~932, ~1230) is wrong once P&L diverges from zero.
- The agent cannot learn its true P&L from tools. Realized is windowed, unrealized is unavailable by default.
- Daily-loss and drawdown figures shown to the agent can disagree with what the engine enforces.

## Approved fix plan
Approved by the owner on 2026-11-21 (items 1 to 4). Not started.

### 1. `get_account_summary` returns real figures (traderton)
- Return distinct fields: `initialCapital`, `realizedPnlUsd` (lifetime, fee-adjusted), `unrealizedPnlUsd` (from marks), `equity`, `availableCapital` (equity minus margin used), `drawdown` (current and peak).
- Add per-position `markPrice` and `unrealizedPnl`. Positions are scoped by venue account, consistent with the engine.
- Source: either publish the actor's `EquityTracker` snapshot for the tool to read, or compute in the tool from `fillRepo.sumRealizedPnlDeltaByVenueAccount` plus marks. Decide in implementation; the single-source rule is that the tool and the risk gate must agree.
- Live mode: include the real venue balance from `fetchBalances()` as a separate field. Do not substitute it silently for `availableCapital`.
- Remove or rename the bare `capital` field. Because the boundary contract (`@poshjosh/contracts`) changes, agree the field names once and update the contract first. Herobids consumes it.
- Fix the tool description, `promptGuidance` and `guidance` text so they describe what is returned.
- Paper and shadow modes: confirm `shadow-executor.ts` fills flow into the same realized P&L path so the numbers move.

### 2. Skills (traderton-skills)
- Correct `crypto-trading` and `crypto-risk-monitoring` wording to match the new fields. Do not tell agents that `capital` is available funds.

### 3. Herobids consumes the new fields
- See the companion report. Map fields directly; stop deriving equity and inferring starting capital.

### 4. Smaller fixes
- Add the missing writer for `equity:{agentId}` or remove its reader in `risk-limits.ts`. Stop swallowing the Redis error: log at `warn`.
- Make `get_analytics` able to return lifetime P&L (for example an `allTime` option), and scope by venue account.
- Capital-change baseline (DECIDED, 2026-11-21): do not reset realized P&L and do not leave equity as `new capital + lifetime realized`.
  - Keep realized P&L as lifetime (a fact from fills).
  - Add one nullable column to the traderton profile table (`agent_trading_profiles.capital_changed_at`), set in the profile-update path whenever capital changes. No history table: an audit trail of every edit is not needed for this fix.
  - `initialCapital` is the allocation in force now. `pnlSinceCapitalChange` is realized P&L from fills since `capital_changed_at`. Null means never edited, so the period is the whole lifetime and no backfill is needed.
  - Percent return and drawdown are measured over the current allocation period (since `capital_changed_at`). Reset the drawdown peak on an edit.
  - Report `initialCapital`, `lifetimeRealizedPnl` and `pnlSinceCapitalChange` as separate fields in the summary and the contract.
  - Limitation: only the most recent edit is remembered. Two edits in a row lose the earlier period.
  - Known approximation, not worsened by this change: the tracker rehydrates from a realized-P&L sum, not a fill sequence, so the drawdown peak after an actor restart is already approximate.
  - Effort: about 0.5 to 1 day on top of the base fix (one migration, one write, tracker rehydration since the timestamp, tests). Unverified: the profile-update code and the fills timestamp column were not read. Confirm both before starting.
- Funding payments (DECIDED, 2026-11-21): out of scope for this fix, but visible.
  - Add `fundingIncluded: false` (and a short note) to the summary so the agent and user know the figure is fee-adjusted and funding-excluded.
  - Write a separate follow-up report to ingest per-venue funding payments (Hyperliquid, Bybit; none for spot venues) into the same realized path as fills.
  - In live mode, a gap between computed equity and the venue balance field mostly indicates funding drift, which shows when the follow-up matters.
- Refresh after fills (DECIDED, 2026-11-21): the summary must be cheap and correct to call repeatedly, because herobids will refresh it after fills and on each wake. Include a `asOf` timestamp for the read, and a per-position mark timestamp, so consumers can label freshness honestly.

## Acceptance criteria
- After a winning fill, a losing fill and a fee, `get_account_summary.equity` equals `initialCapital + realized + unrealized`, and `availableCapital` changes accordingly.
- With an open position and a moved mark, `unrealizedPnlUsd` is non-zero and matches the engine's `EquityTracker`.
- `get_risk_limits.drawdown.current` is non-null when a drawdown exists, or the reader is removed.
- No tool description or skill text promises a field the tool does not return.
- After a capital edit, lifetime realized P&L is unchanged, `initialCapital` is the new allocation, `capital_changed_at` is set, `pnlSinceCapitalChange` restarts at zero, and the drawdown peak is reset. A never-edited profile reports `pnlSinceCapitalChange` equal to lifetime realized.
- The summary states `fundingIncluded: false` and carries an `asOf` timestamp.
- Behavior test for each of the above (names describe behavior, for example "reports equity below initial capital after a realized loss"). Run focused tests, then `pnpm lint`, `pnpm build`, `pnpm test`.

## Not verified
- Not reproduced live; findings are from reading source.
- Whether paper and shadow mode fills reach the realized P&L path in full (`shadow-executor.ts` was not read in detail).
- Who reads the Redis `startingCapital` key written by herobids `instance-event-publisher.ts`.
- Exact line numbers are approximate (about 3 lines).
