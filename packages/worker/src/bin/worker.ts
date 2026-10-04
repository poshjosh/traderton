import { Redis } from 'ioredis';
import { createDatabase } from '@traderton/db';

import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { createTradingRuntime } from '../composition/create-trading-runtime.js';
import { createRunningBotLoader } from '../composition/running-bot-loader.js';

/**
 * Tiny process entry for the trading worker (Phase 9b item B).
 *
 * Loads operator config, builds a Redis connection + the real running-bot
 * instanceLoader, then constructs and starts the bot-lifecycle runtime. This is
 * the M1 in-process driver of the same factory the M2 REST adapter will drive.
 */
async function main(): Promise<void> {
  const logger = createLogger('worker-bin');
  const config = loadConfig();

  const redis = new Redis(config.redis.url, { maxRetriesPerRequest: null });

  // Real instance loader: bots WHERE status='running'. Each persisted config
  // carries the injected venueAccountId + soft ownerId + creator (decisions
  // 11–13; creator is additive for E3 routing). Shared with the boundary process
  // via the single `createRunningBotLoader` (E2 F2).
  const db = createDatabase(config.database.url);
  const instanceLoader = createRunningBotLoader(db);

  const trading = createTradingRuntime({ config, redis, instanceLoader });
  await trading.start();
  logger.info('Trading worker started');

  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down trading worker...');
    await trading.shutdown();
    await redis.quit();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main();
