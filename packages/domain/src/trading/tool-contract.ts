// Trading-owned tool contract relocated from ../tools.ts for trading-layer
// independence (behaviour-preserving; source-fix request
// docs/features/2026/09/07/002-split-trading-tool-contract-out-of-tools-ts.md).
//
// This module holds the trading-clean tool contract: the trading ToolContext
// (`TradingToolContext`, trading fields only), the record/result types, the
// category taxonomy + helpers, and a generic `AgentTool` whose execute context
// defaults to the trading-clean `TradingToolContext`. Its type closure pulls NO
// platform type (`PermissionLevel`, `UnifiedAgentConfig`, `ExternalSkillProvider`,
// skills/browser/capability/usage-billing). Platform tools opt into the full
// platform `ToolContext` via the platform `AgentTool` alias in ../tools.ts.

import type { z } from 'zod';
import type { EconomicCalendarProvider } from '../ports/economic-calendar.js';

/**
 * Tool category system — uses composite categories for fine-grained capability control.
 *
 * Tool names use lower snake case.
 * Prefer action-first names.
 * Prefer `verb_noun` or `verb_noun_qualifier` when possible.
 * Avoid noun-first and hyphenated names.
 * Bad: `code_execute`, `get-overview-from-market`
 * Good: `execute_code`, `get_market_overview`
 *
 * Format: `<operation>-<target>`
 * - Operation: read | write | execute
 * - Target: filesystem | database | trade | messaging | memory | market-data | config
 *
 * Categories double as capability-based security controls (rwx model).
 * A tool's category determines which capability grant an agent needs to invoke it.
 * Choose the target that matches the tool's primary domain, not its storage mechanism.
 *
 * Examples:
 * - "read-database" — list_positions, get_bot_status
 * - "write-messaging" — send_message
 * - "execute-trade" — submit_decision, create_bot
 * - "read-market-data" — search_tokens, check_regime
 * - "read-filesystem" — read_file, list_files
 * - "write-filesystem" — write_file, delete_file
 * - "execute-filesystem" — execute_code (writes then executes)
 * - "read-config" — get_schema (pure config introspection, no DB access)
 */
export type ToolCategory =
  | 'read-database'
  | 'read-memory'
  | 'read-market-data'
  | 'read-trade'
  | 'read-web'
  | 'read-config'
  | 'read-filesystem'
  | 'write-database'
  | 'write-memory'
  | 'write-messaging'
  | 'write-filesystem'
  | 'execute-trade'
  | 'execute-filesystem';

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  /** Machine-readable error code for non-success results. */
  errorCode?: string;
  /** When true, the failure is transient (rate limit, timeout) and retrying may succeed. */
  retryable?: boolean;
  /**
   * When explicitly false, the failure is a content-level outcome (e.g. HTTP 4xx, redirect
   * blocked by policy) rather than an infrastructure fault. The circuit breaker should not
   * count these against the tool. Defaults to true (i.e. assume fault unless told otherwise).
   */
  fault?: boolean;
}

/**
 * The synchronously-available result of a `MANAGE_BOT` create_and_start dispatch.
 * The bot ROW + its id are persisted synchronously by the drive path (the
 * item-E atomic create seam); only the actor START is deferred to the lifecycle
 * queue. `publishToInbound` surfaces this so `create_bot` can return the id in
 * its `ToolResult.data` rather than a hardcoded "next tick" note. Other message
 * types (DECISION_SUBMIT, non-create MANAGE_BOT actions) resolve `void`.
 */
export interface ManageBotResult {
  botId: string;
  // Present on the create-only path (`action:'create'`, autostart=false) so the
  // caller can see the bot was persisted STOPPED (not create_and_start's running
  // slot). Absent/omitted for create_and_start (which enqueues a start).
  status?: string;
}

/** Bot row shape returned by bot repository queries. */
export interface ToolBotRecord {
  id: string;
  status: string;
  config: Record<string, unknown>;
  venueAccountId: string;
  creatorType: string;
  creatorId: string | null;
  startedAt: Date | null;
  stoppedAt: Date | null;
  createdAt: Date;
}

/** Position row shape returned by repository queries. */
export interface ToolPositionRecord {
  actorType: string;
  actorId: string | null;
  venue: string;
  /** Canonical instrument ID from the venue's instrument repository. Nullable for legacy positions. */
  instrumentId?: string | null;
  symbol: string;
  side: string;
  size: string;
  entryPrice: string;
  /** Per-trade stop-loss price level set at entry. Nullable — not all trades carry levels. */
  stopLoss?: string | null;
  /** Per-trade take-profit price level set at entry. Nullable — not all trades carry levels. */
  takeProfit?: string | null;
  openedAt: Date;
}

