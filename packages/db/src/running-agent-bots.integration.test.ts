import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import type { Database } from './index.js';
import { BotRepository } from './repositories.js';
import { openTestDb, truncate, type TestDb } from './test-helpers/integration-db.js';

const SKIP = !process.env['DATABASE_URL'];

/**
 * DATABASE_URL-gated integration test for `listRunningAgentBots`, the listing
 * behind the boundary's agent orphan sweep (bug 2026-10-05/003).
 *
 * The drive target stamps every bot creatorType='agent', including bots a user
 * created through herobids, which carry creatorId = the user's own ownerId. The
 * sweep stops running agent bots whose creator agent is not running, so those
 * user bots must not appear in this listing.
 */
describe.skipIf(SKIP)('BotRepository.listRunningAgentBots (integration)', () => {
  let client: ReturnType<typeof postgres>;
  let db: TestDb;
  let repo: BotRepository;

  const OWNER_ID = 'owner-running-agent-bots';
  const AGENT_ID = 'agent-running-agent-bots';
  const VENUE_ACCOUNT_ID = 'va-running-agent-bots';

  async function seedBot(opts: {
    id: string;
    status: string;
    creatorType: string;
    creatorId: string;
  }): Promise<void> {
    await client.unsafe(
      `INSERT INTO bots (id, owner_id, venue_account_id, config, status, creator_type, creator_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        opts.id,
        OWNER_ID,
        VENUE_ACCOUNT_ID,
        JSON.stringify({ symbol: 'SOL/USDC' }),
        opts.status,
        opts.creatorType,
        opts.creatorId,
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
    await client.unsafe(
      `INSERT INTO venue_accounts (id, owner_id, venue, label) VALUES ($1, $2, $3, $4)`,
      [VENUE_ACCOUNT_ID, OWNER_ID, 'hyperliquid', 'label-running-agent-bots'],
    );
  });

  it('lists running bots created by an agent', async () => {
    await seedBot({ id: 'bot-agent-running', status: 'running', creatorType: 'agent', creatorId: AGENT_ID });

    expect(await repo.listRunningAgentBots()).toEqual([{ id: 'bot-agent-running', creatorId: AGENT_ID }]);
  });

  it('excludes user-created bots stamped with the user as creator', async () => {
    await seedBot({ id: 'bot-agent-running', status: 'running', creatorType: 'agent', creatorId: AGENT_ID });
    // The herobids user path: stamped 'agent', creatorId = the owner's own id.
    await seedBot({ id: 'bot-user-running', status: 'running', creatorType: 'agent', creatorId: OWNER_ID });

    expect(await repo.listRunningAgentBots()).toEqual([{ id: 'bot-agent-running', creatorId: AGENT_ID }]);
  });

  it('excludes bots that are not running', async () => {
    await seedBot({ id: 'bot-agent-stopped', status: 'stopped', creatorType: 'agent', creatorId: AGENT_ID });

    expect(await repo.listRunningAgentBots()).toEqual([]);
  });
});
