import type { Redis } from 'ioredis';
import type {
  AppConfig,
  MarketSnapshot,
  OrderbookVenuePort,
  SwapVenuePort,
  Strategy,
  StrategyConfig,
  CandleFetcher,
} from '@traderton/domain';
import { BotConfigSchema } from '@traderton/domain';
import {
  createDatabase,
  PgJournal,
  FillRepository,
  PositionRepository,
  ExecutionPlanRepository,
  OrderRepository,
  BalanceSnapshotRepository,
  ReconciliationEventRepository,
  DecisionRepository,
  BacktestingRepository,
  BotRepository,
  TokenSafetyOverrideRepository,
} from '@traderton/db';
import { MarkSelector, createFillFirstMarkSource } from '@traderton/engine';
import {
  OracleMarkSource,
  HyperliquidMarkSource,
  PublicStreamPool,
  VenueCandleFetcher,
  HyperliquidAdapter,
  BybitAdapter,
  JupiterSwapAdapter,
} from '@traderton/venues';
import type { SwapConfirmationPoller } from '@traderton/venues';
import { createProviderRegistry, lookupCanonical, resolveTokenSafetyPolicyConfig } from '@traderton/market-data';
import type { ProviderRegistry, RedisEvalClient } from '@traderton/market-data';
import { MechanicalStrategy, DcaStrategy } from '@traderton/strategy';
import { MarketDataRecorder } from '@traderton/backtesting';

import { createLogger } from '../logger.js';
import { createIdGen } from './id-gen.js';
import { InstanceLease } from '../instance-lease.js';
import {
  WorkerRuntime,
  type InstanceLoader,
  type WorkerRuntimeConfig,
} from '../runtime.js';
import { TradingActor, type TradingActorDeps } from '../trading-actor.js';
import { VenueAdapterFactory, CredentialResolutionError } from '../venue-adapter-factory.js';
import { createSwapTokenSafetyAdapter } from '../token-safety-adapter.js';
import { resolveSwapTokenData, type CanonicalResolver, type DexScreenerProvider } from '../swap-token-resolver.js';
import { enrichTokenWithDiscovery } from '../swap-token-enrichment.js';
import { buildPublicStreamConnectors, createScopedStreamPoolHandle } from '../public-stream-routing.js';
import {
  VenueInstrumentCache,
  normalizeHyperliquidSymbol,
  normalizeBybitSymbol,
  identityNormalize,
  type VenueSymbolProvider,
} from '../venue-instrument-cache.js';
import { assertLiveReadiness } from '../live-gate.js';
import { resolveSwapNetwork } from './../resolve-swap-assets.js';
import type { ExecutionActor } from '../execution-actor.js';
import {
  submitDecision,
  constructAndRegisterAgentActor,
  stopAndDeregisterAgentActor,
  type DecisionSubmitInput,
  type DecisionSubmitResult,
  type AgentActorSpec,
  type AgentActorRuntimeDeps,
} from './decision-intake.js';
import type { AgentTradingActor } from '../agent-trading-actor.js';
import {
  createDriveTarget,
  type PublishToInbound,
  type BotLimitSeam,
} from './drive-target.js';
import type { LifecycleCommand } from '../runtime.js';

const logger = createLogger('create-trading-runtime');

/**
 * Ports for the trading composition root (Phase 9b item B).
 *
 * Ports-carry-values (000/004): these are config **values** and platform-owned
 * **values** only — never a port that injects trading behaviour. The risk gate,
 * planner, executors, and reconciliation are constructed internally from the
 * copied engine and are not overridable.
 */
export interface TradingRuntimePorts {
  /** Operator config — the Traderton-owned AppConfig (item A). */
  config: AppConfig;
  /** Redis client (BullMQ lifecycle-job connection + instance lease). */
  redis: Redis;
  /**
   * Loads bots to rehydrate (status='running'). Each PersistedInstance.config
   * carries the INJECTED venueAccountId + soft ownerId (decisions 11–13) — NOT
   * connectionId/userId. This is the M1 injection point.
   */
  instanceLoader: InstanceLoader;
  /** Interval (ms) between strategy scan ticks. Default: WorkerRuntime default. */
  scanIntervalMs?: number;
  /** Number of instances this worker runs simultaneously. Default: WorkerRuntime default. */
  concurrency?: number;
}

/**
 * The assembled bot-lifecycle trading runtime (Phase 9b items B + C).
 *
 * Item B owns the ONE `actorRegistry` (decision (b)); both bots (`TradingActor`)
 * and agents (`AgentTradingActor`) register on it. Item C's surfaces
 * (`submitDecision`, agent-actor construct/register) compose over that same map.
 * Item D (drive) enqueues lifecycle jobs onto `runtime` and calls
 * `submitDecision` / `constructAndRegisterAgentActor` / `stopAndDeregisterAgentActor`.
 */
