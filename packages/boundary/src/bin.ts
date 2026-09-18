// AUTHORED (Phase 9b item F1 shell; F2b real runtime) — the boundary process
// entry. Assembles the copied tool registry, reads the boundary + trading
// config, stands up a real `createTradingRuntime`, and starts the Fastify app.
//
// F2b turns F1's NOOP context into a REAL `TradingToolContext`: a live `ioredis`
// client, the runtime's `createDriveTarget(injection)` as `publishToInbound`, and
// a real `botRepo` — so side-effecting tools (submit_decision / create_bot /
// stop_bot / …) execute. The subject→injection VALUES come from the authored D2
// resolver (`subject-resolver.ts`). All HTTP/HMAC/idempotency wiring stays in the
// boundary package (the 000 invariant); the dispatcher stays wiring-free.

import { Redis } from 'ioredis';
import { and, eq } from 'drizzle-orm';
import type { TradingToolContext, ToolCategory } from '@traderton/domain';
import { isReadOnlyCategory } from '@traderton/domain';
import {
  createDatabase,
  BotRepository,
  InstrumentRepository,
  BoundaryInvocationRepository,
  computeRequestFingerprint,
  venueAccounts,
} from '@traderton/db';
import {
  createTradingRuntime,
  loadConfig,
  createScannerCandleFetcherFromConfig,
  createScannerPoolResolverFromConfig,
  type TradingRuntime,
  type AgentActorSpec,
  createLogger,
} from '@traderton/worker';
import {
  createProviderRegistry,
  createPriceService,
  CompositeEconomicCalendarProvider,
  RedisProviderResponseCache,
  TokenBucketRateLimiter,
  createScrapflyFetch,
  createFallbackCalendarParser,
  type ForexFactoryAdapterConfig,
  type CompositeEconomicCalendarConfig,
} from '@traderton/market-data';
import type { RedisEvalClient } from '@traderton/market-data';
import { createBoundaryApp } from './app.js';
import { BoundaryConfigSchema, type BoundaryConfig } from './config.js';
import type {
  ContextFactoryRequest,
  TradingToolContextFactory,
  BoundaryInvocationStore,
} from './dispatcher.js';
import { buildToolRegistry } from './registry.js';
import {
  resolveSubjectInjection,
  type SubjectResolverPorts,
  type ResolverBotRecord,
  type ResolverVenueAccountRecord,
} from './subject-resolver.js';

const logger = createLogger('boundary-bin');
/**
 * The consumer-injected agent risk context (submit_decision payload only). The
 * fields are declared in the tool's Zod schema so they survive the dispatcher's
 * `payloadParse` (bug-001 lesson) and extracted by the subject resolver.
 */
interface AgentRiskSpec {
  capital?: string;
  riskPosture?: Record<string, unknown>;
  riskOverrides?: Record<string, number | undefined>;
}

/**
 * Build the lazy agent-direct actor ensure for the boundary (M2 GAP FIX —
 * item-C `constructAndRegisterAgentActor` had NO production caller: the M1
 * consumer (herobids' in-process AgentSessionManager) was deleted by herobids
 * L3d-5, and the M2 boundary never registered an agent actor, so EVERY
 * `submit_decision` for an agent subject failed `instance_not_running`
 * ("No execution context — ensure the actor is active and running").
 *
 * The boundary is now the lifecycle driver item D deferred to the consumer:
 * on the first `submit_decision` for a `(ownerId, actorId, venueAccountId)`
 * tuple it constructs + registers + STARTS the `AgentTradingActor` (start is
 * required — the second intake guard at decision-intake.ts:121 is only
 * reachable after a successful start). Cached per tuple.
 *
 * Cache policy for consumer-injected risk values:
 *  - `capital`/`riskPosture` CHANGED → stop + deregister the old actor and
 *    RECONSTRUCT fresh: these anchor the `EquityTracker` peak (construct-time
 *    state, agent-trading-actor.ts:2953) — carrying a changed capital into a
 *    live actor would silently skew peak equity/drawdown. The DailyLossTracker
 *    rehydrates from traderton's own fills, so rolling-24h loss history
 *    survives the swap. This matches M1 semantics (a capital change ≈ a new
 *    session constructing a fresh tracker).
 *  - Only `riskOverrides` CHANGED → hot-swap via `updateRiskLimits` (M1
 *    parity: herobids' adjust path hot-swapped limits to preserve per-trade
 *    exit levels / stop-loss timers, agent-trading-actor.ts:1010).
 *  - Never key the cache on the VALUES — one actor per capital edit would fork
 *    actors and never converge.
 *
 * INJECTED values only (ports-carry-values, 000/004): the venue coordinates +
 * owner mode come from the D2 injection; capital/riskPosture/riskOverrides come
 * from the consumer's submit_decision payload (the boundary process cannot read
 * the consumer's `agents` table — locked: no `agents`-table dependency, 017 §4 /
 * 019 §1). Absent values → operator defaults (graceful; backward compatible).
 * `paper`/`shadow` start without credentials; `shadow`/`live` can throw
 * `CredentialResolutionError` from the venue adapter factory — surfaced to the
 * dispatcher's catch, which (as of bug 001) logs internally and returns
 * `precondition.not_ready`.
 */
