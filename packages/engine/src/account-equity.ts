import type { Price } from '@traderton/domain';
import { EquityTracker } from './equity-tracker.js';

export interface AccountEquityInput {
  initialCapital: Price;
  /** Lifetime fee-adjusted realized P&L (sum of fills.realized_pnl_delta). */
  realizedPnl: Price;
  unrealizedPnl: Price;
}

export interface AccountEquitySnapshot {
  equity: Price;
  peakEquity: Price;
  /** Peak-to-current equity drop, always >= 0. */
  drawdown: Price;
}

/**
 * Read-side equity for tools. Delegates to the same `EquityTracker` the risk
 * gate uses (decision-intake), so a tool and the gate cannot disagree on the
 * formula: equity = initialCapital + realized + unrealized.
 *
 * The peak is rebuilt from lifetime realized P&L (same approximation as the
 * actor's start-up rehydration), not from the live actor's in-memory peak.
 */
export function computeAccountEquity(input: AccountEquityInput): AccountEquitySnapshot {
  const tracker = new EquityTracker(input.initialCapital, input.realizedPnl);
  const equity = tracker.currentEquity(input.unrealizedPnl);
  return {
    equity,
    peakEquity: tracker.peakEquity,
    drawdown: tracker.currentDrawdown(input.unrealizedPnl),
  };
}