export interface TradingRuntime {
  /** Start rehydration + lifecycle-job consumer + reclaim loop. */
  start(): Promise<void>;
  /** Graceful shutdown. */
  shutdown(): Promise<void>;
  /** The BullMQ-backed lifecycle control — exposed so item D / M2 can enqueue jobs. */
  runtime: WorkerRuntime;
  /**
   * The single ExecutionActor registry (decision (b)) — a plain map keyed by
   * actor id (bot id or agent id). Exposed read-only for inspection; register /
   * deregister go through the hooks below so bots and agents share one map.
   */
  actorRegistry: ReadonlyMap<string, ExecutionActor>;
  /** Register an actor (used by C's agent construct/register + the bot factory). */
  registerActor(actorId: string, actor: ExecutionActor): void;
  /** Deregister an actor (stop/crash). */
  deregisterActor(actorId: string): void;
  /**
   * Route a submitted decision to the registered, running actor and drive the
   * copied engine (item C). Item D calls this from the drive path.
   */
  submitDecision(input: DecisionSubmitInput): Promise<DecisionSubmitResult>;
  /**
   * Construct + register the agent-direct `AgentTradingActor` (item C, decision
   * (c)). Does NOT start it — the lifecycle driver is item D / the M1 consumer.
   */
  constructAndRegisterAgentActor(spec: AgentActorSpec): AgentTradingActor;
  /** Stop + deregister an agent actor (paired teardown hook — item C). */
  stopAndDeregisterAgentActor(actor: AgentTradingActor): Promise<void>;
  /**
   * Enqueue a bot lifecycle command (start/stop/restart) onto the runtime's
   * copied queue (item D). Thin passthrough over `runtime.enqueueLifecycle` — no
   * new lifecycle behaviour.
   */
  enqueueLifecycle(command: LifecycleCommand, botId: string, config?: Record<string, unknown>): Promise<void>;
  /**
   * Build the in-process `publishToInbound` drive target (Phase 9b item D) bound
   * to one owned actor. The consumer sets the returned port on the copied tools'
   * `TradingToolContext.publishToInbound`. It routes `DECISION_SUBMIT` → item C's
   * `submitDecision` (+ reply write) and `MANAGE_BOT` → the bot-lifecycle handler
   * over the copied `WorkerRuntime`; there is no `BOT_QUERY` route.
   *
   * `injection` carries the platform-owned VALUES the consumer injects per owned
   * actor (ports-carry-values): the soft `ownerId`, the registry/creator
   * `actorId`, the owner execution `ownerMode`, the resolved
   * `venue`/`venueType`/`venueAccountId`, and — when item E is wired — the atomic
   * per-`ownerId` `botLimit` seam (absent → create/non-reclaim-start refuse).
   */
  createDriveTarget(injection: DriveTargetInjection): PublishToInbound;
}

/**
 * The per-owned-actor VALUES the M1 consumer injects when building a drive
 * target (ports-carry-values, 000/004). Every field is platform-owned data, not
 * trading behaviour. See `DriveTargetDeps` in ./drive-target.ts for the full
 * trace to the dropped herobids agent/grant/LLM shell.
 */
export interface DriveTargetInjection {
  /** Authenticated soft owner (decision 10; NOT the `agents` table). */
  ownerId: string;
  /** Registry routing key + `creatorId` for created bots (decision (a): `ctx.agentId`). */
  actorId: string;
  /** Owner/agent execution mode for the mode-escalation guard. */
  ownerMode: 'paper' | 'shadow' | 'live';
  /** INJECTED resolved venue coordinates (decisions 11–13). */
  venue: string;
  venueType: 'orderbook' | 'swap';
  venueAccountId: string;
  /**
   * Optional per-`ownerId` maxBots override VALUE (ports-carry-values). When
   * supplied, the item-E seam wiring uses this cap for the owner instead of the
   * operator default (`config.agentRiskDefaults.maxBots`). Traderton owns the
   * default + the enforcement; the consumer may only inject a limit VALUE, never
   * the enforcement. Omit to use the operator default. (013 §7 decision 1.)
   */
  maxBotsOverride?: number;
  /**
   * ESCAPE HATCH: a fully consumer-supplied `BotLimitSeam` (item E). Normally the
   * seam is built HERE from the `BotRepository` singleton + the resolved
   * `maxBots`, so a consumer never needs this — it exists only so a caller (e.g.
   * a test, or a future non-Postgres backing) can substitute the seam wholesale.
   * When set, it takes precedence over the internally-built seam.
   */
  botLimit?: BotLimitSeam;
}

/**
 * createStrategy — mechanical/dca only (locked decision 013 §4.1d).
 *
 * `llm`/`hybrid` are absent from `@traderton/strategy` (bots are mechanical-only,
 * decisions 7–9) and are already rejected upstream by the mechanical-only
 * `BotConfigSchema` (item A′) before this runs, so those branches are unreachable
 * via a valid bot config. The defensive `throw` is belt-and-braces. This is
 * covered by the existing mechanical-only Intentional Divergence in the parity
 * ledger — no new Gap/ledger row.
 *
 * Traced to herobids apps/worker/src/index.ts:1620–1657 (llm/hybrid branches
 * dropped — those strategies do not exist in Traderton).
 */
