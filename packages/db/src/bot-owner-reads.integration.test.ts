import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import type { Database } from './index.js';
import { BotRepository } from './repositories.js';
import { openTestDb, truncate, type TestDb } from './test-helpers/integration-db.js';

const SKIP = !process.env['DATABASE_URL'];

/**
 * DATABASE_URL-gated integration test for the owner-scoped bot READ surface
 * (getBotsByOwner / getBotByIdForOwner). Skips locally, runs against Postgres
 * when DATABASE_URL is set — matching the `bot-limit.integration.test.ts` /
 * `position-repository.integration.test.ts` pattern.
 *
 * These methods are a copy/adapt of the creator-scoped read path re-keyed to the
 * soft `ownerId` column (004 "Bot-consumer contract", ruling 4). The scoping
 * semantics under test: an owner's view = ALL bots whose `ownerId` matches,
 * REGARDLESS of `creatorType` (owner = the tenancy boundary).
 */
describe.skipIf(SKIP)('BotRepository owner-scoped reads (integration)', () => {
  let client: ReturnType<typeof postgres>;
  let db: TestDb;
  let repo: BotRepository;

  const OWNER_ID = 'owner-reads-test';
  const OTHER_OWNER_ID = 'owner-reads-test-other';
  const VENUE_ACCOUNT_ID = 'va-reads-test';
  const OTHER_VENUE_ACCOUNT_ID = 'va-reads-test-other';

  async function seedVenueAccount(id: string, ownerId: string): Promise<void> {
    await client.unsafe(
      `INSERT INTO venue_accounts (id, owner_id, venue, label) VALUES ($1, $2, $3, $4)`,
      [id, ownerId, 'hyperliquid', `label-${id}`],
    );
  }

  async function seedBot(opts: {
    id: string;
    ownerId: string;
    venueAccountId: string;
    creatorType: string;
    creatorId: string | null;
    createdAt?: Date;
  }): Promise<void> {
    await client.unsafe(
      `INSERT INTO bots (id, owner_id, venue_account_id, config, status, creator_type, creator_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        opts.id,
        opts.ownerId,
        opts.venueAccountId,
        JSON.stringify({ symbol: 'SOL/USDC' }),
        'stopped',
        opts.creatorType,
        opts.creatorId,
        (opts.createdAt ?? new Date()).toISOString(),
      ],
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

  it('getBotsByOwner returns ALL bots for the owner regardless of creatorType', async () => {
    // Two bots for this owner with DIFFERENT creator types, plus one for another owner.
    await seedBot({ id: 'bot-agent', ownerId: OWNER_ID, venueAccountId: VENUE_ACCOUNT_ID, creatorType: 'agent', creatorId: 'agent-1' });
    await seedBot({ id: 'bot-user', ownerId: OWNER_ID, venueAccountId: VENUE_ACCOUNT_ID, creatorType: 'user', creatorId: 'user-1' });
    await seedBot({ id: 'bot-system', ownerId: OWNER_ID, venueAccountId: VENUE_ACCOUNT_ID, creatorType: 'system', creatorId: null });
    await seedBot({ id: 'bot-foreign', ownerId: OTHER_OWNER_ID, venueAccountId: OTHER_VENUE_ACCOUNT_ID, creatorType: 'agent', creatorId: 'agent-2' });

    const rows = await repo.getBotsByOwner(OWNER_ID);
    const ids = rows.map((r) => r.id).sort();

    expect(ids).toEqual(['bot-agent', 'bot-system', 'bot-user']);
    // The foreign-owner bot is never returned.
    expect(ids).not.toContain('bot-foreign');
  });

  it('getBotsByOwner filters by the since date when provided', async () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    await seedBot({ id: 'bot-old', ownerId: OWNER_ID, venueAccountId: VENUE_ACCOUNT_ID, creatorType: 'agent', creatorId: 'agent-1', createdAt: old });
    await seedBot({ id: 'bot-recent', ownerId: OWNER_ID, venueAccountId: VENUE_ACCOUNT_ID, creatorType: 'agent', creatorId: 'agent-1', createdAt: recent });

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const rows = await repo.getBotsByOwner(OWNER_ID, since);

    expect(rows.map((r) => r.id)).toEqual(['bot-recent']);
  });

  it('getBotByIdForOwner returns the row when it belongs to the owner', async () => {
    await seedBot({ id: 'bot-1', ownerId: OWNER_ID, venueAccountId: VENUE_ACCOUNT_ID, creatorType: 'user', creatorId: 'user-1' });

    const row = await repo.getBotByIdForOwner('bot-1', OWNER_ID);

    expect(row).not.toBeNull();
    expect(row?.id).toBe('bot-1');
    expect(row?.ownerId).toBe(OWNER_ID);
  });

  it('getBotByIdForOwner rejects a bot owned by a different owner (returns null)', async () => {
    await seedBot({ id: 'bot-foreign', ownerId: OTHER_OWNER_ID, venueAccountId: OTHER_VENUE_ACCOUNT_ID, creatorType: 'agent', creatorId: 'agent-2' });

    const row = await repo.getBotByIdForOwner('bot-foreign', OWNER_ID);

    expect(row).toBeNull();
  });

  it('getBotByIdForOwner returns null for a non-existent bot', async () => {
    const row = await repo.getBotByIdForOwner('does-not-exist', OWNER_ID);
    expect(row).toBeNull();
  });
});
