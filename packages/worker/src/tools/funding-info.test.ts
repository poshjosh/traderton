import { describe, it, expect, vi } from 'vitest';
import type { TradingToolContext } from '@traderton/domain';
import { venueAccounts } from '@traderton/db';
import { provisioningTools } from './provisioning.js';

const getFundingInfoTool = provisioningTools.find((t) => t.name === 'get_funding_info')!;

const OWNER_ID = 'owner-1';
const VA_ID = 'va-1';

type Balance = { asset: string; free: string; locked: string; total: string };

interface FundingMockDbOpts {
  /** The owner-scoped account row (undefined = not found / unowned). */
  account?: { venueAccountRef: string | null; venue: string; label: string };
  /** The latest balance snapshot row (undefined = none recorded yet). */
  snapshot?: { balances: Balance[]; snapshotAt: Date };
}

// Routes by table: venue_accounts is read directly; balance_snapshots goes
// through BalanceSnapshotRepository's select→where→orderBy→limit chain.
function buildFundingMockDb(opts: FundingMockDbOpts) {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        if (table === venueAccounts) {
          return { where: vi.fn(() => Promise.resolve(opts.account ? [opts.account] : [])) };
        }
        return {
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve(opts.snapshot ? [opts.snapshot] : [])),
            })),
          })),
        };
      }),
    })),
  } as unknown as TradingToolContext['db'];
}

function makeFundingCtx(dbOpts: FundingMockDbOpts, overrides: Partial<TradingToolContext> = {}): TradingToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    ownerId: OWNER_ID,
    executionMode: 'paper',
    authorizationMode: 'direct',
    redis: {} as unknown as TradingToolContext['redis'],
    publishToInbound: vi.fn(async () => undefined),
    db: buildFundingMockDb(dbOpts),
    ...overrides,
  };
}

const SNAPSHOT_AT = new Date('2026-10-13T10:00:00.000Z');

describe('get_funding_info tool', () => {
  it('is registered as a read-database tool', () => {
    expect(getFundingInfoTool).toBeDefined();
    expect(getFundingInfoTool.category).toBe('read-database');
  });

  it('reports funded with address, network and balance when a positive balance is observed', async () => {
    const result = await getFundingInfoTool.execute(
      { venueAccountId: VA_ID },
      makeFundingCtx({
        account: { venueAccountRef: '0xWallet', venue: 'hyperliquid', label: 'HL Main' },
        snapshot: { balances: [{ asset: 'USDC', free: '250', locked: '0', total: '250' }], snapshotAt: SNAPSHOT_AT },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      ok: true,
      venueAccountId: VA_ID,
      venue: 'hyperliquid',
      label: 'HL Main',
      fundingAddress: '0xWallet',
      network: 'Hyperliquid',
      fundingStatus: 'funded',
      balance: {
        snapshotAt: '2026-10-13T10:00:00.000Z',
        balances: [{ asset: 'USDC', free: '250', locked: '0', total: '250' }],
      },
    });
  });

  it('reports unfunded when every observed balance is zero', async () => {
    const result = await getFundingInfoTool.execute(
      { venueAccountId: VA_ID },
      makeFundingCtx({
        account: { venueAccountRef: '0xWallet', venue: 'hyperliquid', label: 'HL Main' },
        snapshot: { balances: [{ asset: 'USDC', free: '0', locked: '0', total: '0' }], snapshotAt: SNAPSHOT_AT },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ fundingStatus: 'unfunded' });
  });

  it('reports unknown with a null balance when no snapshot has been recorded', async () => {
    const result = await getFundingInfoTool.execute(
      { venueAccountId: VA_ID },
      makeFundingCtx({
        account: { venueAccountRef: '0xWallet', venue: 'hyperliquid', label: 'HL Main' },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ fundingStatus: 'unknown', balance: null });
  });

  it('returns a null address and network when the venue has no mapped chain', async () => {
    const result = await getFundingInfoTool.execute(
      { venueAccountId: VA_ID },
      makeFundingCtx({ account: { venueAccountRef: null, venue: 'bybit', label: 'Bybit' } }),
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ fundingAddress: null, network: null });
  });

  it('returns not_found for an absent or unowned venue account', async () => {
    const result = await getFundingInfoTool.execute(
      { venueAccountId: 'nope' },
      makeFundingCtx({ account: undefined }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.fault).toBe(false);
      expect(result.errorCode).toBe('not_found.resource');
    }
  });

  it('fails read-tool style when direct db access is missing', async () => {
    const result = await getFundingInfoTool.execute(
      { venueAccountId: VA_ID },
      makeFundingCtx({ account: undefined }, { db: undefined }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.fault).toBe(false);
      expect(result.error).toBe('direct db access not available');
    }
  });

  it('fails read-tool style when owner scope is missing', async () => {
    const result = await getFundingInfoTool.execute(
      { venueAccountId: VA_ID },
      makeFundingCtx({ account: undefined }, { ownerId: '' }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.fault).toBe(false);
      expect(result.error).toBe('owner scope not available');
    }
  });
});
