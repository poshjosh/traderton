import { z } from 'zod';
import { and, asc, desc, eq, gte, inArray, lte, sql, sum } from 'drizzle-orm';
import type { AgentTool, ManageBotResult, ToolResult, TradingToolContext } from '@traderton/domain';
import { AGENT_MESSAGE_TYPES, checkModeEscalation, deriveStrategyPreset, extractStrategyFromConfig } from '@traderton/domain';
import type { Database } from '@traderton/db';
import { fills, journalEvents, positions, bots, venueAccounts, FillRepository, PositionRepository, PgJournal, ReconciliationEventRepository } from '@traderton/db';
import { convertZodToJsonSchema } from './registry.js';
import { createLogger } from '../logger.js';

const logger = createLogger('tools:bots');

// --- Agent-facing strategy input — discriminated union on strategy type ---

const StrategyInputSchema = z.discriminatedUnion('type', [
  // DCA: timer-driven, no decision mode
  z.object({
    type: z.literal('dca'),
    params: z.record(z.unknown()).optional(),
  }).describe('Dollar-cost averaging — buys on a fixed schedule, no signal required'),

  // Signal-based: decisionMode selects the engine
  z.object({
    type: z.enum(['momentum', 'range', 'contrarian', 'swing', 'scalper']),
    decisionMode: z.enum(['mechanical', 'llm', 'hybrid'])
      .describe('mechanical = indicator rules; llm = LLM decides; hybrid = indicators pre-filter then LLM'),
    params: z.record(z.unknown()).optional(),
  }),
]);

const BotConfigInputSchema = z.object({
  symbol: z.string().describe('Trading symbol, e.g. "HYPE-USDT"'),
  strategy: StrategyInputSchema,
  execution: z.object({
    mode: z.enum(['paper', 'shadow', 'live']).optional(),
    // coerce: LLMs may send numbers as strings
    slippageBps: z.coerce.number().optional(),
  }).optional(),
  risk: z.record(z.unknown()).optional(),
  // venue and venueType are omitted — injected from the trading connection by the broker
});

// --- create_bot ---

const CreateBotParamsSchema = z.object({
  connectionId: z.string().optional().transform(v => v === '' ? undefined : v).describe('Connection ID to use. You can find this in the Capability Readiness section as "connection=<id>". Omit to use your default trading connection.'),
  config: BotConfigInputSchema.optional().describe('Bot configuration (strategy, symbol, risk params). venue is resolved from your trading connection automatically.'),
  rationale: z.string().max(500).optional().describe('Brief rationale for creating this bot. Used for audit.'),
  dryRun: z.boolean().optional().describe('If true, validates the bot config without creating it. Returns a preview of what would be sent.'),
});

const createBotTool: AgentTool<TradingToolContext> = {
  name: 'create_bot',
  description: 'Create and start a new trading bot. The bot will run independently with its own strategy and risk parameters. Use when you want to delegate a trading opportunity to an automated bot.',
  parametersSchema: CreateBotParamsSchema,
  parameters: convertZodToJsonSchema(CreateBotParamsSchema),
  category: 'execute-trade',
  promptGuidance: 'dryRun=true previews the bot config without creating it. Use find_instrument to look up the correct config.symbol (use the symbol field from the result). get_schema("create_bot.config.strategy") and get_schema("create_bot.config.execution") show available strategy and execution options.',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { connectionId, config, rationale, dryRun } = params as z.infer<typeof CreateBotParamsSchema>;

    // Dry-run: validate and preview without creating.
    // Schema-level validation (shape, types, required fields) has already run
    // via Zod in executeTool(). Full business-logic validation (strategy params
    // validity, venue availability, risk limits) runs at engine publish time.
    if (dryRun) {
      return {
        success: true,
        data: {
          ok: true,
          dryRun: true,
          preview: {
            connectionId: connectionId ?? '(default trading connection)',
            config: config ?? null,
            rationale: rationale ?? null,
          },
          note: 'Dry run — schema-level validation passed. NOT created. Additional engine validation (strategy params, venue, risk) runs at creation time. Remove dryRun=true to execute.',
        },
      };
    }

    let result: void | ManageBotResult;
    try {
      result = await ctx.publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, {
        action: 'create_and_start',
        connectionId,
        config,
        rationale,
      });
    } catch (err) {
      // The execution-capability guard (B1) rejects paper+swap synchronously with
      // a DEDICATED namespaced code (`execution_capability.paper_swap_not_supported`).
      // Surface it as a content-level failure (fault:false) so the boundary maps it
      // to a 400 (validation.invalid_payload) — the closed boundary failure union
      // (005) cannot carry a dedicated code, so the dedicated identity rides in the
      // errorCode (threaded into the boundary failure `details`) AND the message.
      // Any other thrown error propagates unchanged (→ internal.non_retryable).
      const code = (err as { code?: unknown }).code;
      if (typeof code === 'string' && code.startsWith('execution_capability.')) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          errorCode: code,
          fault: false,
        };
      }
      throw err;
    }

    // The bot row + its id are persisted SYNCHRONOUSLY by the drive path (A1); only
    // the actor START is deferred. Surface the id so the consumer sees it in
    // data.botId without waiting for the next tick.
    return {
      success: true,
      data: {
        ok: true,
        botId: result?.botId,
        note: 'bot created — the row and id are available now; the bot actor starts on the next tick',
      },
    };
  },
};

// --- list_bots ---

const ListBotsParamsSchema = z.object({
  // coerce: LLMs may send numbers as strings
  days: z.coerce.number().int().positive().optional().describe('Only return bots created within this many days'),
});

const listBotsTool: AgentTool<TradingToolContext> = {
  name: 'list_bots',
  description: 'List bots created by this agent. Optionally filter by creation date (days). Returns bot ID, status, strategy preset, and symbol.',
  parametersSchema: ListBotsParamsSchema,
  parameters: convertZodToJsonSchema(ListBotsParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { days } = params as z.infer<typeof ListBotsParamsSchema>;

    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available', fault: false };
    }

    const since = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : undefined;
    const botRows = await ctx.botRepo.getBotsByCreator('agent', ctx.agentId, since);

    return {
      success: true,
      data: {
        ok: true,
        bots: botRows.map((b) => ({
          id: b.id,
          status: b.status,
          strategyPreset: deriveStrategyPreset(extractStrategyFromConfig(b.config)?.type),
          symbol: b.config['symbol'] ?? null,
          createdAt: b.createdAt.toISOString(),
        })),
      },
    };
  },
};

// --- get_bot_status ---

const GetBotStatusParamsSchema = z.object({
  botId: z.string().min(1).describe('ID of the bot to query'),
});

const getBotStatusTool: AgentTool<TradingToolContext> = {
  name: 'get_bot_status',
  description: 'Get detailed status for a specific bot. Returns configuration, runtime state, and timestamps. Only works for bots owned by this agent.',
  parametersSchema: GetBotStatusParamsSchema,
  parameters: convertZodToJsonSchema(GetBotStatusParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { botId } = params as z.infer<typeof GetBotStatusParamsSchema>;

    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available', fault: false };
    }

    const bot = await ctx.botRepo.getBotById(botId);
    if (!bot || bot.creatorType !== 'agent' || bot.creatorId !== ctx.agentId) {
      return { success: false, error: `bot ${botId} not found or not owned by this agent`, fault: false };
    }

    return {
      success: true,
      data: {
        ok: true,
        id: bot.id,
        status: bot.status,
        strategyPreset: deriveStrategyPreset(extractStrategyFromConfig(bot.config)?.type),
        symbol: bot.config['symbol'] ?? null,
        config: bot.config,
        startedAt: bot.startedAt?.toISOString() ?? null,
        stoppedAt: bot.stoppedAt?.toISOString() ?? null,
      },
    };
  },
};

