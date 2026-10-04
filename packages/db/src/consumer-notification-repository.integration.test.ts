import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import type { Database } from './index.js';
import {
  ConsumerNotificationRepository,
  type ConsumerNotificationRow,
} from './consumer-notification-repository.js';
import { openTestDb, truncate, type TestDb } from './test-helpers/integration-db.js';

const SKIP = !process.env['DATABASE_URL'];

/**
 * DATABASE_URL-gated integration test (E3-T T1). Skips locally, runs against real
 * Postgres when DATABASE_URL is set — matching the journal / boundary-invocation
 * integration patterns. Proves the outbox cursor scan (asc createdAt, id, same
 * semantics as PgJournal.scanAfter), the exact-type filter, and the batched
 * retention delete.
 */
describe.skipIf(SKIP)('ConsumerNotificationRepository (integration)', () => {
  let client: ReturnType<typeof postgres>;
  let db: TestDb;
  let repo: ConsumerNotificationRepository;

  beforeAll(() => {
    const handle = openTestDb();
    db = handle.db;
    client = handle.client;
    // TestDb and Database are structurally identical (same drizzle(client, {schema}));
    // the cast is safe — only needed because they originate from different call sites.
    repo = new ConsumerNotificationRepository(db as unknown as Database);
  }, 30_000);

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await truncate(client, 'consumer_notifications');
  });

  /** Backdate a row's created_at so retention/ordering can be exercised deterministically. */
  async function setCreatedAt(botId: string, createdAt: Date): Promise<void> {
    await client.unsafe(
      `UPDATE consumer_notifications SET created_at = $1 WHERE bot_id = $2`,
      [createdAt.toISOString(), botId],
    );
  }

  it('scans notifications after a cursor in creation order', async () => {
    for (const n of [1, 2, 3, 4, 5]) {
      await repo.append({
        type: 'agent_wake',
        ownerId: 'owner-1',
        agentId: 'agent-1',
        payload: { n },
      });
    }

    // Rows come back ascending by (createdAt, id). Paginate with limit 2 and
    // accumulate seenIds across every row at the boundary timestamp — the stable
    // cursor contract (same as PgJournal.scanAfter). Several rows may share a
    // created_at (defaultNow resolution), so a single-id tiebreak is not assumed.
    const collected: ConsumerNotificationRow[] = [];
    let cursor: { createdAt: Date; seenIds: string[] } | undefined;

    for (let guard = 0; guard < 10; guard++) {
      const page = await repo.scanAfter(cursor ? { cursor, limit: 2 } : { limit: 2 });
      if (page.length === 0) break;
      collected.push(...page);
      const last = page[page.length - 1]!;
      const lastTs = last.createdAt.getTime();
      // Carry forward prior seenIds at the same boundary timestamp so no sibling
      // row sharing that timestamp is dropped.
      const priorAtTs =
        cursor && cursor.createdAt.getTime() === lastTs ? cursor.seenIds : [];
      const pageAtTs = collected.filter((r) => r.createdAt.getTime() === lastTs).map((r) => r.id);
      cursor = { createdAt: last.createdAt, seenIds: [...new Set([...priorAtTs, ...pageAtTs])] };
    }

    // Ascending order overall, and every row covered exactly once.
    const times = collected.map((r) => r.createdAt.getTime());
    expect([...times]).toEqual([...times].sort((a, b) => a - b));
    const ids = new Set(collected.map((r) => r.id));
    expect(ids.size).toBe(5);
    expect(new Set(collected.map((r) => (r.payload as { n: number }).n))).toEqual(
      new Set([1, 2, 3, 4, 5]),
    );

    // A fully-advanced cursor returns nothing more.
    const empty = await repo.scanAfter({ cursor: cursor!, limit: 2 });
    expect(empty).toHaveLength(0);
  });

  it('filters by type', async () => {
    await repo.append({ type: 'agent_wake', ownerId: 'owner-1', agentId: 'agent-1', payload: {} });
    await repo.append({ type: 'bot_status', ownerId: 'owner-1', agentId: 'agent-1', botId: 'bot-1', payload: {} });
    await repo.append({ type: 'scan_completed', ownerId: 'owner-1', agentId: 'agent-1', payload: {} });
    await repo.append({ type: 'bot_status', ownerId: 'owner-1', botId: 'bot-2', payload: {} });

    const onlyBotStatus = await repo.scanAfter({ types: ['bot_status'], limit: 10 });
    expect(onlyBotStatus).toHaveLength(2);
    expect(onlyBotStatus.every((r) => r.type === 'bot_status')).toBe(true);

    const two = await repo.scanAfter({ types: ['agent_wake', 'scan_completed'], limit: 10 });
    expect(two.map((r) => r.type).sort()).toEqual(['agent_wake', 'scan_completed']);

    // No type filter returns everything.
    const all = await repo.scanAfter({ limit: 10 });
    expect(all).toHaveLength(4);
  });

  it('deletes only rows older than the cutoff, in batches', async () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    // 5 old rows (10 days ago) and 3 recent rows (1 hour ago).
    for (let i = 0; i < 5; i++) {
      await repo.append({ type: 'journal_event', ownerId: 'owner-1', botId: `old-${i}`, payload: {} });
      await setCreatedAt(`old-${i}`, new Date(now - 10 * dayMs));
    }
    for (let i = 0; i < 3; i++) {
      await repo.append({ type: 'journal_event', ownerId: 'owner-1', botId: `new-${i}`, payload: {} });
      await setCreatedAt(`new-${i}`, new Date(now - 60 * 60 * 1000));
    }

    const cutoff = new Date(now - dayMs); // 1 day ago → only the 10-day-old rows qualify
    // batchSize 2 forces multiple batches (5 old rows → 2 + 2 + 1).
    const deleted = await repo.deleteOlderThan(cutoff, 2);
    expect(deleted).toBe(5);

    const remaining = await repo.scanAfter({ limit: 100 });
    expect(remaining).toHaveLength(3);
    expect(remaining.every((r) => r.botId?.startsWith('new-'))).toBe(true);

    // Deleting again is a no-op (nothing older than the cutoff remains).
    expect(await repo.deleteOlderThan(cutoff, 2)).toBe(0);
  });
});
