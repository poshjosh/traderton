# Bug Report: agent shadow-mode limit orders are never resolved, so their fills never reach realized P&L
- **Status:** OPEN. Not fixed. Found while implementing 001 item 1. No work started.
- **Severity:** Medium. In shadow mode a limit order from an agent stays pending forever. No fill, no `realized_pnl_delta`, so equity, `get_account_summary` and the risk gate miss that trade.
- **Date:** 2026-11-21
- **Environment:** code analysis only. Not reproduced live. Shadow mode only (paper fills at once).
- **Related:** `001-get-account-summary-returns-initial-capital-no-equity-or-pnl.md`
## Summary
`ShadowExecutor` holds pending limit orders and fills them through `resolvePendingLimits()` (`packages/engine/src/shadow-executor.ts`). The bot actor calls it on its scan loop (`packages/worker/src/trading-actor.ts` ~1550). `agent-trading-actor.ts` never calls it.
## Impact
- Agent-direct shadow limit orders never fill, so the agent's simulated results omit them.
- The agent may see a pending order that never completes, and may resubmit.
## Proposed fix
Call `resolvePendingLimits()` from the agent actor's loop and route the resulting fills through the same fill-accounting path as other fills. Follow the bot actor's pattern, and keep the loop rescheduling on failure.
## Acceptance criteria
- A shadow limit order that crosses the market fills, writes a fill with `realized_pnl_delta` where it closes a position, and moves `get_account_summary.equity`.
- A limit order that does not cross stays pending.
- Behavior tests for both. Run focused tests, then `pnpm lint`, `pnpm build`, `pnpm test`.
## Not verified
- Not reproduced; found by reading source.
- Whether the live agent actor handles venue limit fills elsewhere.
