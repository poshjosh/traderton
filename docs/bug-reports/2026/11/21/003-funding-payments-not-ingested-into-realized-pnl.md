# Bug Report: perpetual funding payments (Hyperliquid, Bybit) are not ingested into realized P&L, so equity drifts from the venue balance
- **Status:** OPEN. Not fixed. Follow-up split out of 001 ("Funding payments", decided 2026-11-21). No work started.
- **Severity:** Medium. Over long holds the agent's equity, drawdown and daily-loss figures differ from the venue's. The gap is visible but not corrected.
- **Date:** 2026-11-21
- **Environment:** code analysis only. Applies to perpetual venues in live mode. Paper and shadow have no funding model unless `shadow-executor.ts` simulates it (not verified).
- **Related:** `001-get-account-summary-returns-initial-capital-no-equity-or-pnl.md`
## Summary
Realized P&L is built from fills only (`fill-accounting.ts` `realized_pnl_delta`, fee-adjusted). Hyperliquid and Bybit charge or pay funding on open perpetual positions, and that cash flow never reaches the fills table or the equity view. `get_account_summary` reports `fundingIncluded: false` with a note so consumers know. Spot and swap venues (Jupiter, 1inch) have no funding, so nothing is missing there.
## Impact
- `equity`, `availableCapital`, `lifetimeRealizedPnl`, `pnlSinceCapitalChange`, drawdown and the daily-loss check ignore funding.
- In live mode, a persistent gap between computed `equity` and `venueBalance` mostly indicates funding drift.
- The error grows with position size, hold time and funding rate. It can be material for long holds on high-funding instruments.
## Proposed fix
1. Fetch per-venue funding payments: Hyperliquid user funding history, Bybit funding or transaction log. Add the adapter method behind the existing venue port (domain port first, then the adapters).
2. Persist each payment idempotently (venue account, instrument, venue payment id or timestamp, amount) so reruns and restarts do not double count.
3. Feed payments into the same realized path as fills (a signed delta that `sumRealizedPnlDeltaByVenueAccount` and `...Since` include), and into the actor's `EquityTracker` and daily-loss tracker.
4. Flip `fundingIncluded` to true for venues that ingest funding. Keep false and the note for the rest.
5. Respect the capital-change baseline: payments before `capital_changed_at` do not count toward `pnlSinceCapitalChange`.
## Acceptance criteria
- A funding payment received or paid on an open perpetual moves `equity` and `lifetimeRealizedPnl` by that amount.
- Replaying the same payment does not change the totals.
- `fundingIncluded` reflects what the venue ingests.
- Behavior tests for each of the above. Run focused tests, then `pnpm lint`, `pnpm build`, `pnpm test`.
## Not verified
- Exact venue endpoints, pagination and rate limits.
- Whether the fills table or a new table should hold the payments.
- Whether paper and shadow simulate funding.
