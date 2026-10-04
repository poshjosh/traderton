import { eq } from 'drizzle-orm';
import { bots, type Database } from '@traderton/db';

import type { InstanceLoader, PersistedInstance } from '../runtime.js';

/**
 * createRunningBotLoader — the single shared `InstanceLoader` (E2 F2).
 *
 * Loads every bot whose row is `status:'running'` and re-attaches the injected
 * VALUES the ActorFactory expects on the config it is handed. `WorkerRuntime`
 * drives this on initial rehydration and on every reclaim sweep, so a bot's row
 * (`running`) is the single source of truth for what the process reclaims after a
 * restart or peer death.
 *
 * Attached fields (decisions 11–13 + E3 routing):
 *  - `venueAccountId` / `ownerId` — the bot's bound account + soft owner; the
 *    factory reads them straight off the config object.
 *  - `creatorType` / `creatorId` — ADDITIVE (E3 routes bot/agent status events to
 *    the owning agent/user by them). Stamped here so the reclaim-path config
 *    matches the start-path config the drive target enqueues.
 *
 * This was previously inlined in `bin/worker.ts`; it is now shared so the shipped
 * boundary process (`boundary/src/bin.ts`) and the M1 worker entry load bots the
 * same way.
 */
export function createRunningBotLoader(db: Database): InstanceLoader {
  return async (): Promise<PersistedInstance[]> => {
    const running = await db.select().from(bots).where(eq(bots.status, 'running'));
    return running.map((row) => ({
      id: row.id,
      config: {
        ...row.config,
        venueAccountId: row.venueAccountId,
        ownerId: row.ownerId,
        creatorType: row.creatorType,
        creatorId: row.creatorId,
      },
    }));
  };
}
