import { describe, expect, it, vi } from 'vitest';
import { FillRepository, PositionRepository } from '../repositories.js';
import { PgJournal } from '../journal-pg.js';
import { bots, fills, positions, journalEvents } from '../schema/index.js';

/**
 * AUTHORED unit tests for the agent-scoped evidence loaders. The loader BODIES are
 * copied verbatim from herobids `agent-evidence-loaders.ts` (union of agent-native
 * + agent-owned-bot rows, time filters on both arms, positions `at` snapshot
 * post-filter). herobids has no unit test for these loaders (they were exercised
 * via the boundary), so these assertions pin the copied behaviour deterministically
 * without a live DB by driving the loaders with a mock `db`.
 *
 * The mock routes each `db.select(...).from(<table>).where(...)` to a canned row set
 * keyed by the drizzle table object passed to `.from()`. The bots-table select is the
 * inlined `loadAgentBotIds` query; the fills/positions/journalEvents selects are the
 * two union arms. WHERE predicates are drizzle SQL objects that a mock cannot
 * meaningfully execute, so the mock returns the row set the real query WOULD return
 * for the scenario, and the assertions verify the loader's post-query composition
 * (union order, empty-bot short-circuit, `at` snapshot filter).
 */

type Row = Record<string, unknown>;

/**
 * Build a mock db whose `select().from(table).where()` resolves to `rowsByTable`
 * for that table. When `select({...})` is called with a projection (the bots id
 * lookup), the same routing applies. Awaiting `.where(...)` yields the rows.
 */
function buildMockDb(rowsByTable: {
  bots?: Row[];
  fills?: Row[];
  positions?: Row[];
  journalEvents?: Row[];
}) {
  const routeFor = (table: unknown): Row[] => {
    if (table === bots) return rowsByTable.bots ?? [];
    if (table === fills) return rowsByTable.fills ?? [];
    if (table === positions) return rowsByTable.positions ?? [];
    if (table === journalEvents) return rowsByTable.journalEvents ?? [];
    return [];
  };

  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockImplementation((table: unknown) => ({
        where: vi.fn().mockImplementation(() => Promise.resolve(routeFor(table))),
      })),
    }),
  };

  return { db };
}

describe('FillRepository.loadAgentFills — copied union loader', () => {
  it('unions agent-native + agent-owned-bot fills', async () => {
    const { db } = buildMockDb({
      bots: [{ id: 'bot-1' }],
      // The mock returns the same set for both arms; assert both arms are concatenated.
      fills: [{ id: 'f-a', actorType: 'agent' }],
    });
    const repo = new FillRepository(db as never);

    const rows = await repo.loadAgentFills('agent-1');

    // Both arms resolve to the fills row set (agentBotIds non-empty → bot arm runs),
    // so the union has the agent arm followed by the bot arm.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ id: 'f-a', actorType: 'agent' });
    expect(rows[1]).toEqual({ id: 'f-a', actorType: 'agent' });
  });

  it('empty botIds → only the agent-native arm runs (bot arm short-circuits to [])', async () => {
    const { db } = buildMockDb({
      bots: [], // no agent-owned bots
      fills: [{ id: 'f-a' }],
    });
    const repo = new FillRepository(db as never);

    const rows = await repo.loadAgentFills('agent-1');

    // Only the agent arm contributes; the bot arm is Promise.resolve([]).
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ id: 'f-a' });
  });

  it('pre-resolved botIds skip the internal bot-id lookup', async () => {
    const { db } = buildMockDb({
      bots: [{ id: 'should-not-be-used' }],
      fills: [{ id: 'f-a' }],
    });
    const repo = new FillRepository(db as never);

    const rows = await repo.loadAgentFills('agent-1', { botIds: ['bot-99'] });

    // botIds provided → agentBotIds is non-empty without querying bots → both arms run.
    expect(rows).toHaveLength(2);
  });

  it('time filters do not change the union composition (bounds applied in WHERE)', async () => {
    const { db } = buildMockDb({
      bots: [{ id: 'bot-1' }],
      fills: [{ id: 'f-a' }],
    });
    const repo = new FillRepository(db as never);

    const rows = await repo.loadAgentFills('agent-1', {
      from: new Date('2024-01-01T00:00:00.000Z'),
      to: new Date('2024-02-01T00:00:00.000Z'),
    });

    // from/to are pushed into the WHERE predicate; the mock cannot evaluate SQL, so we
    // assert the loader still returns the union of both arms (no crash, both arms run).
    expect(rows).toHaveLength(2);
  });
});