// --- list_owner_bots ---
//
// Owner-scoped adapt of list_bots: scopes by ctx.ownerId (the tenancy boundary)
// instead of ('agent', ctx.agentId), returning ALL bots for the owner regardless
// of creatorType. Payload shape matches list_bots field-for-field. Copy/adapt of
// the creator-scoped read path re-keyed to the soft `ownerId` column — NOT
// authored trading behaviour (004 "Bot-consumer contract", ruling 4).

const ListOwnerBotsParamsSchema = z.object({
  // coerce: LLMs may send numbers as strings
  days: z.coerce.number().int().positive().optional().describe('Only return bots created within this many days'),
});

const listOwnerBotsTool: AgentTool<TradingToolContext> = {
  name: 'list_owner_bots',
  description: 'List all bots owned by this owner, regardless of which actor created them. Optionally filter by creation date (days). Returns bot ID, status, strategy preset, and symbol.',
  parametersSchema: ListOwnerBotsParamsSchema,
  parameters: convertZodToJsonSchema(ListOwnerBotsParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { days } = params as z.infer<typeof ListOwnerBotsParamsSchema>;

    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available', fault: false };
    }
    if (!ctx.ownerId) {
      return { success: false, error: 'owner scope not available', fault: false };
    }

    const since = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : undefined;
    const botRows = await ctx.botRepo.getBotsByOwner(ctx.ownerId, since);

    return {
      success: true,
      data: {
        ok: true,
        bots: botRows.map((b) => ({
          id: b.id,
          status: b.status,
          strategyPreset: deriveStrategyPreset(extractStrategyFromConfig(b.config)?.type),
          symbol: b.config['symbol'] ?? null,
          createdAt: b.createdAt.toISOString(),
          // Owner-scoped ADDITIVE divergence (004 ruling 4): surface who created
          // each bot. The agent-scoped list_bots stays UNCHANGED.
          creatorType: b.creatorType,
          creatorId: b.creatorId,
        })),
      },
    };
  },
};

// --- get_owner_bot_status ---
//
// Owner-scoped adapt of get_bot_status: resolves via getBotByIdForOwner(botId,
// ctx.ownerId) so the not-found behaviour also covers bots that don't belong to
// the owner. Same payload shape as get_bot_status.

const GetOwnerBotStatusParamsSchema = z.object({
  botId: z.string().min(1).describe('ID of the bot to query'),
});

const getOwnerBotStatusTool: AgentTool<TradingToolContext> = {
  name: 'get_owner_bot_status',
  description: 'Get detailed status for a specific bot. Returns configuration, runtime state, and timestamps. Only works for bots owned by this owner.',
  parametersSchema: GetOwnerBotStatusParamsSchema,
  parameters: convertZodToJsonSchema(GetOwnerBotStatusParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { botId } = params as z.infer<typeof GetOwnerBotStatusParamsSchema>;

    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available', fault: false };
    }
    if (!ctx.ownerId) {
      return { success: false, error: 'owner scope not available', fault: false };
    }

    const bot = await ctx.botRepo.getBotByIdForOwner(botId, ctx.ownerId);
    if (!bot) {
      return { success: false, error: `bot ${botId} not found or not owned by this owner`, fault: false };
    }

    return {
      success: true,
      data: {
        ok: true,
        id: bot.id,
        status: bot.status,
        strategyPreset: deriveStrategyPreset(extractStrategyFromConfig(bot.config)?.type),
        symbol: bot.config['symbol'] ?? null,
        config: bot.config,
        startedAt: bot.startedAt?.toISOString() ?? null,
        stoppedAt: bot.stoppedAt?.toISOString() ?? null,
        // Owner-scoped ADDITIVE divergence (004 ruling 4): surface who created
        // the bot. The agent-scoped get_bot_status stays UNCHANGED.
        creatorType: bot.creatorType,
        creatorId: bot.creatorId,
      },
    };
  },
};

// --- Owner-scoped bot read-wave (Wave A2, 004 2026-09-12) ───────────────────
//
// UN-QUARANTINE + adapt: the aggregation bodies are COPIED byte-for-byte from
// the quarantined herobids route (packages/worker/src/_deferred-authoring/
// api-routes/bots.ts) — fee-grouping, session-pairing, the journal query, and
// the summary. The ONLY adaptation is re-keying the ownership check from the
// local `bots where(id, userId)` lookup to the owner-scoped
// `getBotByIdForOwner(botId, ctx.ownerId)`, and returning the SAME payload shape
// the herobids endpoint returns today. Aggregation stays in Traderton — NOT
// authored trading behaviour (004 "Wave A2"; ruling 4).
//
// Guards mirror list_owner_bots (fault:false): botRepo absent →
// 'direct db access not available'; ownerId absent → 'owner scope not
// available'. Owner-scoped existence via getBotByIdForOwner → absent →
// not_found.resource (fault:false), identical to get_owner_bot_status. The
// aggregation tools additionally need the raw Drizzle handle (ctx.db) for the
// copied table queries. Category read-database → the boundary resolver
// short-circuits venue resolution (no ownerScopedNoVenue flag needed — that
// flag is only for owner-scoped WRITES that drive no executor).

// --- get_owner_bot_costs ---

const GetOwnerBotCostsParamsSchema = z.object({
  botId: z.string().min(1).describe('ID of the bot to query'),
});

const getOwnerBotCostsTool: AgentTool<TradingToolContext> = {
  name: 'get_owner_bot_costs',
  description: 'Get total trading fees for a specific bot, grouped by fee currency. Only works for bots owned by this owner.',
  parametersSchema: GetOwnerBotCostsParamsSchema,
  parameters: convertZodToJsonSchema(GetOwnerBotCostsParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { botId } = params as z.infer<typeof GetOwnerBotCostsParamsSchema>;

    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available', fault: false };
    }
    if (!ctx.ownerId) {
      return { success: false, error: 'owner scope not available', fault: false };
    }
    if (!ctx.db) {
      return { success: false, error: 'direct db access not available', fault: false };
    }

    const bot = await ctx.botRepo.getBotByIdForOwner(botId, ctx.ownerId);
    if (!bot) {
      return { success: false, fault: false, errorCode: 'not_found.resource', error: `bot ${botId} not found or not owned by this owner` };
    }

    const db = ctx.db as Database;

    // Group by feeCurrency to avoid summing across heterogeneous assets.
    const feeRows = await db
      .select({ feeCurrency: fills.feeCurrency, total: sum(fills.fee) })
      .from(fills)
      .where(and(eq(fills.actorType, 'bot'), eq(fills.actorId, botId)))
      .groupBy(fills.feeCurrency);

    const feesByCurrency: Record<string, string> = {};
    for (const row of feeRows) {
      feesByCurrency[row.feeCurrency ?? 'unknown'] = row.total ?? '0';
    }

    return { success: true, data: { ok: true, botId, feesByCurrency } };
  },
};

