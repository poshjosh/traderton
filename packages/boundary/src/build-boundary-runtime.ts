// Extracted from bin.ts so the boundary's trading-runtime construction — in
// particular that it is wired with the shared running-bot loader (E2 F2) — is
// unit-testable without booting the boundary process (mirrors the
// agent-direct-actor-ensure.ts / resolver-ports.ts extractions).

import type { Redis } from 'ioredis';
import type { Database } from '@traderton/db';
import {
  createTradingRuntime,
  createRunningBotLoader,
  type TradingRuntime,
} from '@traderton/worker';
import type { loadConfig } from '@traderton/worker';

type AppConfig = ReturnType<typeof loadConfig>;

/**
 * Build the boundary's trading runtime with the shared running-bot loader.
 *
 * Running bots rehydrate at boundary start via `createRunningBotLoader(db)` (E2
 * F2): the runtime's initial sweep + reclaim loop reload every bot whose row is
 * `status:'running'` and reclaim the ones no live process owns. This is how bots
 * survive a graceful Traderton restart (resume ruling). The shipped boundary
 * process (`boundary/dist/bin.js`) and the M1 worker entry now rehydrate bots the
 * SAME way.
 */
export function buildBoundaryTradingRuntime(deps: {
  config: AppConfig;
  redis: Redis;
  db: Database;
}): TradingRuntime {
  return createTradingRuntime({
    config: deps.config,
    redis: deps.redis,
    instanceLoader: createRunningBotLoader(deps.db),
  });
}
