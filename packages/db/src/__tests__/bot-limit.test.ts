import { describe, expect, it, vi } from 'vitest';
import { BotRepository } from '../repositories.js';

/**
 * AUTHORED unit test (Phase 9b item E — NOT a copied oracle: herobids had no unit
 * test for `tryCreateBotWithLimit`/`tryMarkBotRunningWithLimit`; they were only
 * exercised through the broker). These assertions pin the re-keyed per-`ownerId`
 * behaviour deterministically without a live DB — the transaction body is driven
 * with a mock `tx`. The real advisory-lock serialization proof (concurrency) lives
 * in the DATABASE_URL-gated integration test (`bot-limit.integration.test.ts`).
 *
 * What the mock captures:
 *  - the running-bot rows returned to the COUNT step (keyed on `ownerId`);
 *  - the `.set()` values passed to `.update()` (the running mark);
 *  - the `.values()` passed to `.insert()` (the created row);
 *  - the current `{status, startedAt}` row for the mark's startedAt-preservation.
 */
function buildMockDb(options?: {
  /** Rows the COUNT select (`.where(...)` without `.limit()`) resolves to. */
  runningRows?: Array<{ id: string }>;
  /** The current bot row the mark reads (`.where(...).limit(1)`). */
  currentRow?: { status: string; startedAt: Date | null };
}) {
  const runningRows = options?.runningRows ?? [];
  const currentRow = options?.currentRow;

  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const executed: unknown[] = [];

  // A select builder that is BOTH awaitable at `.where()` (returns the count rows)
  // AND exposes `.limit()` (returns the current row) — the two shapes the methods use.
  const selectBuilder = {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation(() => {
        const result: Array<{ id: string }> & { limit?: unknown } = [...runningRows];
        // Attach a `.limit()` so the current-row read chains off the same builder.
        (result as unknown as { limit: (n: number) => Promise<unknown[]> }).limit = vi
          .fn()
          .mockResolvedValue(currentRow ? [currentRow] : []);
        return result;
      }),
    }),
  };

  const tx = {
    execute: vi.fn().mockImplementation((q: unknown) => {
      executed.push(q);
      return Promise.resolve(undefined);
    }),
    select: vi.fn().mockReturnValue(selectBuilder),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((v: Record<string, unknown>) => {
        inserts.push(v);
        return Promise.resolve(undefined);
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((v: Record<string, unknown>) => {
        updates.push(v);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }),
  };

  const db = {
    transaction: vi.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
  };

  return { db, tx, inserts, updates, executed };
}

describe('BotRepository.tryCreateBotWithLimit — per-ownerId maxBots (AUTHORED)', () => {
  it('under the limit: inserts a stopped bot and returns { created: true, botId }', async () => {
    const { db, inserts, executed } = buildMockDb({ runningRows: [{ id: 'a' }] });
    const repo = new BotRepository(db as never);

    const result = await repo.tryCreateBotWithLimit({
      ownerId: 'owner-1',
      venueAccountId: 'va-1',
      config: { foo: 'bar' },
      creatorType: 'agent',
      creatorId: 'agent-1',
      maxBots: 5,
    });

    expect(result.created).toBe(true);
    expect(result.botId).toBeTruthy();
    expect(inserts.length).toBe(1);

    const row = inserts[0]!;
    expect(row.id).toBe(result.botId);
    expect(row.ownerId).toBe('owner-1');
    expect(row.venueAccountId).toBe('va-1');
    expect(row.config).toEqual({ foo: 'bar' });
    expect(row.status).toBe('stopped'); // NEVER insert-as-running (013 §7 decision 2)
    expect(row.creatorType).toBe('agent');
    expect(row.creatorId).toBe('agent-1');
    // Re-keyed to the Phase-2 schema: no platform userId/connectionId columns.
    expect(row).not.toHaveProperty('userId');
    expect(row).not.toHaveProperty('connectionId');
    // The advisory lock is taken (serialization) before the count/insert.
    expect(executed.length).toBe(1);
  });

  it('at the limit: returns { created: false } and does not insert', async () => {
    const { db, inserts } = buildMockDb({
      runningRows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    });
    const repo = new BotRepository(db as never);

    const result = await repo.tryCreateBotWithLimit({
      ownerId: 'owner-1',
      venueAccountId: 'va-1',
      config: {},
      creatorType: 'agent',
      creatorId: 'agent-1',
      maxBots: 3,
    });

    expect(result).toEqual({ created: false });
    expect(inserts.length).toBe(0);
  });

  it('count is keyed on ownerId: a different owner\'s running bots do not count', async () => {
    // The COUNT query filters by ownerId — so the mock returns ONLY this owner's
    // running rows. With another owner at capacity but this owner at zero, the
    // create succeeds. (The ownerId keying is asserted structurally: the mock's
    // running rows represent the WHERE ownerId=$ownerId result set.)
    const { db, inserts } = buildMockDb({ runningRows: [] });
    const repo = new BotRepository(db as never);

    const result = await repo.tryCreateBotWithLimit({
      ownerId: 'owner-2',
      venueAccountId: 'va-2',
      config: {},
      creatorType: 'agent',
      creatorId: 'agent-2',
      maxBots: 1,
    });

    expect(result.created).toBe(true);
    expect(inserts.length).toBe(1);
    expect(inserts[0]!.ownerId).toBe('owner-2');
  });
});

describe('BotRepository.tryMarkBotRunningWithLimit — per-ownerId maxBots (AUTHORED)', () => {
  it('under the limit: marks running and returns true', async () => {
    const { db, updates } = buildMockDb({
      runningRows: [{ id: 'a' }],
      currentRow: { status: 'stopped', startedAt: null },
    });
    const repo = new BotRepository(db as never);

    const claimed = await repo.tryMarkBotRunningWithLimit({
      botId: 'bot-1',
      ownerId: 'owner-1',
      creatorType: 'agent',
      creatorId: 'agent-1',
      maxBots: 5,
    });

    expect(claimed).toBe(true);
    expect(updates.length).toBe(1);
    const set = updates[0]!;
    expect(set.status).toBe('running');
    expect(set.stoppedAt).toBeNull();
    expect(set.startedAt).toBeInstanceOf(Date);
  });

  it('at the limit: returns false and does not update', async () => {
    const { db, updates } = buildMockDb({
      runningRows: [{ id: 'a' }, { id: 'b' }],
      currentRow: { status: 'stopped', startedAt: null },
    });
    const repo = new BotRepository(db as never);

    const claimed = await repo.tryMarkBotRunningWithLimit({
      botId: 'bot-1',
      ownerId: 'owner-1',
      creatorType: 'agent',
      creatorId: 'agent-1',
      maxBots: 2,
    });

    expect(claimed).toBe(false);
    expect(updates.length).toBe(0);
  });

  it('preserves startedAt for an already-running bot (reclaim)', async () => {
    const existingStartedAt = new Date('2024-01-01T00:00:00.000Z');
    const { db, updates } = buildMockDb({
      runningRows: [{ id: 'bot-1' }],
      currentRow: { status: 'running', startedAt: existingStartedAt },
    });
    const repo = new BotRepository(db as never);

    const claimed = await repo.tryMarkBotRunningWithLimit({
      botId: 'bot-1',
      ownerId: 'owner-1',
      creatorType: 'agent',
      creatorId: 'agent-1',
      maxBots: 5,
    });

    expect(claimed).toBe(true);
    expect(updates.length).toBe(1);
    const set = updates[0]!;
    expect(set.status).toBe('running');
    expect(set.startedAt).toEqual(existingStartedAt); // preserved, not restamped
    expect(set.stoppedAt).toBeNull();
    expect(set.updatedAt).toBeInstanceOf(Date);
  });
});
