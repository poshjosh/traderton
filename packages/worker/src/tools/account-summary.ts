import { Decimal, price } from '@traderton/domain';
import { computeAccountEquity } from '@traderton/engine';

/** A position row already enriched by `markOpenPositions`. */
export interface MarkedPosition {
  actorType: 'agent' | 'bot' | 'user' | 'system';
  size: string;
  entryPrice: string;
  markPrice: string | null;
  unrealizedPnl: string | null;
}

/**
 * The equity block of get_account_summary. All amounts are decimal strings in
 * quote currency (USD). Null when the inputs needed to compute them are missing.
 */
export interface AccountEquityView {
  initialCapital: string | null;
  /** Fee-adjusted realized P&L across all fills; never reset by a capital edit. */
  lifetimeRealizedPnl: string | null;
  /** Realized P&L from fills since capitalChangedAt (equals lifetime when never edited). */
  pnlSinceCapitalChange: string | null;
  /** When capital last changed (ISO); null = never edited, the period is the whole lifetime. */
  capitalChangedAt: string | null;
  unrealizedPnlUsd: string | null;
  /** False when at least one agent-direct position has no mark, so unrealizedPnlUsd/equity are partial. */
  unrealizedComplete: boolean | null;
  /** Equity covers only the agent's direct positions and own fills; bot books are excluded. */
  equityScope: 'agent_direct';
  /** Drawdown peak is rebuilt from realized P&L since capitalChangedAt (not the live in-memory peak, not intra-trade highs). */
  drawdownBasis: 'realized_peak';
  equity: string | null;
  /** (equity - initialCapital) / initialCapital * 100 over the current allocation period; null when initialCapital <= 0. */
  returnPct: string | null;
  /** Open agent-direct notional at mark (entry when unmarked), i.e. 1x. Leverage is not modelled. */
  marginUsed: string | null;
  marginBasis: 'notional_1x';
  /** max(0, equity - marginUsed). */
  availableCapital: string | null;
  drawdown: { current: string; currentPct: string; peakEquity: string } | null;
}

export interface AccountPeriod {
  lifetimeRealizedPnl: string | null;
  pnlSinceCapitalChange: string | null;
  capitalChangedAt: string | null;
}

const nullView = (
  initialCapital: string | null,
  period: AccountPeriod,
): AccountEquityView => ({
  initialCapital,
  ...period,
  unrealizedPnlUsd: null,
  unrealizedComplete: null,
  equityScope: 'agent_direct',
  drawdownBasis: 'realized_peak',
  equity: null,
  returnPct: null,
  marginUsed: null,
  marginBasis: 'notional_1x',
  availableCapital: null,
  drawdown: null,
});

/**
 * Equity = initialCapital + pnlSinceCapitalChange + unrealized. After a capital edit the
 * baseline is the new allocation and realized P&L before the edit is excluded (it stays
 * visible as lifetimeRealizedPnl). Unrealized P&L is the open positions' full mark-to-entry
 * figure, including any part accrued before the edit. This mirrors the actor's tracker
 * rehydration, so the tool and the risk gate agree.
 *
 * Equity is the agent actor's equity (same scope as the risk gate's
 * EquityTracker): only agent-direct positions and the agent's own fills count.
 * Bot positions are listed by the tool but belong to the bot actors' own books.
 *
 * `marginUsed` is open notional at mark (entry price when unmarked). Leverage is
 * not modelled by the engine, so this is a 1x, conservative figure.
 */
export function buildAccountEquityView(
  initialCapital: string | null,
  period: AccountPeriod,
  agentPositions: MarkedPosition[],
): AccountEquityView {
  if (initialCapital === null || period.lifetimeRealizedPnl === null || period.pnlSinceCapitalChange === null) {
    return nullView(initialCapital, period);
  }

  let unrealized = new Decimal(0);
  let marginUsed = new Decimal(0);
  let complete = true;
  for (const position of agentPositions) {
    const size = new Decimal(position.size).abs();
    if (position.unrealizedPnl === null || position.markPrice === null) {
      complete = false;
      marginUsed = marginUsed.plus(size.mul(new Decimal(position.entryPrice)));
      continue;
    }
    unrealized = unrealized.plus(new Decimal(position.unrealizedPnl));
    marginUsed = marginUsed.plus(size.mul(new Decimal(position.markPrice)));
  }

  const snapshot = computeAccountEquity({
    initialCapital: price(initialCapital),
    realizedPnl: price(period.pnlSinceCapitalChange),
    unrealizedPnl: unrealized,
  });
  const drawdownPct = snapshot.peakEquity.gt(0)
    ? snapshot.drawdown.div(snapshot.peakEquity).mul(100)
    : new Decimal(0);

  const capital = new Decimal(initialCapital);
  return {
    initialCapital,
    ...period,
    unrealizedPnlUsd: unrealized.toFixed(),
    unrealizedComplete: complete,
    equity: snapshot.equity.toFixed(),
    returnPct: capital.gt(0) ? snapshot.equity.minus(capital).div(capital).mul(100).toFixed() : null,
    equityScope: 'agent_direct',
    drawdownBasis: 'realized_peak',
    marginUsed: marginUsed.toFixed(),
    marginBasis: 'notional_1x',
    availableCapital: Decimal.max(0, snapshot.equity.minus(marginUsed)).toFixed(),
    drawdown: {
      current: snapshot.drawdown.toFixed(),
      currentPct: drawdownPct.toFixed(),
      peakEquity: snapshot.peakEquity.toFixed(),
    },
  };
}