describe('PositionRepository.loadAgentPositions — copied union + at snapshot', () => {
  it('unions agent-native + agent-owned-bot positions when no `at`', async () => {
    const { db } = buildMockDb({
      bots: [{ id: 'bot-1' }],
      positions: [{ id: 'p-a', openedAt: new Date('2024-01-01T00:00:00.000Z'), closedAt: null }],
    });
    const repo = new PositionRepository(db as never);

    const rows = await repo.loadAgentPositions('agent-1');

    expect(rows).toHaveLength(2);
  });

  it('empty botIds → only agent-native positions', async () => {
    const { db } = buildMockDb({
      bots: [],
      positions: [{ id: 'p-a', openedAt: new Date('2024-01-01T00:00:00.000Z'), closedAt: null }],
    });
    const repo = new PositionRepository(db as never);

    const rows = await repo.loadAgentPositions('agent-1');

    expect(rows).toHaveLength(1);
  });

  it('`at` snapshot keeps positions openedAt<=at AND (closedAt null OR closedAt>at)', async () => {
    const at = new Date('2024-06-01T00:00:00.000Z');
    const kept_open = {
      id: 'kept-open',
      openedAt: new Date('2024-05-01T00:00:00.000Z'),
      closedAt: null,
    };
    const kept_closedAfter = {
      id: 'kept-closed-after',
      openedAt: new Date('2024-05-01T00:00:00.000Z'),
      closedAt: new Date('2024-07-01T00:00:00.000Z'),
    };
    const dropped_notYetOpen = {
      id: 'dropped-future-open',
      openedAt: new Date('2024-07-01T00:00:00.000Z'),
      closedAt: null,
    };
    const dropped_closedBefore = {
      id: 'dropped-closed-before',
      openedAt: new Date('2024-05-01T00:00:00.000Z'),
      closedAt: new Date('2024-05-15T00:00:00.000Z'),
    };
    const dropped_closedAtBoundary = {
      id: 'dropped-closed-at-boundary',
      openedAt: new Date('2024-05-01T00:00:00.000Z'),
      closedAt: at, // closedAt > at is required to keep → equality is dropped
    };

    const { db } = buildMockDb({
      bots: [], // agent-native arm only to keep the row set single-sourced
      positions: [
        kept_open,
        kept_closedAfter,
        dropped_notYetOpen,
        dropped_closedBefore,
        dropped_closedAtBoundary,
      ],
    });
    const repo = new PositionRepository(db as never);

    const rows = await repo.loadAgentPositions('agent-1', { at });

    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(['kept-closed-after', 'kept-open']);
  });
});

describe('PgJournal.loadAgentJournalEvents — copied union loader', () => {
  it('unions agent-native + agent-owned-bot journal events', async () => {
    const { db } = buildMockDb({
      bots: [{ id: 'bot-1' }],
      journalEvents: [{ id: 'j-a' }],
    });
    const journal = new PgJournal(db as never);

    const rows = await journal.loadAgentJournalEvents('agent-1');

    expect(rows).toHaveLength(2);
  });

  it('empty botIds → only agent-native journal events', async () => {
    const { db } = buildMockDb({
      bots: [],
      journalEvents: [{ id: 'j-a' }],
    });
    const journal = new PgJournal(db as never);

    const rows = await journal.loadAgentJournalEvents('agent-1');

    expect(rows).toHaveLength(1);
  });

  it('pre-resolved botIds skip the internal bot-id lookup', async () => {
    const { db } = buildMockDb({
      bots: [{ id: 'should-not-be-used' }],
      journalEvents: [{ id: 'j-a' }],
    });
    const journal = new PgJournal(db as never);

    const rows = await journal.loadAgentJournalEvents('agent-1', { botIds: ['bot-99'] });

    expect(rows).toHaveLength(2);
  });
});