/** Analytics result returned by getAnalyticsByCreator. */
export interface ToolAnalyticsResult {
  botCount: number;
  openPositions: number;
  closedPositions: number;
  winningPositions: number;
  realizedPnlUsd: string;
  totalFeesUsd: string;
  recentFills: number;
  avgHoldTimeHours: number | null;
  byBot: Array<{ botId: string; status: string; recentFills: number; realizedPnlUsd: string }>;
  agentDirect: { recentFills: number; realizedPnlUsd: string } | null;
}

/**
 * Trading tool execution context — the trading-clean subset of the platform
 * `ToolContext`. Contains only the fields the trading tools use. The full
 * platform `ToolContext` (in ../tools.ts) extends this with agent/platform
 * fields.
 */
export interface TradingToolContext {
  agentId: string;
  sessionId: string;
  /**
   * The signed owner id the boundary resolved from the request subject
   * (`subject.ownerId`). Trading tools that persist owner-scoped rows
   * (provisioning) write this to the soft `ownerId` columns. Optional because
   * most tools operate on already-owner-scoped repos and never need it.
   */
  ownerId?: string;
  /** The agent's own execution mode. Used by tools that enforce mode-rank constraints. */
  executionMode: 'paper' | 'shadow' | 'live';
  /** Authorization mode for agent-direct trade decisions: 'direct' (execute immediately) or 'approval_required' (require user approval). */
  authorizationMode: 'direct' | 'approval_required';
  /** Redis client for agent memory, watches, and pub/sub */
  redis: {
    hset: (key: string, field: string, value: string) => Promise<number>;
    hget: (key: string, field: string) => Promise<string | null>;
    hgetall: (key: string) => Promise<Record<string, string> | null>;
    hdel: (key: string, ...fields: string[]) => Promise<number>;
    publish: (channel: string, message: string) => Promise<number>;
    /** Blocking list pop — used to await async decision replies. Returns [key, value] or null on timeout. */
    blpop: (key: string, timeoutSeconds: number) => Promise<[string, string] | null>;
    /** Redis SET operations — used by watch tools for notified-watch dedup. */
    smembers: (key: string) => Promise<string[]>;
    sadd: (key: string, ...members: string[]) => Promise<number>;
    srem: (key: string, ...members: string[]) => Promise<number>;
    expire: (key: string, seconds: number) => Promise<number>;
  };
  /**
   * Publish agent protocol message to inbound stream. Resolves `void` for most
   * message types; a `MANAGE_BOT` create_and_start resolves a `ManageBotResult`
   * carrying the synchronously-persisted `botId` (see `ManageBotResult`).
   */
  publishToInbound: (type: string, payload: Record<string, unknown>) => Promise<void | ManageBotResult>;
  /** Optional database repository for direct bot queries */
  botRepo?: {
    getBotsByCreator: (creatorType: string, creatorId: string, since?: Date) => Promise<ToolBotRecord[]>;
    getBotById: (botId: string) => Promise<ToolBotRecord | null>;
    /** Owner-scoped list — all bots for an owner regardless of creatorType. */
    getBotsByOwner: (ownerId: string, since?: Date) => Promise<ToolBotRecord[]>;
    /** Owner-scoped existence/ownership check — null when not owned by ownerId. */
    getBotByIdForOwner: (botId: string, ownerId: string) => Promise<ToolBotRecord | null>;
    /** Owner-scoped hard delete — returns whether a row was deleted (false when absent/unowned). */
    deleteBotByIdForOwner: (botId: string, ownerId: string) => Promise<boolean>;
    /**
     * Insert a STOPPED bot with a caller-supplied id + blueprint lineage. Drives
     * the `instantiate_bot` boundary tool (the copy-faithful blueprint-instantiate
     * write). Does NOT enforce the running-bot limit (instantiation creates a
     * stopped bot). See docs/003 (instantiate atomicity-split).
     */
    insertStoppedBot: (params: {
      id: string;
      ownerId: string;
      venueAccountId: string;
      config: Record<string, unknown>;
      creatorType: string;
      creatorId: string;
      blueprintId: string;
      blueprintRevisionId: string;
      configSnapshot: Record<string, unknown>;
    }) => Promise<{ botId: string }>;
    markBotStopped: (botId: string) => Promise<void>;
    markBotRunning: (botId: string) => Promise<void>;
    restoreBotRuntimeState: (state: { botId: string; status: string; startedAt: Date | null; stoppedAt: Date | null }) => Promise<void>;
    updateBotConfig: (botId: string, config: Record<string, unknown>) => Promise<void>;
    getAnalyticsByCreator: (creatorType: string, creatorId: string, since: Date, botId?: string) => Promise<ToolAnalyticsResult>;
    getOpenPositionsByCreator: (creatorType: string, creatorId: string, botId?: string) => Promise<ToolPositionRecord[]>;
  };
  /** Optional market data registry */
  marketDataRegistry?: {
    dexscreener: {
      search: (query: string) => Promise<{
        data: unknown[];
        meta: {
          freshness: {
            source: string;
            fetchedAt: string;
            ageMs: number;
            ttlMs: number;
            isStale: boolean;
            expiresAt: string;
          };
        };
      }>;
      searchConfig: unknown;
    };
    binance: { candles: (symbol: string, opts?: { interval?: string; limit?: number }) => Promise<{ data: unknown[] }> };
  };
  /** Market data telemetry hooks */
  recordMarketDataAttempt?: (provider: string) => void;
  recordMarketDataRejection?: (provider: string, opts?: { priority?: 'execution' | 'discovery' }) => void;
  /** Resolved market data config — enables shared token safety policy in search tools */
  marketDataConfig?: Record<string, unknown>;
  /** Session metrics for tool execution */
  sessionMetrics?: {
    decisionsSubmitted: number;
  };
  /**
   * Price service for non-execution price lookups: valuation, watch thresholds,
   * and discovery enrichment. NOT used for live trade sizing or swap execution.
   */
  priceService?: {
    getPrice(symbol: string, chain: string, address?: string): Promise<{
      ok: boolean;
      data?: { priceUsd: number; source: 'execution' | 'oracle' | 'cached'; fetchedAt: string; stale: boolean };
      error?: { code: string; message: string };
    }>;
    resolvePriceTarget(symbol: string, chain: string, address?: string): Promise<{
      ok: boolean;
      data?: { symbol: string; chain: string; address?: string; name?: string; priceUsd: number; source: 'execution' | 'oracle' | 'cached'; fetchedAt: string; stale: boolean };
      error?: { code: string; message: string };
    }>;
  };
  /** Agent risk contract operations for reading and adjusting runtime risk limits. */
  riskContractOps?: {
    getContract(): Promise<import('../agent-risk-contract.js').ResolvedAgentRiskContract>;
    adjustOverrides(overrides: Record<string, number | null>): Promise<{ ok: boolean; error?: string; contract?: import('../agent-risk-contract.js').ResolvedAgentRiskContract }>;
    /** Resolve the full 9-field risk profile (read-only view including immutable fields). */
    getProfile?(): Promise<import('../agent-risk-contract.js').ResolvedAgentRiskProfile>;
  };
  /** Instrument repository for find_instrument lookups. */
  instrumentRepo?: {
    search(opts: { query: string; venue?: string; limit?: number }): Promise<Array<{
      id: string;
      symbol: string;
      base: string;
      quote: string;
      type: string;
      venue: string;
      tickSize: string;
      lotSize: string;
    }>>;
  };
  /** Agent repository for get_account_summary (capital, etc.). */
  agentRepo?: {
    getAgent(agentId: string): Promise<{ capital: string | null; risk: Record<string, unknown> | null } | null>;
  };
  /** Trading-owned execution-config lookup for account summaries (mode + position sizing). */
  executionConfig?: {
    getExecutionConfig(): Promise<{
      mode: string | null;
      positionSizeMode: string | null;
      fixedPositionSize: string | null;
    } | null>;
  };
  /** Operator-configured risk defaults (17-field `agentRiskDefaults` block). Traderton is the sole authority; a read tool exposes it and profile writes enforce its ceilings. */
  operatorRiskDefaults?: import('../config/schema.js').AgentRiskDefaultsConfig;
  /**
   * Venue-aware candle fetcher for read-only market/strategy tools (e.g.
   * score_candidate). Fetches candles BEHIND the boundary — orderbook targets
   * route to the orderbook provider, swap targets to the swap provider by
   * network + poolAddress. Keeping the fetch here (not in the caller's payload)
   * is required by the legal-isolation objective: the consumer must not fetch
   * trading candle data. Optional because most tools don't score candidates.
   */
  scannerCandleFetcher?: (
    target: import('../scanner-types.js').ScannerCandleTarget,
    interval: string,
    limit: number,
  ) => Promise<import('../ports/candle-fetcher.js').PriceCandle[]>;
  /**
   * Swap token→pools resolver for the `score_candidate` swap arm. Resolves a
   * held token (network + token address) to its DEX pools BEHIND the boundary —
   * threaded the same way as `scannerCandleFetcher` (from the same GeckoTerminal
   * config), so the consumer passes only the token identity and never fetches
   * pool data itself (legal-isolation). `score_candidate` ranks the pools
   * (highest liquidity, tie-break volume then address) and scores the winner's
   * candles via `scannerCandleFetcher`. Optional — swap-token resolution
   * degrades to `market_data_not_configured` when absent, mirroring the fetcher.
   */
  scannerPoolResolver?: (
    network: string,
    tokenAddress: string,
  ) => Promise<Array<{ poolAddress: string; network: string; liquidityUsd: number; volume24hUsd: number }>>;
  /**
   * Raw Drizzle database instance for direct table access.
   * Used by tools that need to query tables without a dedicated repository
   * (e.g., market assessment artifacts, preset transitions).
   * Provided by the worker runtime. Typed loosely because the domain package
   * cannot depend on @herobids/db.
   */
  db?: unknown;
  /**
   * Economic-calendar read provider for `get_economic_calendar`. The boundary
   * composition root owns the acquisition loop (fetch + Redis cache + periodic
   * refresh) and threads the SAME single provider instance into every
   * invocation — the tool only ever performs a cache-only read
   * (`getUpcomingEvents({ cacheOnly: true })`), so no network call happens on
   * the tick path. Optional — the tool degrades to
   * `economic_calendar_not_configured` when absent (mirrors the
   * `market_data_not_configured` degrade).
   */
  economicCalendarProvider?: EconomicCalendarProvider;
}

