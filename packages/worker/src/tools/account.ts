import { z } from 'zod';
import { count, eq } from 'drizzle-orm';
import type { AgentTool, ToolResult, TradingToolContext } from '@traderton/domain';
import type { Database } from '@traderton/db';
import { venueAccounts } from '@traderton/db';
import { convertZodToJsonSchema } from './registry.js';
import { markOpenPositions, POSITION_MARK_BUDGET_MS } from './position-marks.js';
import { buildAccountEquityView } from './account-summary.js';
import { AgentRiskSpecFieldsSchema, llmEmptyParamsSchema } from './risk-limits.js';
import { createLogger } from '../logger.js';

const logger = createLogger('tools:account');

// --- get_account_summary ---

// A3: the PLATFORM attaches the risk spec to this read call (same fields as
// get_risk_limits) — declared here so Zod keeps them; the context factory binds
// them via the RiskSource seam (capital feeds the summary + riskContractOps).
const GetAccountSummaryParamsSchema = z.object({
  ...AgentRiskSpecFieldsSchema,
});

const getAccountSummaryTool: AgentTool<TradingToolContext> = {
  name: 'get_account_summary',
  description: 'Get a summary of the agent\'s trading account: initialCapital (the configured allocation, NOT current funds), lifetimeRealizedPnl (all-time, fees included, funding excluded), pnlSinceCapitalChange (realized since capitalChangedAt; equals lifetime when capital was never edited), unrealizedPnlUsd (from current marks), equity (= initialCapital + pnlSinceCapitalChange + unrealized; equityScope=agent_direct: agent-direct positions and own fills only, bot books excluded), marginUsed (open notional at 1x, leverage not modelled), returnPct (equity vs initialCapital, since capitalChangedAt), availableCapital (= max(0, equity - marginUsed)), drawdown (drawdownBasis=realized_peak: peak rebuilt from realized P&L since capitalChangedAt), venueBalance (live mode only: the latest persisted snapshot, not a fresh venue fetch), open positions with markPrice/unrealizedPnl, and risk limits. Use availableCapital and equity, not initialCapital, to compute position sizes (targetSize) before calling submit_decision.',
  parametersSchema: GetAccountSummaryParamsSchema,
  // Spec fields are platform-injected post-LLM — the LLM-facing JSON schema is
  // the empty contract (see risk-limits.ts).
  parameters: convertZodToJsonSchema(llmEmptyParamsSchema),
  category: 'read-database',
  promptGuidance: 'Call get_account_summary before submit_decision to see equity, availableCapital and open positions. initialCapital is the configured allocation, not current funds: size from equity/availableCapital. targetSize is in base units — the amount of the asset being bought or sold. targetSize is always required; if equity is null, use a conservative size (about 5% of the configured allocation). Figures include fees but exclude funding payments (fundingIncluded: false).',
  async execute(_params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    if (!ctx.botRepo) {
      return {
        success: false,
        fault: false,
        error: 'Database access not available in this context',
        errorCode: 'account.db_unavailable',
      };
    }

    try {
      // Gather positions for both agent-direct and bot-managed, scoped to the
      // selected venue account (same scope as the engine's equity tracker).
      const ledger = ctx.accountLedger;
      const allPositions = (await ctx.botRepo.getOpenPositionsByCreator('agent', ctx.agentId))
        .filter((p) => !ledger || p.venueAccountId === undefined || p.venueAccountId === ledger.venueAccountId);
      const agentPositions = allPositions.filter((p) => p.actorType === 'agent');
      const botPositions = allPositions.filter((p) => p.actorType === 'bot');

      // Collect warnings for partially-available data
      const warnings: string[] = [];

      // Get risk contract for current limits
      let riskContract: Record<string, unknown> | null = null;
      if (ctx.riskContractOps) {
        try {
          const contract = await ctx.riskContractOps.getContract();
          riskContract = {
            maxOpenPositions: contract.maxOpenPositions.effectiveValue,
            maxOpenPositionsSource: contract.maxOpenPositions.source,
            maxPositionSizePct: contract.maxPositionSizePct.effectiveValue,
            maxPositionSizePctSource: contract.maxPositionSizePct.source,
            stopLossCooldownMs: contract.stopLossCooldownMs.effectiveValue,
          };
        } catch (err) {
          warnings.push('risk_contract_unavailable');
          logger.warn({ agentId: ctx.agentId, err }, 'get_account_summary: risk contract unavailable');
        }
      } else {
        warnings.push('risk_contract_unavailable');
      }

      // Get agent config for capital and sizing info
      let initialCapital: string | null = null;
      let executionMode: string | null = null;
      let fixedPositionSize: string | null = null;
      let positionSizeMode: string | null = null;

      if (ctx.executionConfig) {
        try {
          const config = await ctx.executionConfig.getExecutionConfig();
          if (config) {
            executionMode = config.mode ?? null;
            fixedPositionSize = config.fixedPositionSize ?? null;
            positionSizeMode = config.positionSizeMode ?? null;
          }
        } catch (err) {
          warnings.push('agent_config_unavailable');
          logger.warn({ agentId: ctx.agentId, err }, 'get_account_summary: agent config unavailable');
        }
      } else {
        warnings.push('agent_config_unavailable');
      }

      // Get agent capital from agentRepo if available
      if (ctx.agentRepo) {
        try {
          const agent = await ctx.agentRepo.getAgent(ctx.agentId);
          if (agent) {
            initialCapital = agent.capital;
          }
        } catch (err) {
          warnings.push('agent_repo_unavailable');
          logger.warn({ agentId: ctx.agentId, err }, 'get_account_summary: agent repo unavailable');
        }
      } else {
        warnings.push('agent_repo_unavailable');
      }

      const effectiveMode = executionMode ?? ctx.executionMode;

      // Lifetime fee-adjusted realized P&L: the same fills sum the agent actor
      // rehydrates its EquityTracker from, so tool and risk gate agree.
      let lifetimeRealizedPnl: string | null = null;
      let pnlSinceCapitalChange: string | null = null;
      if (ledger) {
        try {
          lifetimeRealizedPnl = await ledger.getLifetimeRealizedPnl();
          // Never edited: the period is the whole lifetime, so skip the second query.
          pnlSinceCapitalChange = ledger.capitalChangedAt === null
            ? lifetimeRealizedPnl
            : await ledger.getRealizedPnlSinceCapitalChange();
        } catch (err) {
          warnings.push('realized_pnl_unavailable');
          logger.warn({ agentId: ctx.agentId, err }, 'get_account_summary: realized P&L unavailable');
        }
      } else {
        warnings.push('realized_pnl_unavailable');
      }

      // Mark open positions (best-effort; unmarked rows carry null mark fields).
      const asOf = new Date();
      // Only agent-direct rows feed equity, so only they are marked; bot rows
      // keep null mark fields rather than spending the mark budget.
      const markedAgent = await markOpenPositions(
        agentPositions.map((p) => ({ ...p, closedAt: null })),
        {
          priceService: ctx.priceService,
          oneInchConfig: ctx.oneInchPriceChainConfig,
          budgetMs: POSITION_MARK_BUDGET_MS,
          now: asOf,
        },
      );

      const equityView = buildAccountEquityView(
        initialCapital,
        {
          lifetimeRealizedPnl,
          pnlSinceCapitalChange,
          capitalChangedAt: ledger?.capitalChangedAt ?? null,
        },
        markedAgent,
      );
      const marked = [
        ...markedAgent,
        ...botPositions.map((p) => ({ ...p, markPrice: null, unrealizedPnl: null, markedAt: null })),
      ];
      if (equityView.equity !== null && !equityView.unrealizedComplete) {
        warnings.push('unrealized_pnl_incomplete');
      }

      // Live mode: latest persisted venue balance, reported separately — never
      // substituted for availableCapital.
      let venueBalance: unknown = null;
      if (effectiveMode === 'live' && ledger) {
        try {
          venueBalance = await ledger.getLatestVenueBalance();
        } catch (err) {
          warnings.push('venue_balance_unavailable');
          logger.warn({ agentId: ctx.agentId, err }, 'get_account_summary: venue balance unavailable');
        }
      }

      const positions = marked.map((p) => ({
        actorType: p.actorType,
        actorId: p.actorId,
        symbol: p.symbol,
        side: p.side,
        size: p.size,
        entryPrice: p.entryPrice,
        openedAt: p.openedAt,
        markPrice: p.markPrice,
        unrealizedPnl: p.unrealizedPnl,
        markedAt: p.markedAt,
      }));

      return {
        success: true,
        data: {
          ok: true,
          agentId: ctx.agentId,
          asOf: asOf.toISOString(),
          ...equityView,
          fundingIncluded: false,
          fundingNote: 'P&L and equity include trading fees but exclude funding payments.',
          venueBalance: effectiveMode === 'live' ? venueBalance : undefined,
          executionMode: effectiveMode,
          positionSizeMode: positionSizeMode ?? 'unknown',
          fixedPositionSize: fixedPositionSize ?? null,
          openPositionCount: agentPositions.length + botPositions.length,
          agentDirectPositions: agentPositions.length,
          botManagedPositions: botPositions.length,
          positions,
          riskLimits: riskContract ?? 'unavailable',
          warnings: warnings.length > 0 ? warnings : undefined,
          guidance: equityView.equity !== null
            ? `Equity: ${equityView.equity}; available capital: ${equityView.availableCapital} (initial allocation ${equityView.initialCapital} is not current funds). Equity and P&L cover agent-direct positions only. targetSize for submit_decision is in base units — the amount of the asset being bought or sold, not a dollar value. A typical position size is 5–10% of equity; adjust up or down based on conviction and risk limits.`
            : 'Equity unavailable. targetSize for submit_decision is in base units — the amount of the asset being bought or sold. You must provide a value; a conservative starting point is 5% of your configured allocation.',
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      return {
        success: false,
        fault: false,
        error: `Failed to get account summary: ${message}`,
        errorCode: 'account.summary_failed',
      };
    }
  },
};

// --- count_venue_accounts ---
//
// AUTHORED SEAM (L3-P1b obligation-1 fix) — a boundary READ tool returning the
// owner's venue-account count from Traderton's DB (the system of record). The
// consumer (herobids) enforces its OWN plan limit against this count — policy
// stays consumer-owned; Traderton owns only the data + answers "how many".
// read-database → the resolver short-circuits it (no venue account required).

const CountVenueAccountsParamsSchema = z.object({});

const countVenueAccountsTool: AgentTool<TradingToolContext> = {
  name: 'count_venue_accounts',
  description: "Count the venue accounts owned by the caller. Returns { count }. Use this to check a per-plan venue-account entitlement before provisioning a new one; enforcement (the limit) is the consumer's own concern.",
  parametersSchema: CountVenueAccountsParamsSchema,
  parameters: convertZodToJsonSchema(CountVenueAccountsParamsSchema),
  category: 'read-database',
  async execute(_params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    if (!ctx.db) {
      return {
        success: false,
        fault: true,
        error: 'Database access not available in this context',
        errorCode: 'account.db_unavailable',
      };
    }
    if (!ctx.ownerId || !ctx.ownerId.trim()) {
      return {
        success: false,
        fault: true,
        error: 'Owner identity not available in this context',
        errorCode: 'account.owner_unavailable',
      };
    }
    const db = ctx.db as Database;
    try {
      const [row] = await db
        .select({ value: count() })
        .from(venueAccounts)
        .where(eq(venueAccounts.ownerId, ctx.ownerId));
      return { success: true, data: { count: row?.value ?? 0 } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      logger.error({ ownerId: ctx.ownerId, err }, 'count_venue_accounts failed');
      return {
        success: false,
        fault: true,
        error: `Failed to count venue accounts: ${message}`,
        errorCode: 'account.count_failed',
      };
    }
  },
};

export const accountTools: AgentTool<TradingToolContext>[] = [getAccountSummaryTool, countVenueAccountsTool];
