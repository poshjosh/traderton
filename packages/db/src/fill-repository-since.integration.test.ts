import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import type { Database } from './index.js';
import { FillRepository } from './repositories.js';
import { openTestDb, truncate } from './test-helpers/integration-db.js';

const SKIP = !process.env['DATABASE_URL'];

describe.skipIf(SKIP)('FillRepository realized P&L since a timestamp (integration)', () => {
  let client: ReturnType<typeof postgres>;
  let repo: FillRepository;

  const fill = (realizedPnlDelta: string, filledAt: string, extra: { actorId?: string; venueAccountId?: string } = {}) =>
    repo.insertFill({
      orderId: `o-${filledAt}-${realizedPnlDelta}`,
      venueAccountId: extra.venueAccountId ?? 'va-1',
      actorType: 'agent',
      actorId: extra.actorId ?? 'agent-1',
      venue: 'hyperliquid',
      symbol: 'BTC-PERP',
      side: 'sell',
      quantity: '1',
      price: '50000',
      realizedPnlDelta,
      filledAt: new Date(filledAt),
    });

  beforeAll(() => {
    const handle = openTestDb();
    client = handle.client;
    repo = new FillRepository(handle.db as unknown as Database);
  });
  afterAll(async () => client.end());
  beforeEach(async () => truncate(client, 'fills'));

  it('sums only fills at or after the cutoff while the lifetime sum keeps every fill', async () => {
    await fill('200', '2026-01-01T00:00:00Z');
    await fill('-50', '2026-01-03T00:00:00Z');
    await fill('30', '2026-01-04T00:00:00Z');
    const since = new Date('2026-01-03T00:00:00Z');
    expect(Number(await repo.sumRealizedPnlDeltaByVenueAccountSince('agent', 'agent-1', 'va-1', since))).toBe(-20);
    expect(Number(await repo.sumRealizedPnlDeltaByVenueAccount('agent', 'agent-1', 'va-1'))).toBe(180);
  });

  it('returns zero when no fill falls in the window and ignores other actors and venue accounts', async () => {
    await fill('100', '2026-01-01T00:00:00Z');
    await fill('999', '2026-02-01T00:00:00Z', { actorId: 'agent-2' });
    await fill('999', '2026-02-01T00:00:00Z', { venueAccountId: 'va-2' });
    const since = new Date('2026-01-15T00:00:00Z');
    expect(Number(await repo.sumRealizedPnlDeltaByVenueAccountSince('agent', 'agent-1', 'va-1', since))).toBe(0);
  });
});