// --- get_owner_bot_sessions ---

const GetOwnerBotSessionsParamsSchema = z.object({
  botId: z.string().min(1).describe('ID of the bot to query'),
  // coerce: LLMs may send numbers as strings
  limit: z.coerce.number().int().positive().optional().describe('Max sessions to return (default 20, max 100)'),
  offset: z.coerce.number().int().nonnegative().optional().describe('Number of sessions to skip (default 0)'),
});

const getOwnerBotSessionsTool: AgentTool<TradingToolContext> = {
  name: 'get_owner_bot_sessions',
  description: 'Get lifecycle sessions for a specific bot, derived by pairing instance start/stop events. Newest first, paginated. Only works for bots owned by this owner.',
  parametersSchema: GetOwnerBotSessionsParamsSchema,
  parameters: convertZodToJsonSchema(GetOwnerBotSessionsParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { botId, limit: rawLimit, offset: rawOffset } = params as z.infer<typeof GetOwnerBotSessionsParamsSchema>;

    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available', fault: false };
    }
    if (!ctx.ownerId) {
      return { success: false, error: 'owner scope not available', fault: false };
    }
    if (!ctx.db) {
      return { success: false, error: 'direct db access not available', fault: false };
    }

    const bot = await ctx.botRepo.getBotByIdForOwner(botId, ctx.ownerId);
    if (!bot) {
      return { success: false, fault: false, errorCode: 'not_found.resource', error: `bot ${botId} not found or not owned by this owner` };
    }

    const db = ctx.db as Database;

    // Same clamping the herobids /sessions endpoint applies to its query params.
    const limit = Math.min(rawLimit ?? 20, 100);
    const offset = rawOffset ?? 0;

    // Derive sessions by pairing instance.started / instance.stopped events.
    // Fetch ascending so pairs can be built left-to-right, then reverse for newest-first output.
    // (limit + offset) * 2 + 2 bounds the fetch to what's needed for a single page.
    const maxEvents = (limit + offset) * 2 + 2;
    const rawEvents = await db.select()
      .from(journalEvents)
      .where(and(
        eq(journalEvents.actorId, botId),
        inArray(journalEvents.type, ['instance.started', 'instance.stopped']),
      ))
      .orderBy(asc(journalEvents.createdAt))
      .limit(maxEvents);

    type Session = {
      startedAt: Date;
      endedAt: Date | null;
      durationMs: number | null;
      startEventId: string;
      endEventId: string | null;
    };
    const sessions: Session[] = [];
    let pendingStart: (typeof journalEvents.$inferSelect) | null = null;
    for (const event of rawEvents) {
      if (event.type === 'instance.started') {
        pendingStart = event;
      } else if (event.type === 'instance.stopped' && pendingStart) {
        const startedAt = pendingStart.createdAt;
        const endedAt = event.createdAt;
        sessions.push({
          startedAt,
          endedAt,
          durationMs: endedAt.getTime() - startedAt.getTime(),
          startEventId: pendingStart.id,
          endEventId: event.id,
        });
        pendingStart = null;
      }
    }
    // Include the currently-running session (started but not yet stopped).
    if (pendingStart) {
      sessions.push({
        startedAt: pendingStart.createdAt,
        endedAt: null,
        durationMs: null,
        startEventId: pendingStart.id,
        endEventId: null,
      });
    }
    sessions.reverse(); // newest first
    const page = sessions.slice(offset, offset + limit);

    return { success: true, data: { ok: true, botId, sessions: page, limit, offset } };
  },
};

// --- get_owner_bot_journal_summary ---

const GetOwnerBotJournalSummaryParamsSchema = z.object({
  botId: z.string().min(1).describe('ID of the bot to query'),
});

const getOwnerBotJournalSummaryTool: AgentTool<TradingToolContext> = {
  name: 'get_owner_bot_journal_summary',
  description: 'Get aggregate trade stats for a specific bot: total trade count and fees grouped by currency. Only works for bots owned by this owner.',
  parametersSchema: GetOwnerBotJournalSummaryParamsSchema,
  parameters: convertZodToJsonSchema(GetOwnerBotJournalSummaryParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { botId } = params as z.infer<typeof GetOwnerBotJournalSummaryParamsSchema>;

    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available', fault: false };
    }
    if (!ctx.ownerId) {
      return { success: false, error: 'owner scope not available', fault: false };
    }
    if (!ctx.db) {
      return { success: false, error: 'direct db access not available', fault: false };
    }

    const bot = await ctx.botRepo.getBotByIdForOwner(botId, ctx.ownerId);
    if (!bot) {
      return { success: false, fault: false, errorCode: 'not_found.resource', error: `bot ${botId} not found or not owned by this owner` };
    }

    const db = ctx.db as Database;

    const [countResult] = await db
      .select({ tradeCount: sql<number>`count(*)::int` })
      .from(fills)
      .where(and(eq(fills.actorType, 'bot'), eq(fills.actorId, botId)));

    // Group by feeCurrency — consistent with /costs; avoids summing across heterogeneous assets.
    const feeRows = await db
      .select({ feeCurrency: fills.feeCurrency, total: sum(fills.fee) })
      .from(fills)
      .where(and(eq(fills.actorType, 'bot'), eq(fills.actorId, botId)))
      .groupBy(fills.feeCurrency);

    const feesByCurrency: Record<string, string> = {};
    for (const row of feeRows) {
      feesByCurrency[row.feeCurrency ?? 'unknown'] = row.total ?? '0';
    }

    return {
      success: true,
      data: {
        ok: true,
        botId,
        tradeCount: countResult?.tradeCount ?? 0,
        feesByCurrency,
      },
    };
  },
};

// --- get_owner_bot_journal ---
//
// Serves BOTH herobids reads: /bots/:id/events (call with just `limit`) and
// /bots/:id/journal (type + limit + offset). Thin pass-through over
// PgJournal(ctx.db).query — the same journal query the quarantined route ran.
// PgJournal is constructable from the raw Drizzle handle (ctx.db) — its
// constructor takes a Database (see @traderton/db journal-pg.ts), matching how
// the herobids route did `new PgJournal(db)`.

const GetOwnerBotJournalParamsSchema = z.object({
  botId: z.string().min(1).describe('ID of the bot to query'),
  type: z.string().min(1).optional().describe('Filter by journal event type'),
  // coerce: LLMs may send numbers as strings
  limit: z.coerce.number().int().positive().optional().describe('Max events to return'),
  offset: z.coerce.number().int().nonnegative().optional().describe('Number of events to skip'),
});

const getOwnerBotJournalTool: AgentTool<TradingToolContext> = {
  name: 'get_owner_bot_journal',
  description: 'Get journal events for a specific bot, optionally filtered by type and paginated. Only works for bots owned by this owner.',
  parametersSchema: GetOwnerBotJournalParamsSchema,
  parameters: convertZodToJsonSchema(GetOwnerBotJournalParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { botId, type, limit, offset } = params as z.infer<typeof GetOwnerBotJournalParamsSchema>;

    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available', fault: false };
    }
    if (!ctx.ownerId) {
      return { success: false, error: 'owner scope not available', fault: false };
    }
    if (!ctx.db) {
      return { success: false, error: 'direct db access not available', fault: false };
    }

    const bot = await ctx.botRepo.getBotByIdForOwner(botId, ctx.ownerId);
    if (!bot) {
      return { success: false, fault: false, errorCode: 'not_found.resource', error: `bot ${botId} not found or not owned by this owner` };
    }

    const journal = new PgJournal(ctx.db as Database);
    const events = await journal.query({ actorId: botId, type, limit, offset });

    return { success: true, data: { ok: true, events } };
  },
};

