import { z } from 'zod';
import type { AgentTool, ToolResult, TradingToolContext } from '@traderton/domain';
import { convertZodToJsonSchema } from './registry.js';

// --- get_analytics ---

// LLMs may send booleans as strings; z.coerce.boolean would turn "false" into true.
const lenientBoolean = z.preprocess(
  (value) => (value === 'true' ? true : value === 'false' ? false : value),
  z.boolean(),
);

const GetAnalyticsParamsSchema = z.object({
  // coerce: LLMs may send numbers as strings
  days: z.coerce.number().int().positive().max(90).default(7).describe('Lookback period in days (1-90). Defaults to 7. Ignored when allTime is true.'),
  allTime: lenientBoolean.optional().describe('Set true for lifetime analytics instead of the days window. Defaults to false.'),
});

const getAnalyticsTool: AgentTool<TradingToolContext> = {
  name: 'get_analytics',
  description: 'Get trading analytics for this agent, including both direct agent trades and all bot-created trades. Returns total trades, win rate, P&L, fees, per-bot breakdown, and an agent-direct summary over the specified lookback period (days, max 90), or over the whole lifetime with allTime=true. Results are scoped to the selected venue account. realizedPnlUsd sums closed positions; with allTime=true lifetimeRealizedPnlUsd is also returned: the fee-adjusted realized P&L of the agent\'s own fills (the figure get_account_summary reports as lifetimeRealizedPnl; funding excluded).',
  parametersSchema: GetAnalyticsParamsSchema,
  parameters: convertZodToJsonSchema(GetAnalyticsParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { days, allTime = false } = params as z.infer<typeof GetAnalyticsParamsSchema>;

    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available' };
    }

    const ledger = ctx.accountLedger;
    const analyticsSince = allTime ? undefined : new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const analytics = await ctx.botRepo.getAnalyticsByCreator(
      'agent', ctx.agentId, analyticsSince, undefined, ledger?.venueAccountId,
    );
    const lifetimeRealizedPnlUsd = allTime && ledger ? await ledger.getLifetimeRealizedPnl() : undefined;

    const winRate = analytics.closedPositions > 0
      ? (analytics.winningPositions / analytics.closedPositions) * 100
      : 0;

    return {
      success: true,
      data: {
        ok: true,
        totalTrades: analytics.recentFills,
        winRate: Math.round(winRate * 100) / 100,
        realizedPnlUsd: analytics.realizedPnlUsd,
        totalFeesUsd: analytics.totalFeesUsd,
        openPositions: analytics.openPositions,
        botCount: analytics.botCount,
        avgHoldTimeHours: analytics.avgHoldTimeHours,
        byBot: analytics.byBot,
        agentDirect: analytics.agentDirect,
        days: allTime ? null : days,
        allTime,
        venueAccountId: ledger?.venueAccountId ?? null,
        ...(lifetimeRealizedPnlUsd !== undefined ? { lifetimeRealizedPnlUsd } : {}),
      },
    };
  },
};

// --- list_positions ---

const ListPositionsParamsSchema = z.object({});

const listPositionsTool: AgentTool<TradingToolContext> = {
  name: 'list_positions',
  description: 'List open positions owned by this agent, including bot-created and direct agent positions. Returns ownership, instrument, side, size, entry price, and open timestamp.',
  parametersSchema: ListPositionsParamsSchema,
  parameters: convertZodToJsonSchema(ListPositionsParamsSchema),
  category: 'read-database',
  async execute(_params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available' };
    }

    const openPositions = await ctx.botRepo.getOpenPositionsByCreator('agent', ctx.agentId);

    return {
      success: true,
      data: {
        ok: true,
        note: 'unrealizedPnl not available — mark prices are not cached in the agent process',
        positions: openPositions.map((position) => ({
          actorType: position.actorType,
          actorId: position.actorId,
          botId: position.actorType === 'bot' ? position.actorId : null,
          symbol: position.symbol,
          instrumentId: position.instrumentId ?? null,
          venue: position.venue,
          side: position.side,
          size: position.size,
          entryPrice: position.entryPrice,
          stopLoss: position.stopLoss ?? null,
          takeProfit: position.takeProfit ?? null,
          openedAt: position.openedAt.toISOString(),
        })),
      },
    };
  },
};

export const analyticsTools: AgentTool<TradingToolContext>[] = [
  getAnalyticsTool,
  listPositionsTool,
];
