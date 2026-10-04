import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import type { Database } from './index.js';
import { AgentActorRunRepository } from './agent-actor-run-repository.js';
import { openTestDb, truncate, type TestDb } from './test-helpers/integration-db.js';

const SKIP = !process.env['DATABASE_URL'];

/**
 * DATABASE_URL-gated integration test (Wave E / E1-T T5). Skips locally, runs
 * against real Postgres when DATABASE_URL is set — matching the consumer-
 * notification / agent-scan repo integration patterns. Proves the (owner, actor)
 * upsert, the stop transition, the running listing, and the single-row lookup.
 */
describe.skipIf(SKIP)('AgentActorRunRepository (integration)', () => {
  let client: ReturnType<typeof postgres>;
  let db: TestDb;
  let repo: AgentActorRunRepository;

  beforeAll(() => {
    const handle = openTestDb();
    db = handle.db;
    client = handle.client;
    // TestDb and Database are structurally identical (same drizzle(client, {schema}));
    // the cast is safe — only needed because they originate from different call sites.
    repo = new AgentActorRunRepository(db as unknown as Database);
  }, 30_000);

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await truncate(client, 'agent_actor_runs');
  });

  const coords = (actorId: string, venueAccountId = 'va-1') => ({
    ownerId: 'owner-1',
    actorId,
    venueAccountId,
    venue: 'hyperliquid',
    venueType: 'orderbook',
  });

  it('upserts a running row keyed on (ownerId, actorId) and lists it', async () => {
    await repo.upsertRunning(coords('agent-1'));

    const running = await repo.listRunning();
    expect(running).toHaveLength(1);
    expect(running[0]?.actorId).toBe('agent-1');
    expect(running[0]?.desiredState).toBe('running');
    expect(running[0]?.venueAccountId).toBe('va-1');
  });

  it('upsert is idempotent: two starts converge on one running row (updated coords)', async () => {
    await repo.upsertRunning(coords('agent-1', 'va-1'));
    const first = await repo.getByOwnerActor('owner-1', 'agent-1');
    expect(first).not.toBeNull();

    // Second start with new venue coordinates updates the SAME row (same id).
    await repo.upsertRunning(coords('agent-1', 'va-2'));

    const all = await repo.listRunning();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(first!.id); // same row, not a second insert
    expect(all[0]?.venueAccountId).toBe('va-2');
  });

  it('markStopped flips desired_state and drops the row from the running list', async () => {
    await repo.upsertRunning(coords('agent-1'));
    await repo.markStopped('owner-1', 'agent-1');

    const running = await repo.listRunning();
    expect(running).toHaveLength(0);

    const row = await repo.getByOwnerActor('owner-1', 'agent-1');
    expect(row?.desiredState).toBe('stopped');
  });

  it('markStopped is idempotent: a stopped row stays stopped, an absent row is a no-op', async () => {
    // Absent row — no throw, nothing created.
    await repo.markStopped('owner-1', 'ghost');
    expect(await repo.getByOwnerActor('owner-1', 'ghost')).toBeNull();

    await repo.upsertRunning(coords('agent-1'));
    await repo.markStopped('owner-1', 'agent-1');
    await repo.markStopped('owner-1', 'agent-1'); // repeat
    const row = await repo.getByOwnerActor('owner-1', 'agent-1');
    expect(row?.desiredState).toBe('stopped');
  });

  it('a restarted agent (stop then start) is running again as one row', async () => {
    await repo.upsertRunning(coords('agent-1'));
    await repo.markStopped('owner-1', 'agent-1');
    await repo.upsertRunning(coords('agent-1'));

    const running = await repo.listRunning();
    expect(running).toHaveLength(1);
    expect(running[0]?.desiredState).toBe('running');
  });

  it('listRunning returns only running rows across owners/actors', async () => {
    await repo.upsertRunning(coords('agent-1'));
    await repo.upsertRunning({ ...coords('agent-2'), ownerId: 'owner-2' });
    await repo.upsertRunning(coords('agent-3'));
    await repo.markStopped('owner-1', 'agent-3');

    const running = await repo.listRunning();
    expect(running.map((r) => r.actorId).sort()).toEqual(['agent-1', 'agent-2']);
  });

  it('getByOwnerActor is owner-scoped: another owner does not see the row', async () => {
    await repo.upsertRunning(coords('agent-1'));
    expect(await repo.getByOwnerActor('owner-2', 'agent-1')).toBeNull();
    expect(await repo.getByOwnerActor('owner-1', 'agent-1')).not.toBeNull();
  });
});
