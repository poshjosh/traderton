import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '@traderton/domain';
import { price } from '@traderton/domain';
import { EquityTracker } from '@traderton/engine';
import { BotRepository, type Database } from '@traderton/db';
import { accountTools } from './account.js';

const getAccountSummary = accountTools.find((t) => t.name === 'get_account_summary')!;

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'scout',
    executionMode: 'paper',
    redis: {
      hset: vi.fn(async () => 1),
      hget: vi.fn(async () => null),
      hgetall: vi.fn(async () => null),
      hdel: vi.fn(async () => 0),
      publish: vi.fn(async () => 0),
    },
    publishToInbound: vi.fn(async () => undefined),
    ...overrides,
  };
}

function mockPosition(overrides: Record<string, unknown> = {}) {
  return {
    actorType: 'agent',
    actorId: 'agent-1',
    symbol: 'BTC/USD:USD',
    side: 'long',
    size: '0.5',
    entryPrice: '50000',
    openedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

describe('get_account_summary', () => {
  // -------------------------------------------------------------------------
  // DB unavailable
  // -------------------------------------------------------------------------

  it('returns error when botRepo is unavailable', async () => {
    const ctx = makeCtx({ botRepo: undefined });

    const result = await getAccountSummary.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('account.db_unavailable');
  });

  // -------------------------------------------------------------------------
  // Happy path — full data
  // -------------------------------------------------------------------------

  it('returns capital, positions, risk limits and config when all deps are available', async () => {
    const ctx = makeCtx({
      botRepo: {
        getOpenPositionsByCreator: vi.fn(async () => [
          mockPosition({ actorType: 'agent', symbol: 'BTC/USD:USD' }),
          mockPosition({ actorType: 'bot', actorId: 'bot-1', symbol: 'ETH/USD:USD' }),
        ]),
      } as unknown as ToolContext['botRepo'],
      riskContractOps: {
        getContract: vi.fn(async () => ({
          maxOpenPositions: { effectiveValue: 5, source: 'user' },
          maxPositionSizePct: { effectiveValue: 25, source: 'default' },
          stopLossCooldownMs: { effectiveValue: 300000, source: 'default' },
        })),
      } as unknown as ToolContext['riskContractOps'],
      executionConfig: {
        getExecutionConfig: vi.fn(async () => ({
          mode: 'paper',
          positionSizeMode: 'percent_equity',
          fixedPositionSize: '100',
        })),
      } as unknown as ToolContext['executionConfig'],
      agentRepo: {
        getAgent: vi.fn(async () => ({ capital: '10000' })),
      } as unknown as ToolContext['agentRepo'],
      accountLedger: {
        venueAccountId: 'va-1',
        getLifetimeRealizedPnl: vi.fn(async () => '0'),
        getLatestVenueBalance: vi.fn(async () => null),
      },
    });

    const result = await getAccountSummary.execute({}, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.initialCapital).toBe('10000');
    expect(data).not.toHaveProperty('capital');
    expect(data.executionMode).toBe('paper');
    expect(data.positionSizeMode).toBe('percent_equity');
    expect(data.fixedPositionSize).toBe('100');
    expect(data.openPositionCount).toBe(2);
    expect(data.agentDirectPositions).toBe(1);
    expect(data.botManagedPositions).toBe(1);
    expect(data.riskLimits).toMatchObject({ maxOpenPositions: 5 });
    expect((data.riskLimits as Record<string, unknown>).stopLossPct).toBeUndefined();
    expect((data.riskLimits as Record<string, unknown>).stopLossPctSource).toBeUndefined();
    expect(data.guidance).toEqual(expect.stringContaining('initial allocation 10000 is not current funds'));
    // No price service in this ctx, so the open agent position stays unmarked.
    expect(data.warnings).toEqual(['unrealized_pnl_incomplete']);
  });

  // -------------------------------------------------------------------------
  // Partially available deps
  // -------------------------------------------------------------------------

  it('returns warnings when sub-dependencies are unavailable or fail', async () => {
    const ctx = makeCtx({
      botRepo: {
        getOpenPositionsByCreator: vi.fn(async () => []),
      } as unknown as ToolContext['botRepo'],
      riskContractOps: undefined,
      executionConfig: undefined,
      agentRepo: undefined,
    });

    const result = await getAccountSummary.execute({}, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.initialCapital).toBeNull();
    expect(data.equity).toBeNull();
    expect(data.executionMode).toBe('paper'); // falls back to ctx.executionMode
    expect(data.riskLimits).toBe('unavailable');
    const warnings = data.warnings as string[] | undefined;
    expect(warnings).toBeDefined();
    expect(warnings).toContain('risk_contract_unavailable');
    expect(warnings).toContain('agent_config_unavailable');
    expect(warnings).toContain('agent_repo_unavailable');
  });

  // -------------------------------------------------------------------------
  // Sub-dependency throws
  // -------------------------------------------------------------------------

  it('handles sub-dependency throwing gracefully', async () => {
    const ctx = makeCtx({
      botRepo: {
        getOpenPositionsByCreator: vi.fn(async () => []),
      } as unknown as ToolContext['botRepo'],
      riskContractOps: {
        getContract: vi.fn(async () => {
          throw new Error('Redis down');
        }),
      } as unknown as ToolContext['riskContractOps'],
      executionConfig: {
        getExecutionConfig: vi.fn(async () => {
          throw new Error('DB error');
        }),
      } as unknown as ToolContext['executionConfig'],
      agentRepo: {
        getAgent: vi.fn(async () => {
          throw new Error('DB timeout');
        }),
      } as unknown as ToolContext['agentRepo'],
    });

    const result = await getAccountSummary.execute({}, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.riskLimits).toBe('unavailable');
    const warnings = data.warnings as string[] | undefined;
    expect(warnings).toContain('risk_contract_unavailable');
    expect(warnings).toContain('agent_config_unavailable');
    expect(warnings).toContain('agent_repo_unavailable');
  });

  // -------------------------------------------------------------------------
  // Top-level error
  // -------------------------------------------------------------------------

  it('returns error when getOpenPositionsByCreator throws', async () => {
    const ctx = makeCtx({
      botRepo: {
        getOpenPositionsByCreator: vi.fn(async () => {
          throw new Error('DB connection lost');
        }),
      } as unknown as ToolContext['botRepo'],
    });

    const result = await getAccountSummary.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('account.summary_failed');
    expect(result.error).toContain('DB connection lost');
  });

  // -------------------------------------------------------------------------
  // No capital available
  // -------------------------------------------------------------------------

  it('provides safe guidance when capital is unavailable', async () => {
    const ctx = makeCtx({
      botRepo: {
        getOpenPositionsByCreator: vi.fn(async () => []),
      } as unknown as ToolContext['botRepo'],
      agentRepo: {
        getAgent: vi.fn(async () => null),
      } as unknown as ToolContext['agentRepo'],
    });

    const result = await getAccountSummary.execute({}, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.initialCapital).toBeNull();
    expect(data.equity).toBeNull();
    expect(data.guidance).toEqual(expect.stringContaining('Equity unavailable'));
  });
});

// ---------------------------------------------------------------------------
// Real figures: equity, P&L, marks
// ---------------------------------------------------------------------------
const VENUE_ACCOUNT_ID = 'va-1';

function priceServiceAt(prices: Record<string, number>) {
  return {
    getPrice: vi.fn(async (symbol: string) => {
      const priceUsd = prices[symbol];
      return priceUsd === undefined
        ? { ok: false, error: { code: 'price.not_found', message: 'no price' } }
        : { ok: true, data: { priceUsd, source: 'oracle' as const, fetchedAt: '2026-01-02T00:00:00.000Z', stale: false } };
    }),
    resolvePriceTarget: vi.fn(),
  } as unknown as ToolContext['priceService'];
}

function summaryCtx(opts: {
  capital?: string;
  realized?: string;
  positions?: Array<Record<string, unknown>>;
  prices?: Record<string, number>;
  mode?: 'paper' | 'shadow' | 'live';
  venueBalance?: unknown;
}): ToolContext {
  return makeCtx({
    executionMode: opts.mode ?? 'paper',
    botRepo: {
      getOpenPositionsByCreator: vi.fn(async () => opts.positions ?? []),
    } as unknown as ToolContext['botRepo'],
    agentRepo: {
      getAgent: vi.fn(async () => ({ capital: opts.capital ?? '10000' })),
    } as unknown as ToolContext['agentRepo'],
    accountLedger: {
      venueAccountId: VENUE_ACCOUNT_ID,
      getLifetimeRealizedPnl: vi.fn(async () => opts.realized ?? '0'),
      getLatestVenueBalance: vi.fn(async () => (opts.venueBalance ?? null) as never),
    },
    priceService: priceServiceAt(opts.prices ?? {}),
  });
}

async function summaryOf(ctx: ToolContext): Promise<Record<string, any>> {
  const result = await getAccountSummary.execute({}, ctx);
  expect(result.success).toBe(true);
  return result.data as Record<string, any>;
}

describe('get_account_summary real figures', () => {
  it('reports equity equal to initial capital before any trade', async () => {
    const data = await summaryOf(summaryCtx({ capital: '10000', realized: '0' }));
    expect(data).toMatchObject({
      initialCapital: '10000', lifetimeRealizedPnl: '0', unrealizedPnlUsd: '0',
      equity: '10000', availableCapital: '10000', marginUsed: '0',
    });
  });

  it('reports equity below initial capital after a realized loss', async () => {
    const data = await summaryOf(summaryCtx({ capital: '10000', realized: '-250.5' }));
    expect(data.equity).toBe('9749.5');
    expect(data.availableCapital).toBe('9749.5');
    expect(data.initialCapital).toBe('10000');
  });

  it('reports equity above initial capital after a realized win', async () => {
    const data = await summaryOf(summaryCtx({ capital: '10000', realized: '500' }));
    expect(data.equity).toBe('10500');
  });

  it('equals initial capital plus realized plus unrealized with an open marked position', async () => {
    const data = await summaryOf(summaryCtx({
      capital: '10000',
      realized: '-100',
      positions: [mockPosition({ symbol: 'BTC-PERP', venue: 'hyperliquid', size: '0.5', entryPrice: '50000', venueAccountId: VENUE_ACCOUNT_ID })],
      prices: { BTC: 52000 },
    }));
    expect(data.unrealizedPnlUsd).toBe('1000');
    expect(data.equity).toBe('10900');
    expect(data.marginUsed).toBe('26000');
    // Notional (26000) exceeds equity (10900): clamped at 0, never negative.
    expect(data.availableCapital).toBe('0');
    expect(data.marginBasis).toBe('notional_1x');
    expect(data.equityScope).toBe('agent_direct');
    expect(data.drawdownBasis).toBe('realized_peak');
    expect(data.positions[0]).toMatchObject({
      markPrice: '52000', unrealizedPnl: '1000', markedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(data.unrealizedComplete).toBe(true);
  });

  it('reports a short position unrealized loss when the mark rises', async () => {
    const data = await summaryOf(summaryCtx({
      positions: [mockPosition({ symbol: 'ETH-PERP', venue: 'hyperliquid', side: 'short', size: '2', entryPrice: '3000', venueAccountId: VENUE_ACCOUNT_ID })],
      prices: { ETH: 3100 },
    }));
    expect(data.unrealizedPnlUsd).toBe('-200');
    expect(data.equity).toBe('9800');
  });

  it('matches the risk gate equity tracker for the same inputs', async () => {
    const tracker = new EquityTracker(price('10000'), price('-400'));
    const gateEquity = tracker.currentEquity(price('150')).toFixed();
    const data = await summaryOf(summaryCtx({
      capital: '10000',
      realized: '-400',
      positions: [mockPosition({ symbol: 'BTC-PERP', venue: 'hyperliquid', size: '1', entryPrice: '50000', venueAccountId: VENUE_ACCOUNT_ID })],
      prices: { BTC: 50150 },
    }));
    expect(data.equity).toBe(gateEquity);
  });

  it('flags unrealized P&L as incomplete when a position cannot be marked', async () => {
    const data = await summaryOf(summaryCtx({
      positions: [mockPosition({ symbol: 'BTC-PERP', venue: 'hyperliquid', venueAccountId: VENUE_ACCOUNT_ID })],
      prices: {},
    }));
    expect(data.unrealizedComplete).toBe(false);
    expect(data.positions[0]).toMatchObject({ markPrice: null, unrealizedPnl: null });
    expect(data.warnings).toContain('unrealized_pnl_incomplete');
  });

  it('excludes positions of other venue accounts', async () => {
    const data = await summaryOf(summaryCtx({
      positions: [
        mockPosition({ symbol: 'BTC-PERP', venue: 'hyperliquid', venueAccountId: 'other-va' }),
      ],
      prices: { BTC: 60000 },
    }));
    expect(data.openPositionCount).toBe(0);
    expect(data.equity).toBe('10000');
  });

  it('filters venue accounts using positions produced by the real BotRepository', async () => {
    const row = (venueAccountId: string, symbol: string) => ({
      id: `pos-${symbol}`, venueAccountId, actorType: 'agent', actorId: 'agent-1', venue: 'hyperliquid',
      symbol, side: 'long', size: '1', entryPrice: '100', openedAt: new Date('2026-01-01'),
    });
    // Queue: bots-by-creator (none), then the positions select.
    const results: unknown[] = [[], [row(VENUE_ACCOUNT_ID, 'BTC-PERP'), row('other-va', 'ETH-PERP')]];
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'orderBy', 'limit']) chain[m] = () => chain;
    chain.then = (resolve: (v: unknown) => unknown) => resolve(results.shift());
    const botRepo = new BotRepository(chain as unknown as Database);

    const ctx = summaryCtx({});
    ctx.botRepo = botRepo as unknown as ToolContext['botRepo'];
    const data = await summaryOf(ctx);
    expect(data.positions.map((p: { symbol: string }) => p.symbol)).toEqual(['BTC-PERP']);
  });

  it('does not mark bot positions and excludes them from equity', async () => {
    const data = await summaryOf(summaryCtx({
      positions: [mockPosition({ actorType: 'bot', actorId: 'bot-1', symbol: 'BTC-PERP', venue: 'hyperliquid', venueAccountId: VENUE_ACCOUNT_ID })],
      prices: { BTC: 60000 },
    }));
    expect(data.positions[0]).toMatchObject({ markPrice: null, unrealizedPnl: null });
    expect(data.equity).toBe('10000');
    expect(data.unrealizedComplete).toBe(true);
  });

  it('reports null unrealizedComplete when equity inputs are missing', async () => {
    const ctx = summaryCtx({});
    ctx.accountLedger = undefined;
    const data = await summaryOf(ctx);
    expect(data.unrealizedComplete).toBeNull();
  });

  it('tracks drawdown from the realized-equity peak', async () => {
    const data = await summaryOf(summaryCtx({
      capital: '10000',
      realized: '0',
      positions: [mockPosition({ symbol: 'BTC-PERP', venue: 'hyperliquid', size: '1', entryPrice: '50000', venueAccountId: VENUE_ACCOUNT_ID })],
      prices: { BTC: 49000 },
    }));
    expect(data.drawdown).toEqual({ current: '1000', currentPct: '10', peakEquity: '10000' });
  });

  it('states funding is excluded and carries an asOf timestamp', async () => {
    const data = await summaryOf(summaryCtx({}));
    expect(data.fundingIncluded).toBe(false);
    expect(data.fundingNote).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(data.asOf))).toBe(false);
  });

  it('reports the venue balance separately in live mode without replacing availableCapital', async () => {
    const venueBalance = { snapshotAt: '2026-01-02T00:00:00.000Z', balances: [{ asset: 'USDC', free: '9000', locked: '0', total: '9000' }] };
    const data = await summaryOf(summaryCtx({ capital: '10000', realized: '-50', mode: 'live', venueBalance }));
    expect(data.venueBalance).toEqual(venueBalance);
    expect(data.availableCapital).toBe('9950');
  });

  it('omits the venue balance outside live mode', async () => {
    const data = await summaryOf(summaryCtx({ mode: 'paper', venueBalance: { snapshotAt: 'x', balances: [] } }));
    expect(data.venueBalance).toBeUndefined();
  });

  it('degrades to null equity with a warning when the ledger is unavailable', async () => {
    const ctx = summaryCtx({});
    ctx.accountLedger = undefined;
    const data = await summaryOf(ctx);
    expect(data.equity).toBeNull();
    expect(data.initialCapital).toBe('10000');
    expect(data.warnings).toContain('realized_pnl_unavailable');
  });
});

