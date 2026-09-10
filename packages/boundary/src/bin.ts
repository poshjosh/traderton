// AUTHORED (Phase 9b item F1) — the tiny boundary process entry. Assembles the
// copied tool registry, reads the boundary config, and starts the Fastify app.
//
// This is the F1 SHELL entry. The `TradingToolContext` injection seam
// (`contextFactory`) is where a full deployment wires the read-only repos /
// runtime a consumer owns (the same ports item C/D use); F1 supplies a base
// context carrying the signed subject. Context-free read tools (e.g. get_schema)
// serve immediately; repo-backed read tools return their own graceful
// "unavailable" result until the composition root wires them (F2 / deployment).

import type { TradingToolContext } from '@traderton/domain';
import { createBoundaryApp } from './app.js';
import { BoundaryConfigSchema, type BoundaryConfig } from './config.js';
import type { DispatchSubject, TradingToolContextFactory } from './dispatcher.js';
import { buildToolRegistry } from './registry.js';

/** A no-op async Redis stub — F1's shell has no live Redis; repo-backed tools
 *  degrade gracefully via their own guards. A real deployment injects a client. */
const NOOP_REDIS: TradingToolContext['redis'] = {
  hset: async () => 0,
  hget: async () => null,
  hgetall: async () => null,
  hdel: async () => 0,
  publish: async () => 0,
  blpop: async () => null,
  smembers: async () => [],
  sadd: async () => 0,
  srem: async () => 0,
  expire: async () => 0,
};

/** Build the F1 base `TradingToolContext` for a signed subject. */
function baseContextFactory(subject: DispatchSubject): TradingToolContext {
  return {
    agentId: subject.actor.id,
    sessionId: `boundary:${subject.ownerId}`,
    executionMode: 'paper',
    authorizationMode: 'approval_required',
    redis: NOOP_REDIS,
    publishToInbound: async () => {
      // Read-only tools do not publish; side-effecting drive is F2.
    },
  };
}

function loadBoundaryConfig(): BoundaryConfig {
  const consumerId = process.env['BOUNDARY_CONSUMER_ID'];
  const keyId = process.env['BOUNDARY_KEY_ID'];
  const secret = process.env['BOUNDARY_SIGNING_SECRET'];
  const clockSkewMs = process.env['BOUNDARY_CLOCK_SKEW_MS'];

  const allowedConsumers =
    consumerId && keyId && secret ? { [consumerId]: { keyId, secret } } : {};

  return BoundaryConfigSchema.parse({
    ...(clockSkewMs ? { clockSkewMs: Number(clockSkewMs) } : {}),
    allowedConsumers,
  });
}

async function main(): Promise<void> {
  const config = loadBoundaryConfig();
  const registry = buildToolRegistry();
  const contextFactory: TradingToolContextFactory = baseContextFactory;

  const app = createBoundaryApp({ config, registry, contextFactory });

  const port = Number(process.env['BOUNDARY_PORT'] ?? 8080);
  const host = process.env['BOUNDARY_HOST'] ?? '0.0.0.0';
  await app.listen({ port, host });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('boundary failed to start', err);
  process.exitCode = 1;
});
