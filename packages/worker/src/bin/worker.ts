import { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { createDatabase, bots } from '@traderton/db';

import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { createTradingRuntime } from '../composition/create-trading-runtime.js';
import type { PersistedInstance } from '../runtime.js';

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
  // carries the injected venueAccountId + soft ownerId (decisions 11–13).
  const db = createDatabase(config.database.url);
  const instanceLoader = async (): Promise<PersistedInstance[]> => {
    const running = await db.select().from(bots).where(eq(bots.status, 'running'));
    return running.map((row) => ({
      id: row.id,
      config: { ...row.config, venueAccountId: row.venueAccountId, ownerId: row.ownerId },
    }));
  };

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