function createStrategy(
  idGen: ReturnType<typeof createIdGen>,
  strategyConfig: StrategyConfig,
  candleFetcher?: CandleFetcher,
): Strategy {
  // DCA is timer-driven, no signal evaluation — route to DCA executor
  if (strategyConfig.type === 'dca') {
    return new DcaStrategy();
  }

  // For non-DCA, key on decisionMode to select the engine
  switch (strategyConfig.decisionMode) {
    case 'mechanical': {
      if (!candleFetcher) {
        throw new Error(`'mechanical' strategy requires marketData to be configured (CandleFetcher unavailable)`);
      }
      return new MechanicalStrategy(candleFetcher, null, () => idGen.decisionId());
    }

    default:
      // llm/hybrid are rejected by BotConfigSchema (item A′) before this runs.
      throw new Error(`Unsupported decisionMode: ${String(strategyConfig.decisionMode)}`);
  }
}

/**
 * Bind the venue-scoped public-stream-pool handle for a specific agent actor.
 *
 * The base AgentActorRuntimeDeps carries every worker-scoped singleton EXCEPT
 * `createStreamPoolHandle`, which is venue-scoped (the pool fans out one socket
 * per venue). The agent's venue comes from its spec, so the closure is bound
 * here — mirroring the per-bot `createScopedStreamPoolHandle(publicStreamPool,
 * venue, testnet)` wiring in the ActorFactory. Swap venues get no handle.
 */
function buildAgentActorRuntimeDeps(
  base: AgentActorRuntimeDeps,
  publicStreamPool: PublicStreamPool | undefined,
  spec: AgentActorSpec,
): AgentActorRuntimeDeps {
  return {
    ...base,
    createStreamPoolHandle: spec.venueType !== 'swap'
      ? (testnet: boolean) => createScopedStreamPoolHandle(publicStreamPool, spec.venue, testnet)
      : undefined,
  };
}

/**
 * createTradingRuntime — the trading composition root (Phase 9b item B).
 *
 * Authored WIRING ONLY. Every trading primitive (risk gate, planner, executors,
 * actors, mark sources, venue adapters, strategies, reconciliation) is already
 * copied into `@traderton/*` and is constructed — never re-implemented — here.
 *
 * Scope is BOT `TradingActor` only (013 §4.1a). AgentTradingActor, the actor
 * registry, decision intake, the tool registry, and maxBots are later items.
 */
