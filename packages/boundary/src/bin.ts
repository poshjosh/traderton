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
import type { TradingToolContext, ToolCategory } from '@traderton/domain';
import { isReadOnlyCategory } from '@traderton/domain';
import {
  createDatabase,
  BotRepository,
  AgentTradingProfileRepository,
  InstrumentRepository,
  BoundaryInvocationRepository,
  ConsumerNotificationRepository,
  AgentScanRepository,
  AgentActorRunRepository,
  JournalPartitionMaintenance,
  computeRequestFingerprint,
} from '@traderton/db';
import {
  loadConfig,
  createScannerCandleFetcherFromConfig,
  createScannerPoolResolverFromConfig,
  buildRiskContractOpsFromRiskSource,
  createLogger,
  InstanceLease,
  type RiskSource,
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
import { resolveMcpSurfaceConfig } from './mcp/surface-config.js';
import type {
  ContextFactoryRequest,
  TradingToolContextFactory,
  BoundaryInvocationStore,
} from './dispatcher.js';
import { buildToolRegistry } from './registry.js';
import {
  resolveSubjectInjection,
} from './subject-resolver.js';
import { buildResolverPorts } from './resolver-ports.js';
import { buildAgentDirectActorEnsure } from './agent-direct-actor-ensure.js';
import type { AgentDirectActorResult } from './agent-direct-actor-ensure.js';
import { subscribeBotStopSignals } from './bot-stop-subscriber.js';
import {
  wrapPublishToInbound,
  startAgentCommandConsumer,
  subscribeAgentActorStopSignals,
  type AgentCommandSenderRedis,
  type AgentCommandConsumerRedis,
} from './agent-command-router.js';
import { buildBoundaryTradingRuntime } from './build-boundary-runtime.js';
import { registerBoundaryShutdown } from './boundary-shutdown.js';
import { startConsumerNotificationPruneLoop } from './consumer-notification-prune.js';
import { startAgentScanPruneLoop } from './agent-scan-prune.js';
import { buildAgentActorLifecycleOps } from './agent-actor-lifecycle-ops.js';
import { rehydrateAgentActors } from './agent-actor-rehydrate.js';
import { startAgentOrphanSweep } from './agent-orphan-sweep.js';
import { startJournalMaintenanceLoop } from './journal-maintenance.js';

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
  // Source every Redis connection from the SAME resolved operator config value
  // (`appConfig.redis.url`, which already folds in the REDIS_URL env override via
  // loadConfig) so the boundary's shared/subscriber connections and the BullMQ
  // lifecycle connection (createTradingRuntime, which reads config.redis.url)
  // can never point at different servers (bug 2026-10-05/001 follow-up).
  const redisUrl = appConfig.redis.url;
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
  });
  const db = createDatabase(appConfig.database.url);
  const botRepo = new BotRepository(db);
  const profileRepo = new AgentTradingProfileRepository(db);
  const instrumentRepo = new InstrumentRepository(db);
  // Running bots rehydrate at boundary start via the shared running-bot loader
  // (E2 F2) — see `buildBoundaryTradingRuntime` for the wiring + resume rationale.
  const runtime = buildBoundaryTradingRuntime({ config: appConfig, redis, db });
  await runtime.start();

  // Wave E / E3-T T5: prune the consumer-notification outbox so it stays bounded.
  // Self-rescheduling loop (reschedules on failure per AGENTS); operator config
  // drives the retention window / interval / batch size. The relay (E3-H) and
  // other MCP consumers must poll within `notifications.retentionDays`.
  const consumerNotificationPrune = startConsumerNotificationPruneLoop({
    repo: new ConsumerNotificationRepository(db),
    retentionDays: appConfig.notifications.retentionDays,
    pruneIntervalMs: appConfig.notifications.pruneIntervalMs,
    pruneBatchSize: appConfig.notifications.pruneBatchSize,
    logger: createLogger('boundary-notification-prune'),
  });

  // Wave E / E1-T T3: prune the scan-persistence tables (agent_scan_candidates +
  // agent_scan_metrics) so they stay bounded. herobids never pruned these (it
  // reads by a scannedAt window); operator config drives the retention window /
  // interval / batch size. Self-rescheduling, reschedules on failure (AGENTS).
  const agentScanPrune = startAgentScanPruneLoop({
    repo: new AgentScanRepository(db),
    retentionDays: appConfig.agentScanner.scanRetention.retentionDays,
    pruneIntervalMs: appConfig.agentScanner.scanRetention.pruneIntervalMs,
    pruneBatchSize: appConfig.agentScanner.scanRetention.pruneBatchSize,
    logger: createLogger('boundary-agent-scan-prune'),
  });

  // Plan 003 S4: the journal_events partition-maintenance loop. Single-flight
  // across replicas via a DEDICATED InstanceLease (its OWN worker id + renew-timer
  // map, NOT the runtime's agent/bot lease handle — S1 forbids reuse). The loop
  // acquires `journal-maintenance` at tick start and releases it in a finally.
  // Self-rescheduling, reschedules on failure (AGENTS). Default retention is null
  // (keep everything): it only provisions future partitions until an operator
  // sets a bound. The lease id maps to Redis key `lease:instance:journal-maintenance`.
  const journalMaintenanceLease = new InstanceLease(redis, `journal-maint-${runtime.workerId}`, 30);
  const journalMaintenance = startJournalMaintenanceLoop({
    maintenance: JournalPartitionMaintenance.fromDatabase(db),
    lease: {
      tryAcquire: () => journalMaintenanceLease.acquire('journal-maintenance'),
      release: async () => {
        await journalMaintenanceLease.release('journal-maintenance');
      },
    },
    retention: appConfig.journal.retention,
    logger: createLogger('boundary-journal-maintenance'),
  });

  // E0 hotfix: the copied `stop_bot` tool publishes `bot:stop:{botId}`; stop the
  // in-process actor when it does. Dedicated connection — a Redis connection in
  // subscriber mode cannot issue other commands.
  const botStopSubscriber = new Redis(redisUrl);
  subscribeBotStopSignals(
    botStopSubscriber,
    (botId) => runtime.runtime.stopInstanceDirect(botId),
    createLogger('boundary-bot-stop'),
  );

  // The lazy agent-direct actor ensure (M2 GAP FIX — see the docstring on
  // `buildAgentDirectActorEnsure` in ./agent-direct-actor-ensure.ts, which now
  // hosts the implementation + its A1/A2 stability fixes): constructed once
  // per process, closed over the runtime, and invoked per venue-resolving
  // agent invocation in the context factory below.
  const ensureAgentDirectActor = buildAgentDirectActorEnsure(
    runtime,
    (ownerId, actorId, venueAccountId) => profileRepo.getByOwnerActorVenueAccount(ownerId, actorId, venueAccountId),
  );

  // Wave E / E1-T T5: the durable agent-actor run-state repo + the lifecycle ops
  // (stop/cascade/ensure/record) shared by the consumer-only start/stop tools, the
  // boot rehydrate, and the orphan sweep. Built ONCE over the runtime + ensure +
  // repos; the tools consume it per-request via the ctx `agentActorLifecycle` port.
  const agentActorRunRepo = new AgentActorRunRepository(db);
  const agentActorLifecycleOps = buildAgentActorLifecycleOps({
    runtime,
    ensure: ensureAgentDirectActor,
    runRepo: agentActorRunRepo,
    botRepo: botRepo as unknown as Parameters<typeof buildAgentActorLifecycleOps>[0]['botRepo'],
    stopInstanceDirect: (botId) => runtime.runtime.stopInstanceDirect(botId),
    logger: createLogger('boundary-agent-lifecycle'),
  });

  // Wave E / E1-T T5: rehydrate running agent actors on boot. `runtime.start()`
  // (above) rehydrates running BOTS; this rehydrates running AGENTS from the
  // durable `agent_actor_runs` table through the SAME ensure the lazy path uses.
  // Per-agent failures are logged and left for the orphan sweep — boot never
  // crashes on one agent. Awaited so a running agent is live before serving.
  await rehydrateAgentActors({
    listRunning: () => agentActorRunRepo.listRunning(),
    ensureAgent: (run) => agentActorLifecycleOps.ensureFromRun(run),
    logger: createLogger('boundary-agent-rehydrate'),
  });

  // Wave E / E1-T T5: the periodic agent-actor orphan sweep. Self-rescheduling
  // (reschedules on failure per AGENTS); operator config drives the cadence. It
  // stops running bots whose creator agent is no longer running and re-ensures
  // running agents whose actor died — both through the single ensure entry point
  // (so E4 can make them lease-aware).
  const agentOrphanSweep = startAgentOrphanSweep({
    ports: {
      listRunningAgentRuns: () => agentActorRunRepo.listRunning(),
      listRunningAgentBots: () => botRepo.listRunningAgentBots(),
      isActorAlive: (actorId) => agentActorLifecycleOps.isActorAlive(actorId),
      // 001 S4: return the ownership outcome so the sweep logs local-vs-remote
      // honestly. A `remote` outcome is a no-op success (the actor runs on another
      // replica); the lease acquire inside the ensure is what guarantees exactly
      // one live actor across replicas.
      reEnsureAgent: (run) => agentActorLifecycleOps.ensureFromRun(run),
      stopBot: async (botId) => {
        await botRepo.markBotStopped(botId);
        await runtime.runtime.stopInstanceDirect(botId);
      },
    },
    sweepIntervalMs: appConfig.agentScanner.orphanSweepIntervalMs,
    logger: createLogger('boundary-agent-orphan-sweep'),
  });

  // 001 S3: the agent-actor command consumer. One blocking-pop loop per container
  // on its OWN command list (`agent-actor:cmd:{workerId}`), with a DEDICATED Redis
  // connection — BLPOP blocks the connection, so it cannot be the shared client.
  // A decision forwarded here by a remote sender runs on the LOCAL drive target
  // (rebuilt from the envelope's injection) after re-checking we still hold the
  // agent lease; the owner writes the reply the sender's tool BLPOPs.
  const agentCommandConsumerConn = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
  });
  const agentCommandConsumer = startAgentCommandConsumer({
    redis: agentCommandConsumerConn as unknown as AgentCommandConsumerRedis,
    workerId: runtime.workerId,
    lease: runtime.agentLease,
    createDriveTarget: (injection) => runtime.createDriveTarget(injection),
    logger: createLogger('boundary-agent-command-consumer'),
  });

  // 001 S3: the agent-actor stop-signal subscriber. The `stop_agent_actor` tool on
  // a NON-owner marks the run stopped + cascades, then publishes
  // `agent-actor:stop:{agentId}`; the OWNER stops its in-process actor on that
  // signal (same shape as `bot:stop:*`). Dedicated connection — subscriber mode
  // cannot issue other commands. The stop is a no-op on a non-owner (the registry
  // stop is keyed on the actor id, and evict releases only a lease we hold).
  const agentActorStopSubscriber = new Redis(redisUrl);
  subscribeAgentActorStopSignals(
    agentActorStopSubscriber,
    async (agentId) => {
      // The signal carries only the agent id; recover the ownerId from the durable
      // run row so the ensure cache can be evicted under its `${ownerId}::${actorId}`
      // key. No row ⇒ nothing this process owns to stop (no-op).
      const run = await agentActorRunRepo.getByActorId(agentId);
      if (!run) return;
      await agentActorLifecycleOps.stopAndEvictActor(run.ownerId, agentId);
    },
    createLogger('boundary-agent-actor-stop'),
  );

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
          model: process.env['LLM_MODEL'] ?? 'anthropic/claude-sonnet-latest',
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
  // A4: the default ports (getDefaultOwnerMode / getDefaultVenueAccountId) are
  // wired too — see buildResolverPorts (extracted + unit-tested in
  // ./resolver-ports.ts). Owner mode = the operator knob
  // `execution.defaultOwnerMode`; venue default = the owner's oldest account.
  const resolverPorts = buildResolverPorts({ db, appConfig, getBotById: (id) => botRepo.getBotById(id) });

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

    // C1: the profile is Traderton-owned enforcement state. The verified owner,
    // signed actor, and verified venue-account coordinate form its exact key.
    const profile = request.actor.type === 'agent' && injection.venueAccountId
      ? await profileRepo.getByOwnerActorVenueAccount(request.ownerId, request.actor.id, injection.venueAccountId)
      : null;
    const riskSource: RiskSource | undefined = profile
      ? {
          capital: profile.capital,
          riskPosture: profile.riskPosture,
          riskOverrides: profile.riskOverrides,
        }
      : undefined;
    const riskContractOps = riskSource
      ? buildRiskContractOpsFromRiskSource({
          agentRiskDefaults: appConfig.agentRiskDefaults,
          source: riskSource,
          setRiskOverrides: async (riskOverrides) => {
            const updated = await profileRepo.replaceRiskOverrides({
              ownerId: request.ownerId,
              actorId: request.actor.id,
              venueAccountId: injection.venueAccountId,
              riskOverrides,
            });
            if (!updated) throw new Error('trading profile disappeared while updating risk overrides');
          },
        })
      : undefined;

    // Lazy agent-direct actor ensure (M2 GAP FIX): for a venue-resolving
    // invocation whose actor is not yet running in THIS process, construct +
    // register + start the AgentTradingActor BEFORE handing the drive target to
    // the tool — otherwise `submitDecision` finds no actor and rejects
    // `instance_not_running` (decision-intake.ts:104-111). Drive-path tools
    // (`submit_decision`, the bot lifecycle tools) are exactly the tools whose
    // venue resolution was NOT skipped. Failures throw → the dispatcher logs
    // internally and returns `precondition.not_ready` (retryable).
    //
    // A4: `injection.ownerMode` for agent subjects now comes from the wired
    // operator default (`execution.defaultOwnerMode`, static — no per-agent
    // source exists). B1's trading profile becomes the per-agent source later,
    // with this static default as the fallback.
    const profileInjection = profile?.executionDefaults?.mode
      ? { ...injection, ownerMode: profile.executionDefaults.mode }
      : injection;
    // 001 S3: capture the ensure's ownership result. `local` ⇒ this worker owns
    // the actor and runs the decision in-process; `remote` ⇒ another worker owns
    // it, so a DECISION_SUBMIT must be forwarded to that owner's command list
    // instead of executing locally. Non-agent / venue-skipped calls stay local.
    const ensureResult: AgentDirectActorResult =
      !skipVenueResolution && request.actor.type === 'agent'
        ? await ensureAgentDirectActor(profileInjection)
        : { owner: 'local' };
    const localPublishToInbound = runtime.createDriveTarget(profileInjection);
    // Wrap the local drive target with the owner-routing sender: a decision for a
    // remotely-owned agent RPUSHes to `agent-actor:cmd:{workerId}` and the owner
    // writes the reply the tool BLPOPs; everything else runs locally.
    const publishToInbound = wrapPublishToInbound({
      local: localPublishToInbound,
      ensureResult,
      injection: profileInjection,
      redis: redis as unknown as AgentCommandSenderRedis,
      logger: createLogger('boundary-agent-command-router'),
    });

    // Risk reads are profile-only. A missing profile is a readiness failure;
    // operator defaults must never become a payload-free fallback authority.
    if (request.toolName === 'get_risk_limits' && !riskContractOps) {
      throw new Error('risk context unavailable: the selected trading profile is missing');
    }

    return {
      agentId: request.actor.id,
      sessionId: `boundary:${request.ownerId}`,
      // The signed owner id — owner-scoped write tools (provision_venue_account)
      // write it to the soft `ownerId` columns (L3-P1).
      ownerId: request.ownerId,
      executionMode: profile?.executionDefaults?.mode ?? injection.ownerMode,
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
      // Operator 1inch chain mapping for marking 1inch positions in
      // get_agent_positions (includeMarks). There is no per-position binding on
      // the read path, so the operator `venues.1inch` chainId/tokenSafetyNetwork
      // is the resolution source. Undefined → 1inch rows are left unmarked.
      oneInchPriceChainConfig: appConfig.venues?.['1inch']
        ? {
            tokenSafetyNetwork: appConfig.venues['1inch'].tokenSafetyNetwork,
            chainId: appConfig.venues['1inch'].chainId,
          }
        : undefined,
      // Economic-calendar read provider for get_economic_calendar. The SAME
      // single instance is threaded into every invocation — it is a cache reader
      // (cacheOnly on the tick path); the background loop above owns the fetch.
      // Undefined-when-disabled preserves the `economic_calendar_not_configured`
      // degrade.
      economicCalendarProvider: economicCalendarProvider as unknown as TradingToolContext['economicCalendarProvider'],
      // Raw Drizzle handle for tools that write tables directly (provisioning).
      db,
      // Profile-backed risk and account context. No decision payload field is an
      // enforcement input after C1.
      riskContractOps,
      agentRepo: riskSource ? {
        getAgent: async (_agentId: string) => ({
          capital: riskSource.capital,
          risk: riskSource.riskPosture,
        }),
      } satisfies Pick<NonNullable<TradingToolContext['agentRepo']>, 'getAgent'> : undefined,
      executionConfig: {
        getExecutionConfig: async () => ({
          mode: profile?.executionDefaults?.mode ?? null,
          positionSizeMode: null,
          fixedPositionSize: null,
        }),
      },
      // Operator risk defaults (17-field agentRiskDefaults block) — exposed to
      // the get_operator_defaults read tool and enforced as ceilings by
      // set_agent_trading_profile. Traderton is the sole authority.
      operatorRiskDefaults: appConfig.agentRiskDefaults,
      // Wave E / E1-T T5: the agent-actor lifecycle port for the consumer-only
      // start_agent_actor / stop_agent_actor tools. Present only for an AGENT
      // subject (actor = the agent itself); the tools guard on its absence. It
      // closes over this request's RESOLVED venue coordinates (`injection`) so
      // start records the right run state without the tool ever seeing coords,
      // and over the shared ops so stop stops+deregisters+evicts+cascades.
      agentActorLifecycle: request.actor.type === 'agent'
        ? {
            recordRunning: () => agentActorLifecycleOps.recordRunning({
              ownerId: request.ownerId,
              actorId: request.actor.id,
              venueAccountId: injection.venueAccountId,
              venue: injection.venue,
              venueType: injection.venueType,
            }),
            stop: () => agentActorLifecycleOps.stopAgent(request.ownerId, request.actor.id),
          }
        : undefined,
    };
  };

  // The additive MCP binding (Phase 3 T2.2; Phase 4 T2 — tools/list from the
  // registry) — off unless the operator opts in. `resolveMcpSurfaceConfig` fails
  // fast on a bad env or an unserviceable tool surface so a misconfig crashes the
  // process at start rather than mounting a broken surface.
  const mcp = resolveMcpSurfaceConfig(
    { enabled: process.env['BOUNDARY_MCP_ENABLED'] },
    registry,
  );
  if (mcp) {
    // eslint-disable-next-line no-console
    console.info(`MCP binding mounted at /internal/v1/mcp (${mcp.tools.length} tool(s) in tools/list)`);
  }

  const app = createBoundaryApp({
    config: boundaryConfig,
    registry,
    contextFactory,
    invocationStore,
    computeRequestFingerprint,
    retentionMs,
    ...(mcp ? { mcp } : {}),
  });

  // Graceful shutdown (E2 F3): on SIGTERM/SIGINT close the listener, shut the
  // runtime down (actors stop, leases release, bot rows stay `running` per the
  // resume ruling), quit BOTH Redis connections (main + bot-stop subscriber),
  // then exit 0. Registered BEFORE `listen` so a signal during start-up is still
  // handled (`app.close()` is a no-op on an un-listened app). Double signals are
  // guarded inside the returned shutdown function.
  registerBoundaryShutdown({
    app,
    runtime,
    redis,
    botStopSubscriber,
    logger: createLogger('boundary-shutdown'),
    exit: (code) => process.exit(code),
    stopBackgroundLoops: [
      () => consumerNotificationPrune.stop(),
      () => agentScanPrune.stop(),
      () => agentOrphanSweep.stop(),
      // Plan 003 S4: stop the journal-maintenance loop (latch no-ops a pending
      // tick) and clear any lease renew timer (a tick mid-run releases in its own
      // finally; this covers the loop being stopped between acquire and release).
      () => {
        journalMaintenance.stop();
        journalMaintenanceLease.shutdown();
      },
      // 001 S3: stop the command consumer loop (unblocks + quits its dedicated
      // BLPOP connection) and quit the agent-actor stop subscriber connection.
      () => agentCommandConsumer.stop(),
      () => void agentActorStopSubscriber.quit().catch(() => { /* best-effort */ }),
    ],
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