// --- stop_bot ---

const StopBotParamsSchema = z.object({
  botId: z.string().min(1).describe('ID of the bot to stop'),
});

const stopBotTool: AgentTool<TradingToolContext> = {
  name: 'stop_bot',
  description: 'Stop a running bot. The bot will cease trading and its positions will remain open unless manually closed. Only works for bots owned by this agent.',
  parametersSchema: StopBotParamsSchema,
  parameters: convertZodToJsonSchema(StopBotParamsSchema),
  category: 'write-database',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { botId } = params as z.infer<typeof StopBotParamsSchema>;

    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available', fault: false };
    }

    const stopTarget = await ctx.botRepo.getBotById(botId);
    if (!stopTarget || stopTarget.creatorType !== 'agent' || stopTarget.creatorId !== ctx.agentId) {
      return { success: false, error: `bot ${botId} not found or not owned by this agent`, fault: false };
    }

    const previousStatus = stopTarget.status;

    if (previousStatus !== 'running') {
      await ctx.botRepo.markBotStopped(botId);
      return { success: true, data: { ok: true, botId, previousStatus, note: 'bot was not running' } };
    }

    await ctx.botRepo.markBotStopped(botId);
    try {
      await ctx.redis.publish(`bot:stop:${botId}`, '1');
    } catch (err) {
      logger.error({ err, botId }, 'Failed to publish bot:stop signal — restoring previous runtime state');
      try {
        await ctx.botRepo.restoreBotRuntimeState({
          botId,
          status: stopTarget.status,
          startedAt: stopTarget.startedAt,
          stoppedAt: stopTarget.stoppedAt,
        });
      } catch (rollbackErr) {
        logger.error({ rollbackErr, botId }, 'CRITICAL: failed to restore bot state after stop signal failure');
      }
      return { success: false, data: { ok: false, botId, previousStatus, note: 'failed to signal bot stop' }, fault: false };
    }

    return { success: true, data: { ok: true, botId, previousStatus, note: 'bot stopped' } };
  },
};

// --- start_bot ---

const StartBotParamsSchema = z.object({
  botId: z.string().min(1).describe('ID of the bot to start'),
  rationale: z.string().max(500).optional().describe('Brief rationale for restarting this bot'),
});

const startBotTool: AgentTool<TradingToolContext> = {
  name: 'start_bot',
  description: 'Start a stopped bot. The bot will resume trading according to its configuration. Only works for bots owned by this agent.',
  parametersSchema: StartBotParamsSchema,
  parameters: convertZodToJsonSchema(StartBotParamsSchema),
  category: 'write-database',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { botId, rationale } = params as z.infer<typeof StartBotParamsSchema>;

    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available', fault: false };
    }

    const startTarget = await ctx.botRepo.getBotById(botId);
    if (!startTarget || startTarget.creatorType !== 'agent' || startTarget.creatorId !== ctx.agentId) {
      return { success: false, error: `bot ${botId} not found or not owned by this agent`, fault: false };
    }

    if (startTarget.status === 'running') {
      return { success: false, error: `bot ${botId} is already running`, fault: false };
    }

    // Do NOT mark the bot running here — the broker handles the status transition
    // atomically via tryMarkBotRunningWithLimit when it processes the start action.
    // Pre-marking bypasses the limit check (two concurrent starts could both pass).
    try {
      await ctx.publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, {
        action: 'start',
        botId,
        rationale,
      });
    } catch (err) {
      logger.error({ err, botId }, 'Failed to enqueue direct bot start');
      return { success: false, data: { ok: false, botId, note: 'failed to submit bot start' }, fault: false };
    }

    return { success: true, data: { ok: true, botId, note: 'bot start submitted' } };
  },
};

// --- adjust_bot_config ---

/**
 * Partial strategy input for adjust_config — allows partial updates without requiring
 * the full strategy object (type, decisionMode etc.). Full validation happens at merge time.
 */
const StrategyPartialInputSchema = z.object({
  type: z.enum(['momentum', 'range', 'contrarian', 'swing', 'scalper', 'dca']).optional(),
  decisionMode: z.enum(['mechanical', 'llm', 'hybrid']).optional(),
  params: z.record(z.unknown()).optional(),
});

const AdjustBotConfigParamsSchema = z.object({
  botId: z.string().min(1).describe('ID of the bot to reconfigure'),
  config: z.object({
    strategy: StrategyPartialInputSchema.optional().describe('Updated strategy fields (partial merge)'),
    execution: z.object({
      mode: z.enum(['paper', 'shadow', 'live']).optional(),
      // coerce: LLMs may send numbers as strings
      slippageBps: z.coerce.number().optional(),
    }).optional(),
    risk: z.record(z.unknown()).optional(),
    symbol: z.string().optional(),
  }).describe('Partial config object to merge with existing bot config'),
});

