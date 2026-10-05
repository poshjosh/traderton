import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import type { Database } from './index.js';
import { BotRepository } from './repositories.js';
import { AgentActorRunRepository } from './agent-actor-run-repository.js';
import { openTestDb, truncate, type TestDb } from './test-helpers/integration-db.js';

const SKIP = !process.env['DATABASE_URL'];

/**
 * DATABASE_URL-gated integration test for `listRunningBotsOfStoppedAgents`, the
 * listing behind pass 1 of the boundary's agent orphan sweep.
 *
 * Positive evidence only (bug 2026-10-05/004): a running agent bot is listed
 * only when its creator agent has an explicit `stopped` run row for the same
 * owner. A creator with no run row (herobids writes none today) or a `running`
 * row is left alone. User-created bots (stamped 'agent' with creatorId =
 * ownerId, bug 2026-10-05/003) are never listed.
 */
describe.skipIf(SKIP)('BotRepository.listRunningBotsOfStoppedAgents (integration)', () => {
  let client: ReturnType<typeof postgres>;
  let db: TestDb;
  let repo: BotRepository;
  let runRepo: AgentActorRunRepository;

  const OWNER_ID = 'owner-orphan-listing';
  const OTHER_OWNER_ID = 'owner-orphan-listing-other';
  const AGENT_ID = 'agent-orphan-listing';
  const VENUE_ACCOUNT_ID = 'va-orphan-listing';

  async function seedBot(opts: {
    id: string;
    status: string;
    creatorId: string;
    ownerId?: string;
  }): Promise<void> {
    await client.unsafe(
      `INSERT INTO bots (id, owner_id, venue_account_id, config, status, creator_type, creator_id)
       VALUES ($1, $2, $3, $4, $5, 'agent', $6)`,
      [
        opts.id,
        opts.ownerId ?? OWNER_ID,
        VENUE_ACCOUNT_ID,
        JSON.stringify({ symbol: 'SOL/USDC' }),
        opts.status,
        opts.creatorId,
      ],
    );
  }

  async function recordRun(actorId: string, desired: 'running' | 'stopped', ownerId = OWNER_ID): Promise<void> {
    await runRepo.upsertRunning({ ownerId, actorId, venueAccountId: VENUE_ACCOUNT_ID, venue: 'hyperliquid', venueType: 'orderbook' });
    if (desired === 'stopped') await runRepo.markStopped(ownerId, actorId);
  }

  beforeAll(() => {
    const handle = openTestDb();
    db = handle.db;
    client = handle.client;
    repo = new BotRepository(db as unknown as Database);
    runRepo = new AgentActorRunRepository(db as unknown as Database);
  }, 30_000);

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await truncate(client, 'bots', 'venue_accounts', 'agent_actor_runs');
    await client.unsafe(
      `INSERT INTO venue_accounts (id, owner_id, venue, label) VALUES ($1, $2, $3, $4)`,
      [VENUE_ACCOUNT_ID, OWNER_ID, 'hyperliquid', 'label-orphan-listing'],
    );
  });

  it('lists a running bot whose creator agent is explicitly stopped', async () => {
    await seedBot({ id: 'bot-1', status: 'running', creatorId: AGENT_ID });
    await recordRun(AGENT_ID, 'stopped');

    expect(await repo.listRunningBotsOfStoppedAgents()).toEqual([{ id: 'bot-1', creatorId: AGENT_ID }]);
  });

  it('does not list a running bot whose creator agent has no run row', async () => {
    await seedBot({ id: 'bot-1', status: 'running', creatorId: AGENT_ID });

    expect(await repo.listRunningBotsOfStoppedAgents()).toEqual([]);
  });

  it('does not list a running bot whose creator agent is running', async () => {
    await seedBot({ id: 'bot-1', status: 'running', creatorId: AGENT_ID });
    await recordRun(AGENT_ID, 'running');

    expect(await repo.listRunningBotsOfStoppedAgents()).toEqual([]);
  });

  it('does not list a bot that is not running', async () => {
    await seedBot({ id: 'bot-1', status: 'stopped', creatorId: AGENT_ID });
    await recordRun(AGENT_ID, 'stopped');

    expect(await repo.listRunningBotsOfStoppedAgents()).toEqual([]);
  });

  it('does not list user-created bots stamped with the user as creator', async () => {
    await seedBot({ id: 'bot-user', status: 'running', creatorId: OWNER_ID });
    await recordRun(OWNER_ID, 'stopped');

    expect(await repo.listRunningBotsOfStoppedAgents()).toEqual([]);
  });

  it('matches the run row on owner as well as agent id', async () => {
    await seedBot({ id: 'bot-1', status: 'running', creatorId: AGENT_ID });
    // A stopped row for the same agent id under a DIFFERENT owner is not evidence.
    await recordRun(AGENT_ID, 'stopped', OTHER_OWNER_ID);

    expect(await repo.listRunningBotsOfStoppedAgents()).toEqual([]);
  });
});
