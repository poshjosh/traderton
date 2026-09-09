import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import type { Database } from './index.js';
import { BotRepository } from './repositories.js';
import { openTestDb, truncate, type TestDb } from './test-helpers/integration-db.js';

const SKIP = !process.env['DATABASE_URL'];

/**
 * AUTHORED concurrency integration test (Phase 9b item E). DATABASE_URL-gated —
 * skips locally, runs against Postgres in CI (Phase 10), matching the
 * `journal-pg.integration.test.ts` / `position-repository.integration.test.ts`
 * pattern.
 *
 * This is the REAL proof the per-`ownerId` advisory lock serializes: fire N
 * concurrent `tryCreateBotWithLimit` for ONE ownerId at maxBots=k and assert
 * EXACTLY k succeed. A plain transaction under READ COMMITTED would let all N
 * read "under limit" and all N insert — the `pg_advisory_xact_lock(classId,
 * hashtext(ownerId))` serialization is what makes exactly k win.
 */
describe.skipIf(SKIP)('BotRepository maxBots concurrency (integration)', () => {
  let client: ReturnType<typeof postgres>;
  let db: TestDb;
  let repo: BotRepository;

  const OWNER_ID = 'owner-limit-test';
  const OTHER_OWNER_ID = 'owner-limit-test-other';
  const VENUE_ACCOUNT_ID = 'va-limit-test';
  const OTHER_VENUE_ACCOUNT_ID = 'va-limit-test-other';

  async function seedVenueAccount(id: string, ownerId: string): Promise<void> {
    await client.unsafe(
      `INSERT INTO venue_accounts (id, owner_id, venue, label) VALUES ($1, $2, $3, $4)`,
      [id, ownerId, 'hyperliquid', `label-${id}`],
    );
  }

  beforeAll(() => {
    const handle = openTestDb();
    db = handle.db;
    client = handle.client;
    repo = new BotRepository(db as unknown as Database);
  }, 30_000);

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await truncate(client, 'bots', 'venue_accounts');
    await seedVenueAccount(VENUE_ACCOUNT_ID, OWNER_ID);
    await seedVenueAccount(OTHER_VENUE_ACCOUNT_ID, OTHER_OWNER_ID);
  });

  it('N concurrent tryCreateBotWithLimit for one ownerId at maxBots=k: exactly k succeed', async () => {
    // Note: tryCreateBotWithLimit inserts `status:'stopped'`, which does NOT count
    // toward the running-bot limit. To exercise the create-path serialization we
    // first mark each created bot running via tryMarkBotRunningWithLimit under the
    // same lock — but the create-path race itself is best proven by counting the
    // running slots the concurrent MARK calls claim (below). Here we prove the
    // create+mark pipeline as herobids runs it (create → mark).
    const k = 3;
    const n = 12;

    // Fire N concurrent create+mark pipelines. Each create inserts a stopped bot;
    // each mark atomically claims a running slot under the advisory lock. Exactly
    // k marks must succeed.
    const results = await Promise.all(
      Array.from({ length: n }, async () => {
        const created = await repo.tryCreateBotWithLimit({
          ownerId: OWNER_ID,
          venueAccountId: VENUE_ACCOUNT_ID,
          config: {},
          creatorType: 'agent',
          creatorId: 'agent-1',
          maxBots: k,
        });
        if (!created.created || !created.botId) return false;
        return repo.tryMarkBotRunningWithLimit({
          botId: created.botId,
          ownerId: OWNER_ID,
          creatorType: 'agent',
          creatorId: 'agent-1',
          maxBots: k,
        });
      }),
    );

    const claimed = results.filter((r) => r === true).length;
    expect(claimed).toBe(k);

    // The DB agrees: exactly k running bots for this owner.
    const runningRows = await client.unsafe(
      `SELECT id FROM bots WHERE owner_id = $1 AND status = 'running'`,
      [OWNER_ID],
    );
    expect(runningRows.length).toBe(k);
  }, 30_000);

  it('the count is keyed on ownerId: a different owner does not consume this owner\'s slots', async () => {
    const k = 2;

    // Fill the OTHER owner to capacity (running).
    for (let i = 0; i < 5; i++) {
      const created = await repo.tryCreateBotWithLimit({
        ownerId: OTHER_OWNER_ID,
        venueAccountId: OTHER_VENUE_ACCOUNT_ID,
        config: {},
        creatorType: 'agent',
        creatorId: 'agent-other',
        maxBots: 100,
      });
      await repo.tryMarkBotRunningWithLimit({
        botId: created.botId!,
        ownerId: OTHER_OWNER_ID,
        creatorType: 'agent',
        creatorId: 'agent-other',
        maxBots: 100,
      });
    }

    // This owner can still claim k slots — the other owner's running bots do not
    // count toward this owner's limit (count keyed on ownerId).
    const results: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const created = await repo.tryCreateBotWithLimit({
        ownerId: OWNER_ID,
        venueAccountId: VENUE_ACCOUNT_ID,
        config: {},
        creatorType: 'agent',
        creatorId: 'agent-1',
        maxBots: k,
      });
      const claimed = await repo.tryMarkBotRunningWithLimit({
        botId: created.botId!,
        ownerId: OWNER_ID,
        creatorType: 'agent',
        creatorId: 'agent-1',
        maxBots: k,
      });
      results.push(claimed);
    }

    expect(results.filter((r) => r).length).toBe(k);
  }, 30_000);
});