function deepMergeConfig(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMergeConfig(result[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

const adjustBotConfigTool: AgentTool<TradingToolContext> = {
  name: 'adjust_bot_config',
  description: 'Update configuration for a specific bot. Changes are merged with existing config and take effect on the next bot tick. Only works for bots owned by this agent.',
  parametersSchema: AdjustBotConfigParamsSchema,
  parameters: convertZodToJsonSchema(AdjustBotConfigParamsSchema),
  category: 'write-database',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { botId, config } = params as z.infer<typeof AdjustBotConfigParamsSchema>;

    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available', fault: false };
    }

    const configTarget = await ctx.botRepo.getBotById(botId);
    if (!configTarget || configTarget.creatorType !== 'agent' || configTarget.creatorId !== ctx.agentId) {
      return { success: false, error: `bot ${botId} not found or not owned by this agent`, fault: false };
    }

    // Enforce mode-rank: agent must not escalate a bot's execution mode beyond its own.
    const requestedMode = config.execution?.mode;
    if (requestedMode) {
      const check = checkModeEscalation(requestedMode, ctx.executionMode);
      if (!check.allowed) {
        return { success: false, error: check.error, fault: false };
      }
    }

    const merged = deepMergeConfig(configTarget.config, config);
    await ctx.botRepo.updateBotConfig(botId, merged);

    return { success: true, data: { ok: true, botId, note: 'config updated — takes effect on next bot tick' } };
  },
};

// --- delete_bot ---
//
// AUTHORED SEAM (Wave A1, 004 2026-09-12 S1/S2/S3) — the `delete_bot` boundary
// tool. The terminal-delete counterpart of the owner-scoped bot tools. It mirrors
// `deprovision_venue_account`'s shape (ownerScopedNoVenue + write-database, owner
// guards → fault:true, owner-scoped existence → not_found.resource, metadata-only
// success) and authors NO deletion policy: the hard row delete is the copied
// herobids DELETE-path semantics (a hard row delete; no archival concept), driven
// through the owner-scoped `deleteBotByIdForOwner` repo method.
//
// The one behavioural difference from deprovision (S3): the refuse guard is a
// STATUS guard on the bot's OWN status (`running` → refuse "stop it first"), NOT
// deprovision's any-referencing-bot guard. It carries a DEDICATED errorCode
// (`bot.running`) so the boundary consumer maps it to a 409 — the closed boundary
// failure union (005) cannot carry a dedicated code, so the code rides in the
// failure `details.errorCode` (fault:false), exactly as create_bot threads the
// paper+swap code. See docs/004 "Wave A1".

const DeleteBotParamsSchema = z.object({
  botId: z.string().min(1).describe('ID of the bot to delete'),
});

const deleteBotTool: AgentTool<TradingToolContext> = {
  name: 'delete_bot',
  // Owner-scoped write (keyed by botId); drives no executor. No venue resolution.
  ownerScopedNoVenue: true,
  description:
    'Permanently delete a bot owned by this owner. Refuses (bot.running) if the bot is still running — stop it first. Returns the deleted botId. Irreversible.',
  parametersSchema: DeleteBotParamsSchema,
  parameters: convertZodToJsonSchema(DeleteBotParamsSchema),
  category: 'write-database',
  promptGuidance:
    'Provide the botId to remove. Fails with bot.running if the bot is running — stop it first. The delete is a hard, irreversible row removal.',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { botId } = params as z.infer<typeof DeleteBotParamsSchema>;

    // (a) Context guards — owner/repo unavailable is an internal readiness fault
    //     (fault:true), mirroring provision's owner_unavailable/db_unavailable.
    if (!ctx.botRepo) {
      return {
        success: false,
        fault: true,
        error: 'Database access not available in this context',
        errorCode: 'bot.db_unavailable',
      };
    }
    if (!ctx.ownerId || !ctx.ownerId.trim()) {
      return {
        success: false,
        fault: true,
        error: 'Owner identity not available in this context',
        errorCode: 'bot.owner_unavailable',
      };
    }
    const ownerId = ctx.ownerId;

    // (b) Owner-scoped existence/ownership check — absent/unowned → not_found
    //     (fault:false), identical to get_owner_bot_status.
    const bot = await ctx.botRepo.getBotByIdForOwner(botId, ownerId);
    if (!bot) {
      return {
        success: false,
        fault: false,
        error: `bot ${botId} not found or not owned by this owner`,
        errorCode: 'not_found.resource',
      };
    }

    // (c) STATUS guard (S3) — refuse to delete a running bot (copied herobids 409
    //     "stop it first"). Dedicated errorCode so the boundary maps it to 409.
    if (bot.status === 'running') {
      return {
        success: false,
        fault: false,
        error: 'Cannot delete a running bot. Stop it first.',
        errorCode: 'bot.running',
      };
    }

    // Hard-delete the row, owner-scoped. No FK points to bots, so nothing is
    // orphaned (004 "Wave A1").
    await ctx.botRepo.deleteBotByIdForOwner(botId, ownerId);

    return { success: true, data: { ok: true, botId, deleted: true } };
  },
};

// --- Agent-scoped evidence read-wave (D1-c1 Sub-step 2) ────────────────────
//
// AUTHOR thin seams only. Unlike the get_owner_bot_* family (botId-scoped via
// getBotByIdForOwner), these are AGENT-scoped: they read ALL rows attributable
// to ctx.agentId (agent-native + agent-owned bots) — the same scope list_bots
// uses via getBotsByCreator('agent', ctx.agentId). No botId param; agent-owned
// bot resolution is folded into the copied loaders (Sub-step 1).
//
// The query bodies are the Sub-step 1 loaders (FillRepository.loadAgentFills /
// PositionRepository.loadAgentPositions / PgJournal.loadAgentJournalEvents),
// copied verbatim from herobids agent-evidence-loaders.ts. These tools author
// nothing but guards + ISO→Date param parse + delegation. category
// read-database → the boundary resolver short-circuits venue resolution.
//
// Guards mirror get_owner_bot_costs (fault:false): ctx.db absent →
// 'direct db access not available'; ctx.agentId absent → 'agent scope not
// available'. No ownerId guard — the scope is the agent, not the tenant.

// --- get_agent_fills ---

const GetAgentFillsParamsSchema = z.object({
  from: z.string().optional().describe('ISO date — only include fills at or after this time'),
  to: z.string().optional().describe('ISO date — only include fills at or before this time'),
});

const getAgentFillsTool: AgentTool<TradingToolContext> = {
  name: 'get_agent_fills',
  description: 'Get all fills attributable to this agent (agent-native + agent-owned bots), optionally time-filtered. Only returns this agent\'s own data.',
  parametersSchema: GetAgentFillsParamsSchema,
  parameters: convertZodToJsonSchema(GetAgentFillsParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { from, to } = params as z.infer<typeof GetAgentFillsParamsSchema>;

    if (!ctx.db) {
      return { success: false, error: 'direct db access not available', fault: false };
    }
    if (!ctx.agentId) {
      return { success: false, error: 'agent scope not available', fault: false };
    }

    const db = ctx.db as Database;
    // Scope invariant: NEVER pass `botIds` — the agent-owned bot resolution MUST
    // stay context-derived (loadAgentBotIds(ctx.agentId)) so a caller cannot widen
    // scope to another agent's rows. Only time filters cross from params.
    const fillRows = await new FillRepository(db).loadAgentFills(ctx.agentId, {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });

    return { success: true, data: { ok: true, fills: fillRows } };
  },
};

// --- get_agent_journal_events ---

const GetAgentJournalEventsParamsSchema = z.object({
  from: z.string().optional().describe('ISO date — only include events at or after this time'),
  to: z.string().optional().describe('ISO date — only include events at or before this time'),
});

const getAgentJournalEventsTool: AgentTool<TradingToolContext> = {
  name: 'get_agent_journal_events',
  description: 'Get all journal events attributable to this agent (agent-native + agent-owned bots), optionally time-filtered. Only returns this agent\'s own data.',
  parametersSchema: GetAgentJournalEventsParamsSchema,
  parameters: convertZodToJsonSchema(GetAgentJournalEventsParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { from, to } = params as z.infer<typeof GetAgentJournalEventsParamsSchema>;

    if (!ctx.db) {
      return { success: false, error: 'direct db access not available', fault: false };
    }
    if (!ctx.agentId) {
      return { success: false, error: 'agent scope not available', fault: false };
    }

    const db = ctx.db as Database;
    // Scope invariant: NEVER pass `botIds` — agent-owned bot resolution stays
    // context-derived so a caller cannot widen scope. Only time filters cross.
    const events = await new PgJournal(db).loadAgentJournalEvents(ctx.agentId, {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });

    return { success: true, data: { ok: true, events } };
  },
};

// --- get_agent_positions ---

const GetAgentPositionsParamsSchema = z.object({
  from: z.string().optional().describe('ISO date — only include positions at or after this time'),
  to: z.string().optional().describe('ISO date — only include positions at or before this time'),
  at: z.string().optional().describe('ISO date — snapshot: only positions open at this instant (openedAt <= at AND (closedAt is null OR closedAt > at))'),
});