// ---------------------------------------------------------------------------
// count_venue_accounts (L3-P1b obligation-1 fix)
// ---------------------------------------------------------------------------

const countVenueAccounts = accountTools.find((t) => t.name === 'count_venue_accounts')!;

/** Build a ctx whose db.select().from().where() resolves to [{ value }]. */
function makeCountCtx(value: number, overrides: Partial<ToolContext> = {}): ToolContext {
  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ value }]),
      }),
    }),
  };
  return makeCtx({ ownerId: 'owner-1', db: db as unknown as ToolContext['db'], ...overrides });
}

describe('count_venue_accounts', () => {
  it('is a read-database tool', () => {
    expect(countVenueAccounts).toBeDefined();
    expect(countVenueAccounts.category).toBe('read-database');
  });

  it('returns the owner-scoped venue-account count', async () => {
    const result = await countVenueAccounts.execute({}, makeCountCtx(3));
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ count: 3 });
  });

  it('returns 0 when the owner has no venue accounts', async () => {
    const result = await countVenueAccounts.execute({}, makeCountCtx(0));
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ count: 0 });
  });

  it('fails closed when db is unavailable', async () => {
    const result = await countVenueAccounts.execute({}, makeCtx({ ownerId: 'owner-1', db: undefined }));
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('account.db_unavailable');
  });

  it('fails closed when owner identity is missing', async () => {
    const result = await countVenueAccounts.execute({}, makeCountCtx(1, { ownerId: '' }));
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('account.owner_unavailable');
  });
});
