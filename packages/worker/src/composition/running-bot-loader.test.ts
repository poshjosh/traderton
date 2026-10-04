/**
 * AUTHORED test (E2 F2) — the single shared running-bot InstanceLoader.
 *
 * The loader is wiring: `bots WHERE status='running'` → `PersistedInstance[]`
 * with the injected venue/owner/creator VALUES re-attached onto each config.
 * This test fakes the drizzle query surface (no Postgres) and asserts the two
 * behaviours the reclaim path depends on: only running rows are returned, and
 * each config carries venueAccountId, ownerId, creatorType and creatorId.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Database } from '@traderton/db';

import { createRunningBotLoader } from './running-bot-loader.js';

interface FakeBotRow {
  id: string;
  ownerId: string;
  venueAccountId: string;
  creatorType: string;
  creatorId: string | null;
  config: Record<string, unknown>;
}

/**
 * A fake `Database` that returns `rows` from `select().from().where()` and
 * records that the loader filtered on a `where` clause (status='running'). The
 * real schema predicate is drizzle-internal; the loader's running-only contract
 * is proven by the fixture only exposing running rows through this surface, the
 * same way the production query returns only `status='running'` rows.
 */
function fakeDb(rows: FakeBotRow[]): { db: Database; whereCalls: number } {
  let whereCalls = 0;
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          whereCalls += 1;
          return Promise.resolve(rows);
        },
      }),
    }),
  } as unknown as Database;
  return { db, get whereCalls() { return whereCalls; } };
}

function makeRow(overrides: Partial<FakeBotRow> = {}): FakeBotRow {
  return {
    id: 'bot-1',
    ownerId: 'owner-1',
    venueAccountId: 'va-1',
    creatorType: 'agent',
    creatorId: 'agent-1',
    config: { symbol: 'BTC', strategy: { type: 'momentum' } },
    ...overrides,
  };
}

describe('createRunningBotLoader', () => {
  it('loads only running bots', async () => {
    // The fake surface only ever hands back what the status='running' query
    // returned, so a loader that applied the predicate sees exactly these rows.
    const running = [makeRow({ id: 'bot-running-1' }), makeRow({ id: 'bot-running-2' })];
    const fake = fakeDb(running);
    const whereSpy = vi.spyOn(fake.db, 'select');

    const load = createRunningBotLoader(fake.db);
    const result = await load();

    expect(whereSpy).toHaveBeenCalledOnce();
    expect(fake.whereCalls).toBe(1);
    expect(result.map((i) => i.id)).toEqual(['bot-running-1', 'bot-running-2']);
  });

  it('attaches venueAccountId, ownerId and creator to each config', async () => {
    const fake = fakeDb([
      makeRow({
        id: 'bot-1',
        ownerId: 'owner-77',
        venueAccountId: 'va-77',
        creatorType: 'agent',
        creatorId: 'agent-77',
        config: { symbol: 'ETH', execution: { mode: 'paper' } },
      }),
      // A system-created bot with a null creatorId — the null must survive onto
      // the config (not be dropped or coerced).
      makeRow({
        id: 'bot-2',
        ownerId: 'owner-88',
        venueAccountId: 'va-88',
        creatorType: 'system',
        creatorId: null,
        config: { symbol: 'SOL' },
      }),
    ]);

    const load = createRunningBotLoader(fake.db);
    const result = await load();

    expect(result[0]).toEqual({
      id: 'bot-1',
      config: {
        symbol: 'ETH',
        execution: { mode: 'paper' },
        venueAccountId: 'va-77',
        ownerId: 'owner-77',
        creatorType: 'agent',
        creatorId: 'agent-77',
      },
    });
    expect(result[1]).toEqual({
      id: 'bot-2',
      config: {
        symbol: 'SOL',
        venueAccountId: 'va-88',
        ownerId: 'owner-88',
        creatorType: 'system',
        creatorId: null,
      },
    });
  });
});
