import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@traderton/domain';
import { analyticsTools } from './analytics.js';

function createToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    redis: {
      hset: vi.fn(async () => 1),
      hget: vi.fn(async () => null),
      publish: vi.fn(async () => 1),
    },
    publishToInbound: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('analyticsTools', () => {
  it('returns list_positions output with explicit ownership for bot-backed positions', async () => {
    const listPositionsTool = analyticsTools.find((tool) => tool.name === 'list_positions');
    expect(listPositionsTool).toBeDefined();

    const result = await listPositionsTool!.execute({}, createToolContext({
      botRepo: {
        getBotsByCreator: vi.fn(),
        getBotById: vi.fn(),
        markBotStopped: vi.fn(),
        markBotRunning: vi.fn(),
        restoreBotRuntimeState: vi.fn(),
        updateBotConfig: vi.fn(),
        getAnalyticsByCreator: vi.fn(),
        getOpenPositionsByCreator: vi.fn(async () => [
          {
            actorType: 'bot',
            actorId: 'bot-1',
            symbol: 'BTC/USD:USD',
            instrumentId: 'BTC-USD',
            venue: 'hyperliquid',
            side: 'long',
            size: '1',
            entryPrice: '50000',
            stopLoss: '45000',
            takeProfit: null,
            openedAt: new Date('2026-06-09T00:00:00.000Z'),
          },
          {
            actorType: 'bot',
            actorId: 'bot-2',
            symbol: 'ETH/USD:USD',
            instrumentId: null,
            venue: 'hyperliquid',
            side: 'long',
            size: '2',
            entryPrice: '3000',
            stopLoss: null,
            takeProfit: '3500',
            openedAt: new Date('2026-06-09T01:00:00.000Z'),
          },
        ]),
      },
    }));

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      ok: true,
      note: 'unrealizedPnl not available — mark prices are not cached in the agent process',
      positions: [
        {
          actorType: 'bot',
          actorId: 'bot-1',
          botId: 'bot-1',
          symbol: 'BTC/USD:USD',
          instrumentId: 'BTC-USD',
          venue: 'hyperliquid',
          side: 'long',
          size: '1',
          entryPrice: '50000',
          stopLoss: '45000',
          takeProfit: null,
          openedAt: '2026-06-09T00:00:00.000Z',
        },
        {
          actorType: 'bot',
          actorId: 'bot-2',
          botId: 'bot-2',
          symbol: 'ETH/USD:USD',
          instrumentId: null,
          venue: 'hyperliquid',
          side: 'long',
          size: '2',
          entryPrice: '3000',
          stopLoss: null,
          takeProfit: '3500',
          openedAt: '2026-06-09T01:00:00.000Z',
        },
      ],
    });
  });

  it('returns list_positions output for direct agent-owned positions without mislabelling them as bots', async () => {
    const listPositionsTool = analyticsTools.find((tool) => tool.name === 'list_positions');
    expect(listPositionsTool).toBeDefined();

    const result = await listPositionsTool!.execute({}, createToolContext({
      botRepo: {
        getBotsByCreator: vi.fn(),
        getBotById: vi.fn(),
        markBotStopped: vi.fn(),
        markBotRunning: vi.fn(),
        restoreBotRuntimeState: vi.fn(),
        updateBotConfig: vi.fn(),
        getAnalyticsByCreator: vi.fn(),
        getOpenPositionsByCreator: vi.fn(async () => [
          {
            actorType: 'agent',
            actorId: 'agent-1',
            symbol: 'SOL',
            instrumentId: 'SOL-PERP',
            venue: 'hyperliquid',
            side: 'long',
            size: '50',
            entryPrice: '67.917',
            stopLoss: null,
            takeProfit: null,
            openedAt: new Date('2026-06-13T12:55:00.000Z'),
          },
        ]),
      },
    }));

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      ok: true,
      note: 'unrealizedPnl not available — mark prices are not cached in the agent process',
      positions: [
        {
          actorType: 'agent',
          actorId: 'agent-1',
          botId: null,
          symbol: 'SOL',
          instrumentId: 'SOL-PERP',
          venue: 'hyperliquid',
          side: 'long',
          size: '50',
          entryPrice: '67.917',
          stopLoss: null,
          takeProfit: null,
          openedAt: '2026-06-13T12:55:00.000Z',
        },
      ],
    });
  });

  it('get_analytics includes agentDirect bucket alongside byBot', async () => {
    const getAnalyticsTool = analyticsTools.find((tool) => tool.name === 'get_analytics');
    expect(getAnalyticsTool).toBeDefined();

    const result = await getAnalyticsTool!.execute({ days: 7 }, createToolContext({
      botRepo: {
        getBotsByCreator: vi.fn(),
        getBotById: vi.fn(),
        markBotStopped: vi.fn(),
        markBotRunning: vi.fn(),
        restoreBotRuntimeState: vi.fn(),
        updateBotConfig: vi.fn(),
        getOpenPositionsByCreator: vi.fn(),
        getAnalyticsByCreator: vi.fn(async () => ({
          botCount: 1,
          openPositions: 2,
          closedPositions: 3,
          winningPositions: 2,
          realizedPnlUsd: '45.00',
          totalFeesUsd: '2.10',
          recentFills: 8,
          avgHoldTimeHours: 4.5,
          byBot: [{ botId: 'bot-1', status: 'running', recentFills: 5, realizedPnlUsd: '30.00' }],
          agentDirect: { recentFills: 3, realizedPnlUsd: '15.00' },
        })),
      },
    }));

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data['totalTrades']).toBe(8);
    expect(data['realizedPnlUsd']).toBe('45.00');
    expect(data['botCount']).toBe(1);
    expect(data['byBot']).toEqual([{ botId: 'bot-1', status: 'running', recentFills: 5, realizedPnlUsd: '30.00' }]);
    expect(data['agentDirect']).toEqual({ recentFills: 3, realizedPnlUsd: '15.00' });
  });

  it('get_analytics returns a zeroed agentDirect bucket when no agent-direct trades exist', async () => {
    const getAnalyticsTool = analyticsTools.find((tool) => tool.name === 'get_analytics');
    expect(getAnalyticsTool).toBeDefined();

    const result = await getAnalyticsTool!.execute({ days: 7 }, createToolContext({
      botRepo: {
        getBotsByCreator: vi.fn(),
        getBotById: vi.fn(),
        markBotStopped: vi.fn(),
        markBotRunning: vi.fn(),
        restoreBotRuntimeState: vi.fn(),
        updateBotConfig: vi.fn(),
        getOpenPositionsByCreator: vi.fn(),
        getAnalyticsByCreator: vi.fn(async () => ({
          botCount: 0,
          openPositions: 0,
          closedPositions: 0,
          winningPositions: 0,
          realizedPnlUsd: '0',
          totalFeesUsd: '0',
          recentFills: 0,
          avgHoldTimeHours: null,
          byBot: [],
          agentDirect: { recentFills: 0, realizedPnlUsd: '0.00' },
        })),
      },
    }));

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data['agentDirect']).toEqual({ recentFills: 0, realizedPnlUsd: '0.00' });
    expect(data['botCount']).toBe(0);
  });
});
describe('get_analytics allTime', () => {
  const getAnalyticsTool = analyticsTools.find((tool) => tool.name === 'get_analytics')!;
  const analytics = {
    botCount: 0, openPositions: 0, closedPositions: 4, winningPositions: 3, realizedPnlUsd: '120.00',
    totalFeesUsd: '5.00', recentFills: 9, avgHoldTimeHours: 2, byBot: [], agentDirect: { recentFills: 9, realizedPnlUsd: '120.00' },
  };

  function ctxWith(getAnalyticsByCreator: ReturnType<typeof vi.fn>, withLedger = true): ToolContext {
    return createToolContext({
      botRepo: { getAnalyticsByCreator } as unknown as ToolContext['botRepo'],
      ...(withLedger ? {
        accountLedger: {
          venueAccountId: 'va-1',
          getLifetimeRealizedPnl: vi.fn(async () => '117.5'),
          capitalChangedAt: null,
          getRealizedPnlSinceCapitalChange: vi.fn(async () => '117.5'),
          getLatestVenueBalance: vi.fn(async () => null),
        },
      } : {}),
    });
  }

  it('queries without a time window when allTime is true', async () => {
    const query = vi.fn(async () => analytics);
    const result = await getAnalyticsTool.execute({ allTime: true }, ctxWith(query));
    expect(result.success).toBe(true);
    expect(query).toHaveBeenCalledWith('agent', 'agent-1', undefined, undefined, 'va-1');
    const data = result.data as Record<string, unknown>;
    expect(data['allTime']).toBe(true);
    expect(data['days']).toBeNull();
  });

  it('returns fee-adjusted lifetime realized P&L for the venue account when allTime is true', async () => {
    const result = await getAnalyticsTool.execute({ allTime: true }, ctxWith(vi.fn(async () => analytics)));
    expect((result.data as Record<string, unknown>)['lifetimeRealizedPnlUsd']).toBe('117.5');
  });

  it('keeps the days window and omits lifetime P&L when allTime is not set', async () => {
    const query = vi.fn(async () => analytics);
    const before = Date.now();
    const result = await getAnalyticsTool.execute({ days: 3 }, ctxWith(query));
    const since = (query.mock.calls[0] as unknown[])[2] as Date;
    expect(before - since.getTime()).toBeGreaterThanOrEqual(3 * 86_400_000);
    const data = result.data as Record<string, unknown>;
    expect(data['days']).toBe(3);
    expect(data['allTime']).toBe(false);
    expect(data).not.toHaveProperty('lifetimeRealizedPnlUsd');
  });

  it('accepts allTime sent as a string and treats "false" as false', () => {
    const schema = getAnalyticsTool.parametersSchema!;
    expect((schema.parse({ allTime: 'true' }) as { allTime: boolean }).allTime).toBe(true);
    expect((schema.parse({ allTime: 'false' }) as { allTime: boolean }).allTime).toBe(false);
  });

  it('leaves the query unscoped when no venue ledger is bound', async () => {
    const query = vi.fn(async () => analytics);
    const result = await getAnalyticsTool.execute({ allTime: true }, ctxWith(query, false));
    expect(query).toHaveBeenCalledWith('agent', 'agent-1', undefined, undefined, undefined);
    expect((result.data as Record<string, unknown>)['lifetimeRealizedPnlUsd']).toBeNull();
  });
});