/**
 * Tool contract for LLM tool calling.
 *
 * `Ctx` defaults to the trading-clean `TradingToolContext` so this module's type
 * closure stays free of platform types. Trading tools use
 * `AgentTool<TradingToolContext>` (or the `TradingAgentTool` alias) directly.
 * Platform tools opt into the full platform context via the platform `AgentTool`
 * alias in ../tools.ts, which binds `Ctx` to the full `ToolContext`. The tool
 * objects are consumed by a registry that calls `execute(params, fullCtx)`;
 * passing a full `ToolContext` to a tool expecting `TradingToolContext` is safe
 * because the full context is assignable to the trading base.
 */
export interface AgentTool<Ctx extends TradingToolContext = TradingToolContext> {
  name: string;
  description: string;
  /** Zod schema for runtime validation */
  parametersSchema: z.ZodType;
  /** JSON Schema for LLM function calling (derived from parametersSchema) */
  parameters: Record<string, unknown>;
  /** Composite category (e.g., "execute-trade", "read-database") */
  category: ToolCategory;
  /**
   * Optional prompt-facing usage notes rendered near this tool's name in the
   * system prompt. Keep concise — argument-level semantics that cannot be
   * derived from the JSON schema alone.
   */
  promptGuidance?: string;
  /**
   * Owner-scoped, needs NO venue resolution. Set `true` for side-effecting tools
   * that write tables directly (via `ctx.db`) or act on owner/agent-scoped state
   * and NEVER drive the executor (never use `ctx.publishToInbound`) — e.g.
   * `provision_venue_account`, `adjust_risk_limits`, the watch tools. The boundary
   * subject-resolver uses this to skip the venue-account requirement (a pure
   * owner-scoped write needs no venue coordinates; requiring one would wrongly
   * fail `precondition.not_ready`, and would deadlock `provision_venue_account`
   * which CREATES the owner's first venue account).
   *
   * DEFAULT (absent/`false`) = NEEDS venue resolution — the fail-closed default:
   * a new non-drive tool that forgets to set this merely refuses to run
   * (visible, non-destructive), whereas defaulting the other way could let a
   * drive tool run without venue coordinates (silent + dangerous). Read-only
   * tools are handled separately by their category and need not set this.
   */
  ownerScopedNoVenue?: boolean;
  execute(params: unknown, ctx: Ctx): Promise<ToolResult>;
}

/** Trading-context-narrowed alias of {@link AgentTool}. */
export type TradingAgentTool = AgentTool<TradingToolContext>;

/** Provider-neutral tool definition for LLM tool calling */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  promptGuidance?: string;
}

/** Helper to check if a category implies read-only access */
export function isReadOnlyCategory(category: ToolCategory): boolean {
  return category.startsWith('read-');
}

/** Extract operation from composite category (e.g., "execute-trade" → "execute") */
export function getCategoryOperation(category: ToolCategory): 'read' | 'write' | 'execute' {
  if (category.startsWith('read-')) return 'read';
  if (category.startsWith('write-')) return 'write';
  return 'execute';
}

/** Extract target from composite category (e.g., "execute-trade" → "trade") */
export function getCategoryTarget(category: ToolCategory): string {
  const parts = category.split('-');
  return parts.slice(1).join('-');
}