export function createTradingRuntime(ports: TradingRuntimePorts): TradingRuntime {
  const { config, redis, instanceLoader } = ports;

  // ── Once-per-process singletons (traced to herobids index.ts ~209–334, 771–791) ──
  const workerId = `worker-${crypto.randomUUID().slice(0, 8)}`;
  const lease = new InstanceLease(redis, workerId, 30);

  const db = createDatabase(config.database.url);
  const journal = new PgJournal(db);
  const fillRepo = new FillRepository(db);
  const positionRepo = new PositionRepository(db);
  const planRepo = new ExecutionPlanRepository(db);
  const orderRepo = new OrderRepository(db);
  const balanceSnapshotRepo = new BalanceSnapshotRepository(db);
  const reconciliationRepo = new ReconciliationEventRepository(db);
  const decisionRepo = new DecisionRepository(db);
  const backtestingRepo = new BacktestingRepository(db);
  // Token-safety override repo — constructed ONCE per runtime (not per-bot); the
  // swap token-safety adapter (built per-bot in the ActorFactory) consumes it.
  const tokenSafetyOverrideRepo = new TokenSafetyOverrideRepository(db);
  // Bot repository — the item-D drive target's bot-lifecycle handler reads/updates
  // bot rows through it (getBotById/updateBotConfig/markBotRunning/… — the
  // persist/limit primitives were deleted Phase 2 and are item E's seam).
  const botRepo = new BotRepository(db);

  const idGen = createIdGen();

  // ── The ONE ExecutionActor registry (decision (b), Phase 9b item C) ──
  // A plain Map (NOT ActorStateOwner — that is agent-session machinery). Both
  // bots (TradingActor, registered in the ActorFactory below) and agents
  // (AgentTradingActor, via constructAndRegisterAgentActor) register here. The
  // decision handler resolves the target actor from this same map.
  const actorRegistry = new Map<string, ExecutionActor>();

  // Market-data provider registry — optional (undefined when marketData absent).
  // Feeds the per-bot candle fetcher used by the mechanical strategy.
  // `createProviderRegistry` is async (it validates provider keys at startup),
  // so the once-per-process registry is constructed in `start()` — before any
  // bot rehydrates — and captured here for the ActorFactory closure.
  let sharedMarketDataRegistry: ProviderRegistry | undefined;

  // Reconciliation config sourced from operator config.
  const reconciliationConfig = config.reconciliation;

  // Worker-scoped mark sources (stateless, safe to share).
  // Composite fallback: Hyperliquid mids first (all listed perps), then CoinGecko.
  const oracleMarkSource = new OracleMarkSource({
    baseUrl: config.marking.oracleBaseUrl,
    timeoutMs: config.marking.oracleTimeoutMs,
    vsCurrency: config.marking.oracleVsCurrency,
  });
  const hyperliquidMarkSource = new HyperliquidMarkSource({
    timeoutMs: config.marking.oracleTimeoutMs,
  });
  const compositeFallbackSource = new MarkSelector(
    { stalenessThresholdMs: 30_000 },
    hyperliquidMarkSource,
    oracleMarkSource,
  );

  // Worker-scoped public stream pool — one WebSocket per venue, fan-out to all
  // actors. Undefined when no orderbook venue has a wsUrl configured.
  const streamConnectors = buildPublicStreamConnectors(config.venues);
  const publicStreamPool = streamConnectors.size > 0
    ? new PublicStreamPool(config.streams.public, streamConnectors)
    : undefined;

  // Shared venue adapter factory — credential resolution + adapter construction.
  const venueAdapterFactory = new VenueAdapterFactory({
    db,
    journal,
    venues: config.venues,
    streamConfig: config.streams.private,
  });

  // ── Venue instrument cache — symbol validation at decision intake ──
  // Traced to herobids apps/worker/src/index.ts:797 (construct once, before
  // actors) + :1684–1733 (build providers). The cache gates the copied
  // `instrument_unknown` rejection in the agent actor's intake
  // (agent-trading-actor.ts:~886, `if (this.deps.instrumentCache?.isReady())`).
  // Without it that KEEP behaviour silently fails open for every agent decision.
  // Warmup + periodic refresh happen in start() (after the runtime is assembled,
  // before any actor accepts decisions). Until isReady() flips true validation
  // is a fail-open no-op — the warmup is fail-open by design and must not crash.
  const instrumentCache = new VenueInstrumentCache(logger);

  // Build providers from the configured venues using lightweight adapters
  // constructed with empty / validation-only credentials — fetchAvailableSymbols()
  // hits public endpoints (loadMarkets for Hyperliquid/Bybit; token lists for
  // Jupiter), so no real credentials are needed. Adapter shapes copied verbatim
  // from herobids index.ts:1690 / :1706 / :1721.
  const venueSymbolProviders: VenueSymbolProvider[] = [];

  if (config.venues['hyperliquid']) {
    const hlTestnet = config.venues['hyperliquid'].testnet ?? false;
    const adapter = new HyperliquidAdapter({
      credentials: { apiKey: '', secret: '', walletAddress: '', testnet: hlTestnet },
    });
    venueSymbolProviders.push({
      venue: 'hyperliquid',
      normalizeSymbol: normalizeHyperliquidSymbol,
      fetchSymbols: async () => {
        const result = await adapter.fetchAvailableSymbols();
        if (!result.ok) throw new Error(`Failed to fetch Hyperliquid symbols: ${result.error.message}`);
        return result.data;
      },
    });
  }

  if (config.venues['bybit']) {
    const bybitTestnet = config.venues['bybit'].testnet ?? false;
    const adapter = new BybitAdapter({
      credentials: { apiKey: '', secret: '', testnet: bybitTestnet },
    });
    venueSymbolProviders.push({
      venue: 'bybit',
      normalizeSymbol: normalizeBybitSymbol,
      fetchSymbols: async () => {
        const result = await adapter.fetchAvailableSymbols();
        if (!result.ok) throw new Error(`Failed to fetch Bybit symbols: ${result.error.message}`);
        return result.data;
      },
    });
  }

  if (config.venues['jupiter']) {
    const jupiterAdapter = new JupiterSwapAdapter({
      walletAddress: 'SYMBOL_VALIDATION_ONLY',
    });
    venueSymbolProviders.push({
      venue: 'jupiter',
      normalizeSymbol: identityNormalize,
      fetchSymbols: async () => {
        const result = await jupiterAdapter.fetchAvailableSymbols();
        if (!result.ok) throw new Error(`Failed to fetch Jupiter symbols: ${result.error.message}`);
        return result.data;
      },
    });
  }

  // 1inch is intentionally skipped — its fetchAvailableSymbols() returns a
  // hardcoded curated list of token addresses per chain. Validating against
  // that list would reject legitimate tokens not in the curated set.
  // Additionally, constructing a OneInchSwapAdapter requires real credentials
  // (EvmSigner validates the private key at construction time). Preserved from
  // herobids index.ts:1735–1739.

  // ── Per-bot ActorFactory closure (traced to herobids index.ts:1878–2249) ──
  // Diverges from herobids only where 013 §4 directs: injected venueAccountId
  // (no resolveBotStartupContext), mechanical-only strategy, no-op status
  // callbacks (agent/status wiring is item C/C2).
  const actorFactory = async (botId: string, rawConfig: Record<string, unknown>): Promise<TradingActor> => {
    // 1. Validate instance config — fail fast (mechanical-only schema, item A′).
    const parseResult = BotConfigSchema.safeParse(rawConfig);
    if (!parseResult.success) {
      throw new Error(
        `Invalid config for bot ${botId}: ${parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }
    const config_ = parseResult.data;
    // venue and venueType are stamped by the consumer before persistence.
    const venue = config_.venue!;
    const venueType = config_.venueType!;

    // 2. Read the INJECTED venueAccountId (decisions 11–13). The platform grant
    //    front-end (resolveBotStartupContext) was deleted Phase 8 — the consumer
    //    resolves the grant and injects venueAccountId onto the persisted config.
    const venueAccountId = rawConfig['venueAccountId'] as string | undefined;
    if (!venueAccountId) {
      throw new Error(`Bot ${botId} has no injected venueAccountId — refusing to start`);
    }

    let testnet = false;
    let resolvedCredentialId: string | undefined;
    let credentialsPresent = false;
    let signerPresent = false;
    let venueAdapter: OrderbookVenuePort | undefined;
    let swapVenue: SwapVenuePort | undefined;
    let swapConfirmationPoller: SwapConfirmationPoller | undefined;

    // 3. Resolve adapters via the shared factory (credentials decrypt inside it).
    if (venueType !== 'swap') {
      const result = await venueAdapterFactory.buildOrderbookAdapter({
        venueAccountId,
        venue,
        actorType: 'bot',
        actorId: botId,
        executionMode: config_.execution.mode,
      });
      venueAdapter = result.venuePort;
      testnet = result.credentials.testnet;
      resolvedCredentialId = result.credentialId;
      credentialsPresent = !!(result.credentials.apiKey.trim() && result.credentials.secret.trim());
    } else if (config_.swapAssets) {
      const result = await venueAdapterFactory.buildSwapAdapter({
        venueAccountId,
        venue,
        swapAssets: config_.swapAssets,
        actorType: 'bot',
        actorId: botId,
      });
      swapVenue = result.swapVenue;
      signerPresent = result.signerPresent;
      swapConfirmationPoller = result.confirmationPoller;
    } else {
      throw new Error(
        `swapAssets config required for swap venue bot ${botId} — cannot route swaps without explicit asset identifiers and decimals`,
      );
    }

    // 4. Live-mode startup gate (fail-closed). Sources the effective per-order
    //    notional cap that feeds riskLimits below.
    const liveGateResult = assertLiveReadiness(config.liveRollout, {
      executionMode: config_.execution.mode,
      venue,
      venueType,
      venueAccountId,
      credentialsFromDb: !!resolvedCredentialId,
      credentialsPresent,
      signerPresent,
      driftAlertOnly: config.reconciliation.driftAlertOnly,
      instanceMaxOrderNotional: config_.risk.maxOrderNotional != null ? String(config_.risk.maxOrderNotional) : undefined,
    });

    const streamConfig = config.streams.private;

    const fetchPrice = async (): Promise<MarketSnapshot | null> => {
      if (!venueAdapter) return null; // Swap venues don't use orderbook ticker
      const result = await venueAdapter.fetchTicker(config_.symbol);
      if (!result.ok) {
        logger.warn({ botId, symbol: config_.symbol, error: result.error }, 'fetchTicker failed');
        return null;
      }
      return {
        symbol: config_.symbol,
        price: result.data.last,
        timestamp: result.data.timestamp,
      };
    };

    // Live market-data recording — captures top-of-book snapshots + reference
    // marks into a replay corpus when operator config enables it. Copied wiring
    // from herobids apps/worker/src/index.ts:1980–2033 (namespace-adapted:
    // appConfig→config, instanceUserId→the injected soft ownerId, and the
    // platform startupContext.connectionId metadata field dropped — the
    // connection grant front-end was deleted Phase 8). MarketDataRecorder is
    // copied + exported from @traderton/backtesting; backtestingRepo carries
    // insertCorpus/insertMarketEventsBatch/updateCorpusWindow.
    let recordMarketSnapshot: TradingActorDeps['recordMarketSnapshot'];
    let recordReferenceMark: TradingActorDeps['recordReferenceMark'];

    if (config.marketDataRecording.enabled) {
      const recorder = new MarketDataRecorder(venue);
      const corpusId = await backtestingRepo.insertCorpus({
        name: `${botId}-${new Date().toISOString()}`,
        source: 'live-recording',
        venue,
        symbols: [config_.symbol],
        ownerId: rawConfig['ownerId'] as string | undefined,
        metadata: {
          botId,
          venueAccountId,
          captureTrades: config.marketDataRecording.captureTrades,
          captureTopOfBook: config.marketDataRecording.captureTopOfBook,
          captureCandles: config.marketDataRecording.captureCandles,
        },
      });

      let corpusStartAt: Date | undefined;
      let corpusEndAt: Date | undefined;

      const flushRecordedEvents = async (): Promise<void> => {
        const events = recorder.flush();
        if (events.length === 0) return;

        await backtestingRepo.insertMarketEventsBatch(events.map((event) => ({
          corpusId,
          venue: event.venue,
          symbol: event.symbol,
          eventType: event.eventType,
          price: event.price,
          eventAt: event.eventAt,
          data: event.data,
        })));

        const batchStart = events[0]!.eventAt;
        const batchEnd = events[events.length - 1]!.eventAt;
        corpusStartAt = corpusStartAt && corpusStartAt < batchStart ? corpusStartAt : batchStart;
        corpusEndAt = corpusEndAt && corpusEndAt > batchEnd ? corpusEndAt : batchEnd;
        await backtestingRepo.updateCorpusWindow(corpusId, corpusStartAt, corpusEndAt);
      };

      recordMarketSnapshot = async (snapshot) => {
        if (!config.marketDataRecording.captureTopOfBook) return;
        recorder.recordSnapshot(snapshot);
        await flushRecordedEvents();
      };

      recordReferenceMark = async (mark) => {
        recorder.recordMark(mark.symbol, mark.price, mark.source, mark.timestamp);
        await flushRecordedEvents();
      };
    }

    const swapNetwork = resolveSwapNetwork(venue, undefined, config.venues['1inch']);
    if (venueType === 'swap' && venue === '1inch' && config.marketData?.tokenSafety?.enabled && !swapNetwork) {
      throw new CredentialResolutionError(
        `Unsupported 1inch chainId ${String(config.venues['1inch']?.chainId)} for token safety on bot ${botId}`,
      );
    }

    // Per-bot candle fetcher — mechanical strategy phases consume OHLCV. Undefined
    // when marketData is not configured (paper bots without a mechanical strategy).
    const candleFetcher: CandleFetcher | undefined = sharedMarketDataRegistry
      ? new VenueCandleFetcher(
          sharedMarketDataRegistry.configs.binance,
          swapNetwork != null
            ? { config: sharedMarketDataRegistry.configs.geckoterminal, network: swapNetwork }
            : null,
          venueType === 'swap' ? 'swap' : 'orderbook',
        )
      : undefined;

    // 5. Strategy — mechanical/dca only (013 §4.1d).
    const strategy = createStrategy(idGen, config_.strategy, candleFetcher);

    // Swap token-safety adapter — gates swap-venue buys against liquidity/volume/age
    // thresholds. The outer guard (config.marketData && sharedMarketDataRegistry)
    // prevents creation when the registry is absent (orderbook/paper bots keep
    // swapTokenSafety undefined). The inner null-check defends against a theoretical
    // edge case where the closure is invoked after the module-level variable is
    // reassigned (capture-by-reference, not by value). The override repo is the
    // once-per-runtime instance. Copied from herobids index.ts:243–268 + :2035–2062.
    const swapTokenSafety = config.marketData && sharedMarketDataRegistry
      ? createSwapTokenSafetyAdapter({
          marketDataConfig: config.marketData,
          overrideRepo: tokenSafetyOverrideRepo,
          resolveTokenData: async (network, tokenAddress) => {
            // Capture into a local const so the null-narrowing survives into the
            // nested provider closures below (the module-level binding is a
            // reassignable `let`, unlike herobids' const, so TS can't keep the
            // narrowing across capture-by-reference).
            const registry = sharedMarketDataRegistry;
            const marketData = config.marketData;
            if (!registry || !marketData) {
              return null;
            }
            const canonicalResolver: CanonicalResolver = {
              resolve: (symbol, net) => {
                const policy = resolveTokenSafetyPolicyConfig(marketData);
                return lookupCanonical(symbol, net, policy.canonicalTokens);
              },
            };
            const dexScreenerProvider: DexScreenerProvider = {
              search: (addr) => registry.dexscreener.search(addr),
            };
            const result = await resolveSwapTokenData(
              dexScreenerProvider, network, tokenAddress, canonicalResolver,
            );
            if (!result) return null;
            // Enrich with discovery data when pool creation timestamp is missing
            // from the DexScreener result (handled by the resolver for canonical
            // synthetic fallback, needed only for live DexScreener matches).
            if (!result.poolCreatedAt && result.hasRealMarketData) {
              return enrichTokenWithDiscovery(registry, network, result.address, result);
            }
            return result;
          },
        })
      : undefined;

    const deps: TradingActorDeps = {
      strategy,
      journal,
      fillRepo,
      positionRepo,
      planRepo,
      orderRepo,
      decisionRepo,
      backtestingRepo,
      balanceSnapshotRepo,
      reconciliationRepo,
      // riskLimits built INLINE from config.risk (bots do this; agents use
      // buildAgentRiskLimits). Field mapping traced to herobids index.ts:2079–2086.
      riskLimits: {
        maxOpenPositions: config_.risk.maxOpenPositions ?? 5,
        maxPositionSizePct: config_.risk.maxPositionSizePct,
        dailyMaxLossPct: config_.risk.dailyMaxLossPct,
        stopLossCooldownMs: config_.risk.stopLossCooldownMs,
        stopLossMaxUnrealizedLossPct: config_.risk.stopLossPct,
        maxOrderNotional: liveGateResult.effectiveMaxOrderNotional,
      },
      idGen,
      fetchPrice,
      venuePort: config_.execution.mode === 'paper' ? undefined : (venueAdapter ?? undefined),
      reconciliationConfig,
      executionMode: config_.execution.mode,
      streamConfig,
      venue,
      symbol: config_.symbol,
      venueAccountId,
      venueType,
      swapAssets: config_.swapAssets,
      swapNetwork,
      swapBaseTokenAddress: venueType === 'swap' ? config_.swapAssets?.baseAsset : undefined,
      swapVenue,
      streamPool: venueType !== 'swap'
        ? createScopedStreamPoolHandle(publicStreamPool, venue, testnet)
        : undefined,
      markSource: createFillFirstMarkSource({
        fillLookup: fillRepo,
        actorId: botId,
        fallbackSource: compositeFallbackSource,
        stalenessThresholdMs: config.marking.stalenessThresholdMs,
      }),
      // Live market-data recording hooks — wired from the recorder block above
      // (undefined when config.marketDataRecording.enabled is false). Copied from
      // herobids index.ts:1980–2033.
      recordMarketSnapshot,
      recordReferenceMark,
      shadowPollIntervalMs: config_.shadowPollIntervalMs ?? config.execution.shadowPollIntervalMs,
      shadowQuoteSlippageBps: config.execution.shadowQuoteSlippageBps,
      credentialId: resolvedCredentialId,
      swapTokenSafety,
      feeConfig: config.simulation,
      maxConsecutiveVenueErrors: config.liveRollout.maxConsecutiveVenueErrors,
      slippageAlertBps: config.liveRollout.slippageAlertBps,
      crashPolicy: config.liveRollout.crashPolicy,
      botConfigInvalidHaltThreshold: config.agentRiskDefaults.botConfigInvalidHaltThreshold,
      botExecutionErrorHaltThreshold: config.agentRiskDefaults.botExecutionErrorHaltThreshold,
      botLlmProviderErrorHaltThreshold: config.agentRiskDefaults.botLlmProviderErrorHaltThreshold,
      liveOrderTimeoutPolicy: {
        limitOrderTimeoutMs: config.liveRollout.limitOrderTimeoutMs,
        marketOrderTimeoutMs: config.liveRollout.marketOrderTimeoutMs,
      },
      swapConfirmationPoller,
      candleFetcher,
      swapTokenSafetyThresholds: (config_.tokenSafety?.minLiquidityUsd != null || config_.tokenSafety?.minVolume24hUsd != null || config_.tokenSafety?.minAgeHours != null || config_.tokenSafety?.allowOverrides != null)
        ? {
            minLiquidityUsd: config_.tokenSafety!.minLiquidityUsd,
            minVolume24hUsd: config_.tokenSafety!.minVolume24hUsd,
            minAgeHours: config_.tokenSafety!.minAgeHours,
            allowOverrides: config_.tokenSafety!.allowOverrides,
          }
        : undefined,
      riskPlaybook: (config_.risk.maxNewPositionsPerDay != null || config_.risk.avoidParabolicMovePct != null)
        ? {
            maxNewPositionsPerDay: config_.risk.maxNewPositionsPerDay,
            avoidParabolicMovePct: config_.risk.avoidParabolicMovePct,
          }
        : undefined,
      // onCrashed keeps trading lifecycle intact (013 §4.4). The herobids body
      // also published agent/status telemetry — that is item C2; here it reduces
      // to the runtime crash handoff + registry deregistration.
      onCrashed: async (instanceId: string) => {
        actorRegistry.delete(instanceId);
        await runtime.handleActorCrash(instanceId);
        logger.error({ botId: instanceId }, 'Bot crashed — removed from runtime + registry');
      },
    };

    const actor = new TradingActor(botId, config_.strategy.params as Record<string, unknown>, deps);
    // Register the bot on the ONE shared registry (decision (b)) so decisions
    // route to it via the item-C handler. Deregistered on crash (onCrashed above).
    actorRegistry.set(botId, actor);
    return actor;
  };

  // ── WorkerRuntime (the BullMQ lifecycle-job consumer) ──
  // M1 status callbacks are no-op stubs (their herobids bodies update the bots
  // table + publish status → item C2). onCrashed lives on TradingActorDeps above.
  const runtimeConfig: WorkerRuntimeConfig = {
    redis,
    ...(ports.scanIntervalMs != null ? { scanIntervalMs: ports.scanIntervalMs } : {}),
    ...(ports.concurrency != null ? { concurrency: ports.concurrency } : {}),
    onStartFailed: async () => {},
    onStopped: () => {},
    onStarted: () => {},
  };

  const runtime = new WorkerRuntime(runtimeConfig, actorFactory, instanceLoader, lease);

  // ── Item-C registry hooks + agent-actor runtime deps (shared singletons) ──
  const registerActor = (actorId: string, actor: ExecutionActor): void => {
    actorRegistry.set(actorId, actor);
  };
  const deregisterActor = (actorId: string): void => {
    actorRegistry.delete(actorId);
  };

  // The item-B singletons the agent-direct actor shares with bots (013 §6 / 019
  // §6). Assembled once; threaded into each agent actor's deps so B and C
  // compose over the same infrastructure.
  const agentActorRuntimeDeps: AgentActorRuntimeDeps = {
    venueAdapterFactory,
    journal,
    idGen,
    positionRepo,
    fillRepo,
    planRepo,
    orderRepo,
    decisionRepo,
    balanceSnapshotRepo,
    backtestingRepo,
    reconciliationRepo,
    fallbackMarkSource: compositeFallbackSource,
    // createStreamPoolHandle is venue-scoped and bound per-actor in
    // buildAgentActorRuntimeDeps (the venue comes from the AgentActorSpec).
    reconciliationConfig,
    streamConfig: config.streams.private,
    liveRollout: config.liveRollout,
    driftAlertOnly: config.reconciliation.driftAlertOnly,
    feeConfig: config.simulation,
    maxConsecutiveVenueErrors: config.liveRollout.maxConsecutiveVenueErrors,
    slippageAlertBps: config.liveRollout.slippageAlertBps,
    crashPolicy: config.liveRollout.crashPolicy,
    liveOrderTimeoutPolicy: {
      limitOrderTimeoutMs: config.liveRollout.limitOrderTimeoutMs,
      marketOrderTimeoutMs: config.liveRollout.marketOrderTimeoutMs,
    },
    agentRiskDefaults: config.agentRiskDefaults,
    markStalenessThresholdMs: config.marking.stalenessThresholdMs,
    // Venue-specific instrument-validation deps (traced to herobids
    // index.ts:1273–1279). instrumentCache is load-bearing — it gates the copied
    // `instrument_unknown` rejection in the agent intake. oneInchConfig +
    // canonicalTokens support swap-venue network/quote-address resolution;
    // perTradeLevelMonitorIntervalMs overrides the actor's 5000ms fallback.
    // bindingProfile (herobids index.ts:1275) is NOT wired — it is an
    // agent-binding value, not Traderton config; left as the actor's default.
    instrumentCache,
    oneInchConfig: config.venues['1inch'],
    canonicalTokens: config.marketData?.tokenSafety?.canonicalTokens,
    perTradeLevelMonitorIntervalMs: config.agentRiskDefaults.perTradeLevelMonitorIntervalMs,
  };

  return {
    start: async () => {
      if (config.marketData) {
        sharedMarketDataRegistry = await createProviderRegistry(config.marketData, {
          redisClient: redis as unknown as RedisEvalClient,
          discoverySeenClient: redis,
        });
      }
      // Warm the venue instrument cache + start its hourly refresh before any
      // actor accepts decisions (traced to herobids index.ts:1743–1744). Warmup
      // is fail-open by design — the copied VenueInstrumentCache.warmup handles
      // per-venue fetch failure internally, so it must not crash the runtime.
      await instrumentCache.warmup(venueSymbolProviders);
      instrumentCache.startPeriodicRefresh(venueSymbolProviders, 60 * 60 * 1000);
      await runtime.start();
    },
    shutdown: async () => {
      // Stop the instrument-cache refresh interval so it doesn't outlive the
      // runtime (the copied stop() is idempotent).
      instrumentCache.stop();
      await runtime.shutdown();
    },
    runtime,
    actorRegistry,
    registerActor,
    deregisterActor,
    submitDecision: (input) => submitDecision(actorRegistry, input),
    constructAndRegisterAgentActor: (spec) =>
      constructAndRegisterAgentActor(
        { register: registerActor, deregister: deregisterActor },
        buildAgentActorRuntimeDeps(agentActorRuntimeDeps, publicStreamPool, spec),
        spec,
      ),
    stopAndDeregisterAgentActor: (actor) =>
      stopAndDeregisterAgentActor({ register: registerActor, deregister: deregisterActor }, actor),
    enqueueLifecycle: (command, botId, config) => runtime.enqueueLifecycle(command, botId, config),
    createDriveTarget: (injection) => {
      // ── Item-E maxBots seam wiring (AUTHORED — the only authored surface) ──
      // Build the per-`ownerId` BotLimitSeam from the BotRepository singleton,
      // closing over the resolved `maxBots` VALUE (013 §7 decision 1): the
      // operator default (config.agentRiskDefaults.maxBots) unless the consumer
      // injects a per-owner override VALUE (`maxBotsOverride`). The db methods stay
      // pure value-taking primitives — the "which limit for this owner" policy
      // lives here in the injectable wiring, never the db layer.
      //
      // A per-`ownerId`→override table is a consumer-side extension point, NOT a
      // Traderton-owned config table (013 §7): supply `maxBotsOverride` per drive
      // target if a caller needs a non-default cap for a specific owner.
      const maxBots = injection.maxBotsOverride ?? config.agentRiskDefaults.maxBots;
      const botLimit: BotLimitSeam = injection.botLimit ?? {
        tryCreateBotWithLimit: (spec) => botRepo.tryCreateBotWithLimit({ ...spec, maxBots }),
        tryMarkBotRunningWithLimit: (spec) => botRepo.tryMarkBotRunningWithLimit({ ...spec, maxBots }),
      };
      return createDriveTarget({
        runtime,
        submitDecision: (input) => submitDecision(actorRegistry, input),
        botRepo,
        redis,
        botLimit,
        ownerId: injection.ownerId,
        actorId: injection.actorId,
        ownerMode: injection.ownerMode,
        venue: injection.venue,
        venueType: injection.venueType,
        venueAccountId: injection.venueAccountId,
      });
    },
  };
}