const getAgentPositionsTool: AgentTool<TradingToolContext> = {
  name: 'get_agent_positions',
  description: 'Get all positions attributable to this agent (agent-native + agent-owned bots), optionally time-filtered or snapshotted at a point in time. Only returns this agent\'s own data.',
  parametersSchema: GetAgentPositionsParamsSchema,
  parameters: convertZodToJsonSchema(GetAgentPositionsParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { from, to, at } = params as z.infer<typeof GetAgentPositionsParamsSchema>;

    if (!ctx.db) {
      return { success: false, error: 'direct db access not available', fault: false };
    }
    if (!ctx.agentId) {
      return { success: false, error: 'agent scope not available', fault: false };
    }

    const db = ctx.db as Database;
    // Scope invariant: NEVER pass `botIds` — agent-owned bot resolution stays
    // context-derived so a caller cannot widen scope. Only time filters cross.
    const positionRows = await new PositionRepository(db).loadAgentPositions(ctx.agentId, {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      at: at ? new Date(at) : undefined,
    });

    return { success: true, data: { ok: true, positions: positionRows } };
  },
};

// --- get_agent_venue_binding ---
//
// Agent-scoped boundary READ of the agent's venue binding (D1-c2). Replaces the
// bot-path of herobids' assessment-identity-resolver `resolveAgentBinding`: it
// resolves the agent's first agent-owned bot → its venue account server-side and
// returns DERIVED binding metadata only ({ venueFamily, venueType }) — never raw
// rows, never secrets. Mirrors the herobids bot-path null semantics EXACTLY:
// binding is null when there is no agent-owned bot, the bot has no venueAccountId,
// or the venue account has no venueProfile. venueType comes from the jsonb
// venueProfile.venueType (VenueProfile). The `agents.unifiedConfig` fallback +
// styleTier read STAY herobids-local (platform tables). Inline 2-step lookup —
// matches the get_owner_bot_* inline query style. Guards mirror get_agent_fills
// (fault:false): ctx.db absent → 'direct db access not available'; ctx.agentId
// absent → 'agent scope not available'. category read-database → the boundary
// resolver short-circuits venue resolution.

const GetAgentVenueBindingParamsSchema = z.object({});

const getAgentVenueBindingTool: AgentTool<TradingToolContext> = {
  name: 'get_agent_venue_binding',
  description: "Get this agent's venue binding, derived server-side from the agent's first bot and its venue account. Returns { venueFamily, venueType } or null when the agent has no resolvable binding. Only returns this agent's own binding metadata (no raw rows, no secrets).",
  parametersSchema: GetAgentVenueBindingParamsSchema,
  parameters: convertZodToJsonSchema(GetAgentVenueBindingParamsSchema),
  category: 'read-database',
  async execute(_params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    if (!ctx.db) {
      return { success: false, error: 'direct db access not available', fault: false };
    }
    if (!ctx.agentId) {
      return { success: false, error: 'agent scope not available', fault: false };
    }

    const db = ctx.db as Database;

    // Resolve the agent's first agent-owned bot (creatorType='agent' AND
    // creatorId=ctx.agentId). No caller-supplied id — scope stays context-derived.
    const [bot] = await db
      .select({ venueAccountId: bots.venueAccountId })
      .from(bots)
      .where(and(eq(bots.creatorType, 'agent'), eq(bots.creatorId, ctx.agentId)))
      .limit(1);

    // null when: no agent-owned bot, or the bot has no venueAccountId, or the
    // venue account has no venueProfile — matching herobids' bot-path exactly.
    if (bot?.venueAccountId) {
      const [va] = await db
        .select({ venueFamily: venueAccounts.venue, venueProfile: venueAccounts.venueProfile })
        .from(venueAccounts)
        .where(eq(venueAccounts.id, bot.venueAccountId))
        .limit(1);

      if (va?.venueProfile) {
        return {
          success: true,
          data: {
            ok: true,
            binding: {
              venueFamily: va.venueFamily,
              venueType: va.venueProfile.venueType ?? null,
            },
          },
        };
      }
    }

    return { success: true, data: { ok: true, binding: null } };
  },
};

// --- Owner-scoped export read-wave (c4.2-tools) ────────────────────────────
//
// Boundary READ tools the herobids export/views seam consumes to read trading
// state over the boundary instead of local tables. Each returns RAW rows the
// seam maps with toFillRow / toPositionRow / toJournalRow.
//
// The query bodies are COPIED from the herobids export routes
// (apps/api/src/routes/exports.ts): the single-bot tools reproduce
// /bots/:id/export/trades and /export/report; the owner-wide tools reproduce
// /export/trades and /export/bundle. The ONLY adaptation is re-keying the
// ownership check from herobids' local `bots where(id, userId)` /
// `bots where(userId)` lookups to the owner-scoped repo methods
// getBotByIdForOwner(botId, ctx.ownerId) and getBotsByOwner(ctx.ownerId) — the
// same methods list_owner_bots and get_owner_bot_status use — so no divergent
// query is authored. Aggregation stays copy-faithful; these tools author only
// the thin wrapper + guards + ISO→Date param parse.
//
// Guards mirror get_owner_bot_costs (fault:false): botRepo absent →
// 'direct db access not available'; ownerId absent → 'owner scope not
// available'; db absent → 'direct db access not available'. Single-bot tools
// resolve+authorize via getBotByIdForOwner → absent → not_found.resource
// (fault:false), identical to the get_owner_bot_* family. category
// read-database → the boundary resolver short-circuits venue resolution.

// --- get_owner_bot_fills ---
//
// Reproduces herobids /bots/:id/export/trades (exports.ts): fills where
// actorType='bot' AND actorId=id, with optional filledAt >= from / <= to.

const GetOwnerBotFillsParamsSchema = z.object({
  botId: z.string().min(1).describe('ID of the bot to query'),
  from: z.string().optional().describe('ISO date — only include fills at or after this time'),
  to: z.string().optional().describe('ISO date — only include fills at or before this time'),
});

const getOwnerBotFillsTool: AgentTool<TradingToolContext> = {
  name: 'get_owner_bot_fills',
  description: 'Get all fills for a specific bot, optionally time-filtered. Only works for bots owned by this owner.',
  parametersSchema: GetOwnerBotFillsParamsSchema,
  parameters: convertZodToJsonSchema(GetOwnerBotFillsParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { botId, from, to } = params as z.infer<typeof GetOwnerBotFillsParamsSchema>;

    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available', fault: false };
    }
    if (!ctx.ownerId) {
      return { success: false, error: 'owner scope not available', fault: false };
    }
    if (!ctx.db) {
      return { success: false, error: 'direct db access not available', fault: false };
    }

    const bot = await ctx.botRepo.getBotByIdForOwner(botId, ctx.ownerId);
    if (!bot) {
      return { success: false, fault: false, errorCode: 'not_found.resource', error: `bot ${botId} not found or not owned by this owner` };
    }

    const db = ctx.db as Database;

    // Copied from herobids /bots/:id/export/trades: actorType='bot' actorId=id,
    // optional filledAt ± bounds.
    const conditions = [eq(fills.actorType, 'bot'), eq(fills.actorId, botId)];
    if (from) conditions.push(gte(fills.filledAt, new Date(from)));
    if (to) conditions.push(lte(fills.filledAt, new Date(to)));

    const fillRows = await db.select().from(fills).where(and(...conditions));

    return { success: true, data: { ok: true, botId, fills: fillRows } };
  },
};

// --- get_owner_bot_positions ---
//
// Reproduces herobids /bots/:id/export/report positions read (exports.ts):
// positions where actorType='bot' AND actorId=id — ALL positions (open +
// closed), no closedAt filter.

