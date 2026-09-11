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
import {
  createDatabase,
  BotRepository,
  BoundaryInvocationRepository,
  computeRequestFingerprint,
  venueAccounts,
} from '@traderton/db';
import { createTradingRuntime, loadConfig } from '@traderton/worker';
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
  const runtime = createTradingRuntime({
    config: appConfig,
    redis,
    // No bots rehydrate at boundary start — bot lifecycle is driven by tool
    // calls, not a boot-time reload. The runtime still starts its lifecycle-job
    // consumer + reclaim loop.
    instanceLoader: async () => [],
  });
  await runtime.start();

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

    const resolution = await resolveSubjectInjection(
      { ownerId: request.ownerId, actor: request.actor },
      category,
      request.payload,
      resolverPorts,
    );
    if (!resolution.ok) {
      // The dispatcher maps a thrown factory to precondition.not_ready; an
      // authorization mismatch is surfaced by throwing so the boundary refuses.
      throw new Error(`subject resolution failed: ${resolution.code}: ${resolution.message}`);
    }

    const injection = resolution.injection;
    const publishToInbound = runtime.createDriveTarget(injection);

    return {
      agentId: request.actor.id,
      sessionId: `boundary:${request.ownerId}`,
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
