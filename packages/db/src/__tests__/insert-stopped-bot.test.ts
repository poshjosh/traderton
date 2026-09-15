import { describe, expect, it, vi } from 'vitest';

import { BotRepository } from '../repositories.js';

/**
 * AUTHORED unit test (c4.9d-FG) — pins `BotRepository.insertStoppedBot`, the
 * copy-faithful blueprint-instantiate BOT-branch write moved behind a repo
 * method. It asserts the stopped-create contract deterministically without a
 * live DB: the caller-supplied id is persisted verbatim, the lineage columns are
 * written, status is 'stopped', and (unlike tryCreateBotWithLimit) NO advisory
 * lock / running-count / transaction is used — it is a single plain insert.
 */
function buildMockDb() {
  const inserts: Array<Record<string, unknown>> = [];
  const transactionCalls: unknown[] = [];

  const db = {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((v: Record<string, unknown>) => {
        inserts.push(v);
        return Promise.resolve(undefined);
      }),
    }),
    // Present so we can assert it is NOT used (no running-limit transaction).
    transaction: vi.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => {
      transactionCalls.push(cb);
      return cb(db);
    }),
  };

  return { db, inserts, transactionCalls };
}

describe('BotRepository.insertStoppedBot — caller-supplied id + lineage (AUTHORED)', () => {
  it('persists a stopped bot with the caller-supplied id and lineage columns', async () => {
    const { db, inserts, transactionCalls } = buildMockDb();
    const repo = new BotRepository(db as never);

    const result = await repo.insertStoppedBot({
      id: 'actor-123',
      ownerId: 'owner-1',
      venueAccountId: 'va-1',
      config: { symbol: 'BTC-USDC' },
      creatorType: 'user',
      creatorId: 'owner-1',
      blueprintId: 'bp-1',
      blueprintRevisionId: 'rev-1',
      configSnapshot: { source: 'payload' },
    });

    // Returns the caller-supplied id (NOT a generated one).
    expect(result).toEqual({ botId: 'actor-123' });

    expect(inserts.length).toBe(1);
    const row = inserts[0]!;
    expect(row.id).toBe('actor-123');
    expect(row.ownerId).toBe('owner-1');
    expect(row.venueAccountId).toBe('va-1');
    expect(row.config).toEqual({ symbol: 'BTC-USDC' });
    expect(row.status).toBe('stopped');
    expect(row.creatorType).toBe('user');
    expect(row.creatorId).toBe('owner-1');
    // Lineage columns written (the source persisted these).
    expect(row.blueprintId).toBe('bp-1');
    expect(row.blueprintRevisionId).toBe('rev-1');
    expect(row.configSnapshot).toEqual({ source: 'payload' });
    // createdAt/updatedAt stamped.
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
    // Decision-13: connectionId is dropped.
    expect(row).not.toHaveProperty('connectionId');
    // No running-limit transaction — a plain insert (instantiation creates a
    // stopped bot; the running-slot limit is enforced at start, not here).
    expect(transactionCalls.length).toBe(0);
  });
});