const GetOwnerBotPositionsParamsSchema = z.object({
  botId: z.string().min(1).describe('ID of the bot to query'),
});

const getOwnerBotPositionsTool: AgentTool<TradingToolContext> = {
  name: 'get_owner_bot_positions',
  description: 'Get all positions (open and closed) for a specific bot. Only works for bots owned by this owner.',
  parametersSchema: GetOwnerBotPositionsParamsSchema,
  parameters: convertZodToJsonSchema(GetOwnerBotPositionsParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { botId } = params as z.infer<typeof GetOwnerBotPositionsParamsSchema>;

    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available', fault: false };
    }
    if (!ctx.ownerId) {
      return { success: false, error: 'owner scope not available', fault: false };
    }
    if (!ctx.db) {
      return { success: false, error: 'direct db access not available', fault: false };
    }

    const bot = await ctx.botRepo.getBotByIdForOwner(botId, ctx.ownerId);
    if (!bot) {
      return { success: false, fault: false, errorCode: 'not_found.resource', error: `bot ${botId} not found or not owned by this owner` };
    }

    const db = ctx.db as Database;

    // Copied from herobids /bots/:id/export/report: actorType='bot' actorId=id,
    // ALL positions (no closedAt filter). Ordered `desc(updatedAt)` to reproduce
    // the herobids `PositionRepository.getAllByActor` ordering that the
    // /bots/:botId/positions view relies on (the report/open consumers are
    // order-independent).
    const positionRows = await db
      .select()
      .from(positions)
      .where(and(eq(positions.actorType, 'bot'), eq(positions.actorId, botId)))
      .orderBy(desc(positions.updatedAt));

    return { success: true, data: { ok: true, botId, positions: positionRows } };
  },
};

// --- get_owner_bot_reconciliation_events ---
//
// Reproduces herobids /bots/:id/reconciliation-events (reconciliation.ts):
// resolves the OWNED bot → its venueAccountId server-side, then reads
// `reconciliation_events` by venue account (reconciliation is venue-account-
// scoped, not actor-scoped). `reconciliation_events` is a Traderton trading
// table — this makes the herobids-local read boundary-owned. Query body copied
// from herobids `ReconciliationEventRepository.getByVenueAccount` (same
// signature/ordering as the Traderton repo). Guards + not_found.resource mirror
// the get_owner_bot_* family.

const GetOwnerBotReconciliationEventsParamsSchema = z.object({
  botId: z.string().min(1).describe('ID of the bot to query'),
  // coerce: LLMs may send numbers as strings
  limit: z.coerce.number().int().positive().optional().describe('Max events to return (default 100)'),
  offset: z.coerce.number().int().nonnegative().optional().describe('Number of events to skip (default 0)'),
  since: z.string().optional().describe('ISO date — only include events at or after this time'),
});

const getOwnerBotReconciliationEventsTool: AgentTool<TradingToolContext> = {
  name: 'get_owner_bot_reconciliation_events',
  description: 'Get reconciliation events for a specific bot (via its venue account). Only works for bots owned by this owner.',
  parametersSchema: GetOwnerBotReconciliationEventsParamsSchema,
  parameters: convertZodToJsonSchema(GetOwnerBotReconciliationEventsParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { botId, limit, offset, since } = params as z.infer<typeof GetOwnerBotReconciliationEventsParamsSchema>;

    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available', fault: false };
    }
    if (!ctx.ownerId) {
      return { success: false, error: 'owner scope not available', fault: false };
    }
    if (!ctx.db) {
      return { success: false, error: 'direct db access not available', fault: false };
    }

    const bot = await ctx.botRepo.getBotByIdForOwner(botId, ctx.ownerId);
    if (!bot) {
      return { success: false, fault: false, errorCode: 'not_found.resource', error: `bot ${botId} not found or not owned by this owner` };
    }

    const db = ctx.db as Database;

    // The tool-context botRepo port (ToolBotRecord) doesn't expose venueAccountId;
    // resolve it via a direct db read on the OWNER-VERIFIED bot (ownership already
    // checked above). Same inline-query style get_agent_venue_binding uses.
    const [venueRow] = await db
      .select({ venueAccountId: bots.venueAccountId })
      .from(bots)
      .where(eq(bots.id, botId))
      .limit(1);
    const venueAccountId = venueRow?.venueAccountId ?? null;
    if (!venueAccountId) {
      // Owner-verified bot with no venue account → no reconciliation events.
      return { success: true, data: { ok: true, botId, venueAccountId: null, events: [] } };
    }

    const reconRepo = new ReconciliationEventRepository(db);
    const events = await reconRepo.getByVenueAccount(venueAccountId, {
      limit,
      offset,
      since: since ? new Date(since) : undefined,
    });

    return { success: true, data: { ok: true, botId, venueAccountId, events } };
  },
};

// --- get_owner_fills ---
//
// Reproduces herobids /export/trades (exports.ts): resolve ALL bots owned by the
// user, then fills where actorType='bot' AND actorId IN ownerBotIds, optional
// filledAt ± bounds. Empty ownerBotIds short-circuits to []. Owner-bots
// resolution reuses getBotsByOwner (the same method list_owner_bots uses).

const GetOwnerFillsParamsSchema = z.object({
  from: z.string().optional().describe('ISO date — only include fills at or after this time'),
  to: z.string().optional().describe('ISO date — only include fills at or before this time'),
});

const getOwnerFillsTool: AgentTool<TradingToolContext> = {
  name: 'get_owner_fills',
  description: 'Get all fills across every bot owned by this owner, optionally time-filtered. Only returns this owner\'s own data.',
  parametersSchema: GetOwnerFillsParamsSchema,
  parameters: convertZodToJsonSchema(GetOwnerFillsParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { from, to } = params as z.infer<typeof GetOwnerFillsParamsSchema>;

    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available', fault: false };
    }
    if (!ctx.ownerId) {
      return { success: false, error: 'owner scope not available', fault: false };
    }
    if (!ctx.db) {
      return { success: false, error: 'direct db access not available', fault: false };
    }

    const ownerBots = await ctx.botRepo.getBotsByOwner(ctx.ownerId);
    const ownerBotIds = ownerBots.map((b) => b.id);

    // Copied from herobids /export/trades: no owned bots → empty result.
    if (ownerBotIds.length === 0) {
      return { success: true, data: { ok: true, fills: [] } };
    }

    const db = ctx.db as Database;

    const conditions = [eq(fills.actorType, 'bot'), inArray(fills.actorId, ownerBotIds)];
    if (from) conditions.push(gte(fills.filledAt, new Date(from)));
    if (to) conditions.push(lte(fills.filledAt, new Date(to)));

    const fillRows = await db.select().from(fills).where(and(...conditions));

    return { success: true, data: { ok: true, fills: fillRows } };
  },
};

// --- get_owner_positions ---
//
// Reproduces herobids /export/bundle positions read (exports.ts): resolve ALL
// bots owned by the user, then positions where actorType='bot' AND actorId IN
// ownerBotIds. Empty ownerBotIds short-circuits to [].
//
// ADDITIVE optional params (c4.2-analytics): `botIds` subsets the owner-bot set
// (INTERSECTION with ownerBotIds — a caller can never widen beyond owner scope),
// `from`/`to` window on `closedAt` (matching herobids' analytics positions query,
// which time-filters on closedAt — NOT createdAt), and `limit` caps the result.
// Each filter/cap is applied ONLY when its param is present, so the existing
// no-arg /export/bundle caller behaves EXACTLY as before (all owner-bot rows,
// actorType='bot', no time filter, no limit, no orderBy).

