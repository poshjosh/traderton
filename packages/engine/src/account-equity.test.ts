import { describe, it, expect } from 'vitest';
import { price } from '@traderton/domain';
import { EquityTracker } from './equity-tracker.js';
import { computeAccountEquity } from './account-equity.js';

describe('computeAccountEquity', () => {
  it('computes equity as initial capital plus realized plus unrealized', () => {
    const snap = computeAccountEquity({ initialCapital: price('10000'), realizedPnl: price('-300'), unrealizedPnl: price('120') });
    expect(snap.equity.toFixed()).toBe('9820');
  });

  it('agrees with the risk-gate equity tracker', () => {
    const tracker = new EquityTracker(price('5000'), price('250'));
    const snap = computeAccountEquity({ initialCapital: price('5000'), realizedPnl: price('250'), unrealizedPnl: price('-75') });
    expect(snap.equity.eq(tracker.currentEquity(price('-75')))).toBe(true);
    expect(snap.drawdown.eq(tracker.currentDrawdown(price('-75')))).toBe(true);
  });

  it('reports zero drawdown when equity is at its peak', () => {
    const snap = computeAccountEquity({ initialCapital: price('1000'), realizedPnl: price('100'), unrealizedPnl: price('50') });
    expect(snap.drawdown.toFixed()).toBe('0');
    expect(snap.peakEquity.toFixed()).toBe('1150');
  });
});