function buildAgentDirectActorEnsure(
  runtime: TradingRuntime,
): (injection: {
  ownerId: string;
  actorId: string;
  ownerMode: 'paper' | 'shadow' | 'live';
  venue: string;
  venueType: 'orderbook' | 'swap';
  venueAccountId: string;
  agentRiskSpec?: AgentRiskSpec;
}) => Promise<void> {
  interface CacheEntry {
    ensure: Promise<void>;
    capital: string | undefined;
    riskPostureKey: string;
    riskOverridesKey: string;
  }

  // Keyed by ownerId+actorId+venueAccountId: a re-point of the SAME agent to a
  // DIFFERENT venue account must construct a fresh actor (the venueAccountId is
  // injected into the actor's adapter, not looked up at call time).
  const ensureCache = new Map<string, CacheEntry>();

  const postureKey = (posture: Record<string, unknown> | undefined): string =>
    JSON.stringify(posture ?? null);
  const overridesKey = (overrides: Record<string, number | undefined> | undefined): string =>
    JSON.stringify(overrides ?? null);

  return async (injection) => {
    const key = `${injection.ownerId}::${injection.actorId}::${injection.venueAccountId}`;
    const risk = injection.agentRiskSpec ?? {};
    const existing = ensureCache.get(key);

    if (existing) {
      await existing.ensure;
      const capitalChanged = (risk.capital ?? undefined) !== existing.capital;
      const postureChanged = postureKey(risk.riskPosture) !== existing.riskPostureKey;
      const overridesChanged = overridesKey(risk.riskOverrides) !== existing.riskOverridesKey;
      if (!capitalChanged && !postureChanged && !overridesChanged) {
        return; // fast path — same spec, actor already ensured
      }
      // Something changed: the existing actor is stopped + replaced below
      // (reconstruct for capital/posture; reconstruct too when overrides change
      // alongside them — a single rebuild keeps the ordering simple and the
      // reconstruct path already re-applies the full spec).
      logger.info(
        { ownerId: injection.ownerId, agentId: injection.actorId, capitalChanged, postureChanged, overridesChanged },
        'agent risk spec changed — reconstructing agent-direct actor',
      );
      ensureCache.delete(key);
    }

    const ensure = (async () => {
      // Stop + deregister the PREVIOUS actor FIRST: register uses the same
      // actorId key, so deregistering after registering the new actor would
      // evict the wrong entry. The registry stores `ExecutionActor` (no stop()
      // on the interface) — narrow to the AgentTradingActor surface the runtime
      // itself returns from constructAndRegisterAgentActor; only agent actors
      // are ever keyed by an agent-subject actorId, so the cast is sound.
      const previous = runtime.actorRegistry.get(injection.actorId);
      if (previous && previous.isRunning) {
        const agentActor = previous as unknown as Parameters<
          typeof runtime.stopAndDeregisterAgentActor
        >[0];
        await runtime.stopAndDeregisterAgentActor(agentActor).catch(() => { /* best-effort teardown */ });
      }

      const spec: AgentActorSpec = {
        agentId: injection.actorId,
        executionMode: injection.ownerMode,
        venueAccountId: injection.venueAccountId,
        venue: injection.venue,
        venueType: injection.venueType,
        capital: risk.capital ?? null,
        riskPosture: (risk.riskPosture ?? null) as AgentActorSpec['riskPosture'],
        riskOverrides: (risk.riskOverrides ?? {}) as AgentActorSpec['riskOverrides'],
      };
      const actor = runtime.constructAndRegisterAgentActor(spec);
      try {
        await actor.start();
        logger.info(
          { ownerId: injection.ownerId, agentId: injection.actorId, venueAccountId: injection.venueAccountId, mode: injection.ownerMode, capital: risk.capital ?? null },
          'agent-direct actor constructed + started',
        );
      } catch (err) {
        // Failed start: deregister so a later attempt constructs fresh rather
        // than reusing a half-started actor, then rethrow.
        await runtime.stopAndDeregisterAgentActor(actor).catch(() => { /* best-effort teardown */ });
        throw err;
      }
    })();

    // Stash the IN-FLIGHT promise (with the spec it was built from) so
    // concurrent invocations await the same construction.
    ensureCache.set(key, {
      ensure,
      capital: risk.capital ?? undefined,
      riskPostureKey: postureKey(risk.riskPosture),
      riskOverridesKey: overridesKey(risk.riskOverrides),
    });

    try {
      await ensure;
    } catch (err) {
      // Do NOT cache failures — evict so the next invocation retries
      // construction (e.g. after the operator provisions the credential).
      ensureCache.delete(key);
      throw err;
    }
  };
}