const GetOwnerPositionsParamsSchema = z.object({
  botIds: z.array(z.string()).optional().describe('Restrict to these bot ids (intersected with the owner\'s bots — cannot widen beyond owner scope)'),
  from: z.string().optional().describe('Only positions closed at or after this ISO timestamp (filters closedAt)'),
  to: z.string().optional().describe('Only positions closed at or before this ISO timestamp (filters closedAt)'),
  // coerce: callers may send numbers as strings
  limit: z.coerce.number().int().positive().optional().describe('Max positions to return'),
});

const getOwnerPositionsTool: AgentTool<TradingToolContext> = {
  name: 'get_owner_positions',
  description: 'Get positions across bots owned by this owner. Optionally restrict to a subset of bot ids, a closedAt time window, and a row limit. Only returns this owner\'s own data.',
  parametersSchema: GetOwnerPositionsParamsSchema,
  parameters: convertZodToJsonSchema(GetOwnerPositionsParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { botIds, from, to, limit } = params as z.infer<typeof GetOwnerPositionsParamsSchema>;

    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available', fault: false };
    }
    if (!ctx.ownerId) {
      return { success: false, error: 'owner scope not available', fault: false };
    }
    if (!ctx.db) {
      return { success: false, error: 'direct db access not available', fault: false };
    }

    const ownerBots = await ctx.botRepo.getBotsByOwner(ctx.ownerId);
    let ownerBotIds = ownerBots.map((b) => b.id);

    // INTERSECT with the requested subset when provided — never widen beyond the
    // owner's bots, so a caller cannot read another owner's rows via botIds.
    if (botIds) {
      const requested = new Set(botIds);
      ownerBotIds = ownerBotIds.filter((id) => requested.has(id));
    }

    // Copied from herobids /export/bundle: no owned (in-scope) bots → empty result.
    if (ownerBotIds.length === 0) {
      return { success: true, data: { ok: true, positions: [] } };
    }

    const db = ctx.db as Database;

    const conditions = [eq(positions.actorType, 'bot'), inArray(positions.actorId, ownerBotIds)];
    // Positions time-filter is on closedAt (matches the herobids analytics query).
    if (from) conditions.push(gte(positions.closedAt, new Date(from)));
    if (to) conditions.push(lte(positions.closedAt, new Date(to)));

    // Apply the limit only when present; the no-arg caller stays unlimited.
    const positionRows = limit !== undefined
      ? await db.select().from(positions).where(and(...conditions)).limit(limit)
      : await db.select().from(positions).where(and(...conditions));

    return { success: true, data: { ok: true, positions: positionRows } };
  },
};

// --- get_owner_journal ---
//
// Reproduces herobids /export/bundle journal read (exports.ts): resolve ALL bots
// owned by the user, then journalEvents where actorId IN ownerBotIds. Empty
// ownerBotIds short-circuits to []. The account bundle needs this owner-wide
// journal read alongside get_owner_fills / get_owner_positions.
//
// ADDITIVE optional params (c4.2-analytics): `botIds` subsets the owner-bot set
// (INTERSECTION with ownerBotIds — never widens beyond owner scope), `from`/`to`
// window on `createdAt`, and `limit` caps the result. When `limit` is present
// the query also applies `.orderBy(desc(createdAt))` — MATCHING the herobids
// analytics journal query (`.orderBy(desc(createdAt)).limit(10_000)`). orderBy is
// tied to limit so the no-arg /export/bundle caller (which passes none of these)
// keeps its existing unordered/unlimited behaviour EXACTLY.

const GetOwnerJournalParamsSchema = z.object({
  botIds: z.array(z.string()).optional().describe('Restrict to these bot ids (intersected with the owner\'s bots — cannot widen beyond owner scope)'),
  from: z.string().optional().describe('Only events created at or after this ISO timestamp'),
  to: z.string().optional().describe('Only events created at or before this ISO timestamp'),
  // coerce: callers may send numbers as strings
  limit: z.coerce.number().int().positive().optional().describe('Max events to return (newest first when set)'),
});

const getOwnerJournalTool: AgentTool<TradingToolContext> = {
  name: 'get_owner_journal',
  description: 'Get journal events across bots owned by this owner. Optionally restrict to a subset of bot ids, a createdAt time window, and a row limit (newest first when limited). Only returns this owner\'s own data.',
  parametersSchema: GetOwnerJournalParamsSchema,
  parameters: convertZodToJsonSchema(GetOwnerJournalParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { botIds, from, to, limit } = params as z.infer<typeof GetOwnerJournalParamsSchema>;

    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available', fault: false };
    }
    if (!ctx.ownerId) {
      return { success: false, error: 'owner scope not available', fault: false };
    }
    if (!ctx.db) {
      return { success: false, error: 'direct db access not available', fault: false };
    }

    const ownerBots = await ctx.botRepo.getBotsByOwner(ctx.ownerId);
    let ownerBotIds = ownerBots.map((b) => b.id);

    // INTERSECT with the requested subset when provided — never widen beyond the
    // owner's bots, so a caller cannot read another owner's rows via botIds.
    if (botIds) {
      const requested = new Set(botIds);
      ownerBotIds = ownerBotIds.filter((id) => requested.has(id));
    }

    // Copied from herobids /export/bundle: no owned (in-scope) bots → empty result.
    if (ownerBotIds.length === 0) {
      return { success: true, data: { ok: true, events: [] } };
    }

    const db = ctx.db as Database;

    const conditions = [inArray(journalEvents.actorId, ownerBotIds)];
    if (from) conditions.push(gte(journalEvents.createdAt, new Date(from)));
    if (to) conditions.push(lte(journalEvents.createdAt, new Date(to)));

    // orderBy is tied to limit: only the limited path orders (newest first), so
    // the no-arg /export/bundle caller keeps its unordered/unlimited behaviour.
    const eventRows = limit !== undefined
      ? await db.select().from(journalEvents).where(and(...conditions))
          .orderBy(desc(journalEvents.createdAt)).limit(limit)
      : await db.select().from(journalEvents).where(and(...conditions));

    return { success: true, data: { ok: true, events: eventRows } };
  },
};

export const botManagementTools: AgentTool[] = [
  createBotTool,
  listBotsTool,
  getBotStatusTool,
  listOwnerBotsTool,
  getOwnerBotStatusTool,
  getOwnerBotCostsTool,
  getOwnerBotSessionsTool,
  getOwnerBotJournalSummaryTool,
  getOwnerBotJournalTool,
  stopBotTool,
  startBotTool,
  adjustBotConfigTool,
  deleteBotTool,
  getAgentFillsTool,
  getAgentJournalEventsTool,
  getAgentPositionsTool,
  getAgentVenueBindingTool,
  getOwnerBotFillsTool,
  getOwnerBotPositionsTool,
  getOwnerFillsTool,
  getOwnerPositionsTool,
  getOwnerJournalTool,
  getOwnerBotReconciliationEventsTool,
];