function loadBoundaryConfig(): BoundaryConfig {
  const consumerId = process.env['BOUNDARY_CONSUMER_ID'];
  const keyId = process.env['BOUNDARY_KEY_ID'];
  const secret = process.env['BOUNDARY_SIGNING_SECRET'];
  const clockSkewMs = process.env['BOUNDARY_CLOCK_SKEW_MS'];
  const retentionHours = process.env['BOUNDARY_IDEMPOTENCY_RETENTION_HOURS'];

  const allowedConsumers =
    consumerId && keyId && secret ? { [consumerId]: { keyId, secret } } : {};

  return BoundaryConfigSchema.parse({
    ...(clockSkewMs ? { clockSkewMs: Number(clockSkewMs) } : {}),
    ...(retentionHours ? { idempotencyRetentionHours: Number(retentionHours) } : {}),
    allowedConsumers,
  });
}

async function main(): Promise<void> {
  const boundaryConfig = loadBoundaryConfig();
  const registry = buildToolRegistry();

  // ── Real trading runtime (needs live Postgres + Redis + AppConfig) ──
  const appConfig = loadConfig();
  const redis = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  const db = createDatabase(appConfig.database.url);
  const botRepo = new BotRepository(db);
  const instrumentRepo = new InstrumentRepository(db);
  const runtime = createTradingRuntime({
    config: appConfig,
    redis,
    // No bots rehydrate at boundary start — bot lifecycle is driven by tool
    // calls, not a boot-time reload. The runtime still starts its lifecycle-job
    // consumer + reclaim loop.
    instanceLoader: async () => [],
  });
  await runtime.start();

  // The lazy agent-direct actor ensure (M2 GAP FIX — see the docstring on
  // `buildAgentDirectActorEnsure`): constructed once per process, closed over
  // the runtime, and invoked per venue-resolving agent invocation in the
  // context factory below.
  const ensureAgentDirectActor = buildAgentDirectActorEnsure(runtime);

  // ── Venue-aware candle fetcher for read-only scoring tools (score_candidate).
  //    Candles are fetched BEHIND the boundary (legal-isolation: the consumer
  //    must not fetch trading candle data). Undefined when marketData is absent
  //    from config — the tool then degrades to `market_data_not_configured`.
  const scannerCandleFetcher = appConfig.marketData
    ? createScannerCandleFetcherFromConfig(appConfig.marketData)
    : undefined;

  // ── Swap token→pools resolver for score_candidate's swap arm. Threaded the
  //    SAME way (and from the same GeckoTerminal config) as scannerCandleFetcher:
  //    the consumer passes a held token (network + tokenAddress) and the boundary
  //    resolves the pool, then scores its candles. Undefined-when-absent mirrors
  //    the fetcher's `market_data_not_configured` degrade.
  const scannerPoolResolver = appConfig.marketData
    ? createScannerPoolResolverFromConfig(appConfig.marketData)
    : undefined;

  // ── Market-data provider registry for the market-intelligence read tools
  //    (check_regime / get_market_overview / discover_tokens / search_tokens /
  //    get_funding_rates). Those tools fetch BEHIND the boundary (legal-isolation:
  //    the consumer must not fetch trading market data directly) and guard on
  //    `ctx.marketDataRegistry` — returning `market_data_not_configured` when it is
  //    absent. Built ONCE per process (mirrors the in-process runtime's
  //    `start()` in create-trading-runtime.ts). Undefined when marketData is absent
  //    from config — the tools then keep their `market_data_not_configured` degrade.
  const marketDataRegistry = appConfig.marketData
    ? await createProviderRegistry(appConfig.marketData, {
        redisClient: redis as unknown as RedisEvalClient,
        discoverySeenClient: redis,
      })
    : undefined;

  // `marketDataConfig` enables the shared token-safety policy in the search tools
  // (the tools cast it to MarketDataConfig internally). Mirrors the registry's
  // undefined-when-absent degrade.
  const marketDataConfig = appConfig.marketData;

  // Price service for discover_tokens' OPTIONAL price enrichment. Built from the
  // registry via the existing `createPriceService` factory (@traderton/market-data)
  // — no authoring. Undefined when the registry is absent; discover_tokens degrades
  // gracefully without it (enrichment is skipped, not an error).
  const priceService = marketDataRegistry
    ? createPriceService(marketDataRegistry)
    : undefined;

  // ── Economic-calendar acquisition loop (relocated from the herobids worker) ──
  //    Runs ENTIRELY Traderton-side: this composition root builds the provider,
  //    warms the shared Redis cache on startup, and refreshes it periodically.
  //    The `get_economic_calendar` read tool reads that cache exclusively
  //    (cacheOnly), so agent ticks never block on a network call.
  //
  //    The Scrapfly key stays an env var by design (never a schema field).
  //    The fallback calendar parser's LLM config is likewise sourced from env
  //    (LLM_BASE_URL / LLM_MODEL / LLM_API_KEY / LLM_TIMEOUT_MS) — the
  //    trading-only Traderton AppConfigSchema deliberately drops the platform
  //    `appConfig.llm` block (see packages/worker/src/config.ts), so we mirror
  //    the Scrapfly env-var seam rather than reintroduce a platform config key.
  //    The parser is DOM-first; the LLM only activates if Forex Factory changes
  //    its markup, so these env vars are optional in the common case.
  const ecConfig = appConfig.marketData?.economicCalendar;
  const scrapflyApiKey = process.env['SCRAPFLY_API_KEY'];
  let economicCalendarProvider: CompositeEconomicCalendarProvider | undefined;

  if (ecConfig?.enabled && scrapflyApiKey && appConfig.marketData) {
    const scrapfly = appConfig.marketData.scrapfly;
    economicCalendarProvider = new CompositeEconomicCalendarProvider({
      daysForward: ecConfig.daysForward,
      minImpact: ecConfig.minImpact,
      currencies: ecConfig.currencies,
      maxEvents: ecConfig.maxEventsInContext,
      forexFactory: {
        baseUrl: ecConfig.forexFactory.baseUrl,
        requestTimeoutMs: ecConfig.forexFactory.requestTimeoutMs,
        requestsPerMinute: ecConfig.forexFactory.requestsPerMinute,
        userAgent: ecConfig.forexFactory.userAgent,
        rateLimiter: new TokenBucketRateLimiter({
          requestsPerMinute: ecConfig.forexFactory.requestsPerMinute,
        }),
        fetchFn: createScrapflyFetch({
          apiKey: scrapflyApiKey,
          baseUrl: scrapfly.baseUrl,
          asp: scrapfly.asp,
          requestTimeoutMs: scrapfly.requestTimeoutMs,
        }),
        parseHtmlFn: createFallbackCalendarParser({
          baseUrl: process.env['LLM_BASE_URL'],
          model: process.env['LLM_MODEL'] ?? 'anthropic/claude-sonnet-4-5',
          timeoutMs: Number(process.env['LLM_TIMEOUT_MS'] ?? 60_000),
          ...(process.env['LLM_API_KEY'] ? { apiKey: process.env['LLM_API_KEY'] } : {}),
        }),
      } satisfies ForexFactoryAdapterConfig,
      cache: new RedisProviderResponseCache(redis, 'market-data:cache:'),
      cacheTtlMs: ecConfig.cacheTtlMs,
    } satisfies CompositeEconomicCalendarConfig);

    // Initial fetch on startup — warm the cache before any agent reads it (full
    // fetch, NOT cacheOnly).
    economicCalendarProvider.getUpcomingEvents().then((result) => {
      if (result.ok) {
        // eslint-disable-next-line no-console
        console.info(`economic calendar initial cache warmed (${result.data.events.length} events)`);
      } else {
        // eslint-disable-next-line no-console
        console.warn('economic calendar initial fetch failed', result.error);
      }
    }).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('economic calendar initial fetch threw', err);
    });

    // Periodic refresh. The interval lives for process life (no shutdown path in
    // this composition root — same as the source worker).
    setInterval(() => {
      economicCalendarProvider?.getUpcomingEvents().then((result) => {
        if (result.ok) {
          // eslint-disable-next-line no-console
          console.info(`economic calendar cache refreshed (${result.data.events.length} events)`);
        } else {
          // eslint-disable-next-line no-console
          console.warn('economic calendar refresh failed', result.error);
        }
      }).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('economic calendar refresh threw', err);
      });
    }, ecConfig.refreshIntervalMs);
  } else if (ecConfig?.enabled && !scrapflyApiKey) {
    // eslint-disable-next-line no-console
    console.warn('economic calendar enabled but SCRAPFLY_API_KEY not set — background refresh disabled');
  }

  // ── The idempotency store (F2a repo) injected via the thin dispatcher port ──
  const invocationStore: BoundaryInvocationStore = new BoundaryInvocationRepository(db);
  const retentionMs = boundaryConfig.idempotencyRetentionHours * 60 * 60 * 1000;

  // ── The D2 subject→injection resolver ports (db-row VALUE lookups) ──
  const resolverPorts: SubjectResolverPorts = {
    getBotById: async (botId): Promise<ResolverBotRecord | null> => {
      const bot = await botRepo.getBotById(botId);
      if (!bot) return null;
      return { ownerId: bot.ownerId, venueAccountId: bot.venueAccountId, config: bot.config };
    },
    listVenueAccountsByOwner: async (ownerId): Promise<ResolverVenueAccountRecord[]> => {
      const rows = await db
        .select({ id: venueAccounts.id, venue: venueAccounts.venue })
        .from(venueAccounts)
        .where(and(eq(venueAccounts.ownerId, ownerId)));
      return rows.map((r) => ({ id: r.id, venue: r.venue }));
    },
  };

  // ── The real TradingToolContext factory (composition root, NOT the dispatcher) ──
  const contextFactory: TradingToolContextFactory = async (
    request: ContextFactoryRequest,
  ): Promise<TradingToolContext> => {
    const tool = registry.get(request.toolName);
    const category = (tool?.category ?? 'read-config') as ToolCategory;

    // A tool needs no venue resolution when it is read-only (drive target never
    // invoked) OR it declares `ownerScopedNoVenue` (owner-scoped write that drives
    // no executor — provisioning, adjust_risk_limits, the watch tools). Computed
    // here so the resolver stays port-only + registry-free.
    const skipVenueResolution = isReadOnlyCategory(category) || tool?.ownerScopedNoVenue === true;

    const resolution = await resolveSubjectInjection(
      { ownerId: request.ownerId, actor: request.actor },
      skipVenueResolution,
      request.payload,
      resolverPorts,
    );
    if (!resolution.ok) {
      // The dispatcher maps a thrown factory to precondition.not_ready; an
      // authorization mismatch is surfaced by throwing so the boundary refuses.
      throw new Error(`subject resolution failed: ${resolution.code}: ${resolution.message}`);
    }

    const injection = resolution.injection;
    // Lazy agent-direct actor ensure (M2 GAP FIX): for a venue-resolving
    // invocation whose actor is not yet running in THIS process, construct +
    // register + start the AgentTradingActor BEFORE handing the drive target to
    // the tool — otherwise `submitDecision` finds no actor and rejects
    // `instance_not_running` (decision-intake.ts:104-111). Drive-path tools
    // (`submit_decision`, the bot lifecycle tools) are exactly the tools whose
    // venue resolution was NOT skipped. Failures throw → the dispatcher logs
    // internally and returns `precondition.not_ready` (retryable).
    //
    // NOTE (parity caveat, L3-Rx): `injection.ownerMode` for agent subjects
    // currently falls back to 'paper' (no getDefaultOwnerMode port wired), so
    // agent-direct actors start in paper mode today. See
    // docs/features/L3-Rx-subject-resolver-venue-signal-plan.md.
    if (!skipVenueResolution && request.actor.type === 'agent') {
      await ensureAgentDirectActor(injection);
    }
    const publishToInbound = runtime.createDriveTarget(injection);

    return {
      agentId: request.actor.id,
      sessionId: `boundary:${request.ownerId}`,
      // The signed owner id — owner-scoped write tools (provision_venue_account)
      // write it to the soft `ownerId` columns (L3-P1).
      ownerId: request.ownerId,
      executionMode: injection.ownerMode,
      // The boundary executes what it is given — human approvals are the
      // consumer's PRE-boundary job (CANONICAL-STATE D3/§3.2 P2): Traderton owns
      // no approval machinery, so `authorizationMode` is 'direct'. A consumer
      // that needs approval holds `pending_approval` upstream and only calls the
      // boundary for an already-approved decision; `pending_approval` never
      // crosses the wire (the boundary result is success|failure only).
      authorizationMode: 'direct',
      redis: redis as unknown as TradingToolContext['redis'],
      publishToInbound,
      botRepo: botRepo as unknown as TradingToolContext['botRepo'],
      // Enables find_instrument + watch_token instrument-identity resolution over the boundary.
      instrumentRepo: instrumentRepo as unknown as TradingToolContext['instrumentRepo'],
      // Venue-aware candle fetcher for read-only scoring tools (score_candidate).
      scannerCandleFetcher,
      // Swap token→pools resolver for score_candidate's swap-token arm.
      scannerPoolResolver,
      // Market-intelligence read tools fetch behind the boundary via the shared
      // provider registry (check_regime / get_market_overview / discover_tokens /
      // search_tokens / get_funding_rates). Undefined-when-absent preserves the
      // `market_data_not_configured` degrade.
      marketDataRegistry: marketDataRegistry as unknown as TradingToolContext['marketDataRegistry'],
      marketDataConfig: marketDataConfig as unknown as TradingToolContext['marketDataConfig'],
      priceService: priceService as unknown as TradingToolContext['priceService'],
      // Economic-calendar read provider for get_economic_calendar. The SAME
      // single instance is threaded into every invocation — it is a cache reader
      // (cacheOnly on the tick path); the background loop above owns the fetch.
      // Undefined-when-disabled preserves the `economic_calendar_not_configured`
      // degrade.
      economicCalendarProvider: economicCalendarProvider as unknown as TradingToolContext['economicCalendarProvider'],
      // Raw Drizzle handle for tools that write tables directly (provisioning).
      db,
    };
  };

  const app = createBoundaryApp({
    config: boundaryConfig,
    registry,
    contextFactory,
    invocationStore,
    computeRequestFingerprint,
    retentionMs,
  });

  const port = Number(process.env['BOUNDARY_PORT'] ?? 8080);
  const host = process.env['BOUNDARY_HOST'] ?? '0.0.0.0';
  await app.listen({ port, host });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('boundary failed to start', err);
  process.exitCode = 1;
});
