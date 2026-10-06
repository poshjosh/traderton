import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '@traderton/domain';

// Import watch tools via dynamic import to test them isolated
// We must import the module's exported array after setting up mocks.
const { watchTools } = await import('./watch.js');

const watchTokenTool = watchTools.find((t) => t.name === 'watch_token')!;
const listWatchesTool = watchTools.find((t) => t.name === 'list_watches')!;
const removeWatchTool = watchTools.find((t) => t.name === 'remove_watch')!;
const checkWatchesTool = watchTools.find((t) => t.name === 'check_watches')!;

function okPrice(priceUsd: number, source: 'oracle' | 'execution' | 'cached' = 'oracle') {
  return {
    ok: true as const,
    data: {
      priceUsd,
      source,
      fetchedAt: new Date().toISOString(),
      stale: false,
    },
  };
}

function okResolve(symbol: string, chain: string, priceUsd: number, overrides?: Partial<{ address: string; source: 'oracle' | 'execution' | 'cached' }>) {
  return {
    ok: true as const,
    data: {
      symbol,
      chain,
      address: overrides?.address,
      priceUsd,
      source: overrides?.source ?? 'oracle',
      fetchedAt: new Date().toISOString(),
      stale: false,
    },
  };
}

function makeCtx(overrides: {
  redis?: Partial<ToolContext['redis']>;
  priceService?: ToolContext['priceService'] | null;
  instrumentRepo?: ToolContext['instrumentRepo'] | null;
  botRepo?: ToolContext['botRepo'] | null;
} = {}): ToolContext {
  const hstore = new Map<string, Record<string, string>>();
  const sets = new Map<string, Set<string>>();

  const redis: ToolContext['redis'] = {
    hset: vi.fn(async (key: string, field: string, value: string) => {
      if (!hstore.has(key)) hstore.set(key, {});
      hstore.get(key)![field] = value;
      return 1;
    }),
    hget: vi.fn(async (key: string, field: string) => hstore.get(key)?.[field] ?? null),
    hgetall: vi.fn(async (key: string) => hstore.get(key) ?? null),
    hdel: vi.fn(async (key: string, ...fields: string[]) => {
      const map = hstore.get(key);
      if (!map) return 0;
      let count = 0;
      for (const f of fields) {
        if (f in map) { delete map[f]; count++; }
      }
      return count;
    }),
    smembers: vi.fn(async (key: string) => [...(sets.get(key) ?? [])]),
    sadd: vi.fn(async (key: string, ...members: string[]) => {
      if (!sets.has(key)) sets.set(key, new Set());
      let added = 0;
      for (const m of members) {
        if (!sets.get(key)!.has(m)) { sets.get(key)!.add(m); added++; }
      }
      return added;
    }),
    srem: vi.fn(async (key: string, ...members: string[]) => {
      const s = sets.get(key);
      if (!s) return 0;
      let removed = 0;
      for (const m of members) { if (s.delete(m)) removed++; }
      return removed;
    }),
    expire: vi.fn().mockResolvedValue(1),
    publish: vi.fn().mockResolvedValue(1),
    ...overrides.redis,
  };

  return {
    agentId: 'agent-test-1',
    sessionId: 'session-test-1',
    phase: 'scout',
    executionMode: 'paper',
    redis,
    publishToInbound: vi.fn().mockResolvedValue(undefined),
    priceService: overrides.priceService === null ? undefined : overrides.priceService,
    instrumentRepo: overrides.instrumentRepo === null ? undefined : overrides.instrumentRepo,
    botRepo: overrides.botRepo === null ? undefined : overrides.botRepo,
  } as unknown as ToolContext;
}

describe('watch_token', () => {
  it('registers a watch and returns a watchId', async () => {
    const ctx = makeCtx();
    const result = await watchTokenTool.execute(
      { symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as { ok: boolean; watchId: string };
    expect(data.ok).toBe(true);
    expect(typeof data.watchId).toBe('string');
    expect(ctx.redis.hset).toHaveBeenCalledTimes(2);
  });

  it('refreshes the cached active watch summary after registration', async () => {
    const ctx = makeCtx();

    await watchTokenTool.execute(
      { symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' },
      ctx,
    );

    expect(ctx.redis.hset).toHaveBeenCalledWith(
      'agent:watches:summary:agent-test-1',
      'summary',
      expect.stringContaining('SOL (solana) above $200 status=unknown'),
    );
  });

  it('stores watch as JSON in the agent watches hash', async () => {
    const ctx = makeCtx();
    await watchTokenTool.execute(
      { symbol: 'BTC', chain: 'hyperliquid', thresholdPrice: 100_000, condition: 'above', note: 'ath watch' },
      ctx,
    );

    const hsetMock = ctx.redis.hset as ReturnType<typeof vi.fn>;
    const storedValue = JSON.parse(hsetMock.mock.calls[0][2] as string) as Record<string, unknown>;

    expect(storedValue).toMatchObject({
      symbol: 'BTC',
      chain: 'hyperliquid',
      thresholdPrice: 100_000,
      condition: 'above',
      note: 'ath watch',
    });
    expect(typeof storedValue['watchId']).toBe('string');
    expect(typeof storedValue['createdAt']).toBe('string');
  });

  it('rejects invalid symbol formats for the requested chain', async () => {
    const ctx = makeCtx();
    const result = await watchTokenTool.execute(
      { symbol: 'So11111111111111111111111111111111111111112', chain: 'ethereum', thresholdPrice: 1, condition: 'above' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('ethereum');
  });

  it('rejects unsupported chain values before storing a watch', async () => {
    const ctx = makeCtx();
    const result = await watchTokenTool.execute(
      { symbol: 'SOL', chain: 'optimism', thresholdPrice: 1, condition: 'above' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(ctx.redis.hset).not.toHaveBeenCalled();
  });

  it('rejects chain "any" when no price service is available', async () => {
    const ctx = makeCtx();
    const result = await watchTokenTool.execute(
      { symbol: 'SOL', chain: 'any', thresholdPrice: 1, condition: 'above' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot resolve "any" chain without a price service');
    expect(ctx.redis.hset).not.toHaveBeenCalled();
  });

  it('passes address-shaped symbol as address argument for identity-aware initial price', async () => {
    const evmAddress = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';
    const resolvePriceTarget = vi.fn().mockResolvedValue(okResolve(evmAddress, 'ethereum', 0.00001, { address: evmAddress }));
    const getPrice = vi.fn().mockResolvedValue(okPrice(0.00001));
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    await watchTokenTool.execute(
      { symbol: evmAddress, chain: 'ethereum', thresholdPrice: 0.001, condition: 'above' },
      ctx,
    );

    // Must pass address as 3rd arg so the price service resolves by identity
    expect(getPrice).toHaveBeenCalledWith(evmAddress, 'ethereum', evmAddress);
  });
});

describe('list_watches', () => {
  it('returns empty list when no watches exist', async () => {
    const ctx = makeCtx();
    const result = await listWatchesTool.execute({}, ctx);

    expect(result.success).toBe(true);
    expect((result.data as { watches: unknown[] }).watches).toHaveLength(0);
  });

  it('returns all registered watches sorted by createdAt', async () => {
    const ctx = makeCtx();
    await watchTokenTool.execute({ symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' }, ctx);
    await watchTokenTool.execute({ symbol: 'BTC', chain: 'hyperliquid', thresholdPrice: 90_000, condition: 'below' }, ctx);

    const result = await listWatchesTool.execute({}, ctx);

    expect(result.success).toBe(true);
    const data = result.data as { watches: Array<{ symbol: string }> };
    expect(data.watches).toHaveLength(2);
    expect(data.watches.map((w) => w.symbol)).toContain('SOL');
    expect(data.watches.map((w) => w.symbol)).toContain('BTC');
  });
});

describe('remove_watch', () => {
  it('removes a watch by ID', async () => {
    const ctx = makeCtx();
    const createResult = await watchTokenTool.execute(
      { symbol: 'WIF', chain: 'solana', thresholdPrice: 5, condition: 'above' },
      ctx,
    );
    const { watchId } = createResult.data as { watchId: string };

    const removeResult = await removeWatchTool.execute({ watchId }, ctx);

    expect(removeResult.success).toBe(true);
    expect((removeResult.data as { removed: boolean }).removed).toBe(true);

    const listResult = await listWatchesTool.execute({}, ctx);
    expect((listResult.data as { watches: unknown[] }).watches).toHaveLength(0);
  });

  it('refreshes the cached active watch summary after removal', async () => {
    const ctx = makeCtx();
    const createResult = await watchTokenTool.execute(
      { symbol: 'WIF', chain: 'solana', thresholdPrice: 5, condition: 'above' },
      ctx,
    );
    const { watchId } = createResult.data as { watchId: string };

    await removeWatchTool.execute({ watchId }, ctx);

    expect(ctx.redis.hdel).toHaveBeenCalledWith('agent:watches:summary:agent-test-1', 'summary');
  });

  it('returns failure for non-existent watch ID', async () => {
    const ctx = makeCtx();
    const result = await removeWatchTool.execute({ watchId: '00000000-0000-4000-8000-000000000000' }, ctx);

    expect(result.success).toBe(false);
  });
});

describe('check_watches', () => {
  it('returns error when price service is not configured', async () => {
    const ctx = makeCtx(); // no priceService
    await watchTokenTool.execute({ symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' }, ctx);

    const result = await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('price_service_not_configured');
  });

  it('returns empty triggered list when no watches exist', async () => {
    const getPrice = vi.fn().mockResolvedValue({ ok: false, error: { code: 'price.not_found', message: 'not found' } });
    const resolvePriceTarget = vi.fn().mockResolvedValue({ ok: false, error: { code: 'price.not_found', message: 'not found' } });
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    const result = await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    expect(result.success).toBe(true);
    expect((result.data as { triggered: unknown[] }).triggered).toHaveLength(0);
  });

  it('coerces string booleans for removeTriggered (LLM emits "false")', async () => {
    const getPrice = vi.fn().mockResolvedValue({ ok: false, error: { code: 'price.not_found', message: 'not found' } });
    const resolvePriceTarget = vi.fn().mockResolvedValue({ ok: false, error: { code: 'price.not_found', message: 'not found' } });
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    // A string "false" must round-trip through the schema as boolean false.
    const result = await checkWatchesTool.execute({ removeTriggered: 'false' as unknown as boolean }, ctx);

    expect(result.success).toBe(true);
    expect((result.data as { totalWatches: number }).totalWatches).toBe(0);
  });

  it('reports totalWatches: 0 when the agent has no watches', async () => {
    const getPrice = vi.fn().mockResolvedValue({ ok: false, error: { code: 'price.not_found', message: 'not found' } });
    const resolvePriceTarget = vi.fn().mockResolvedValue({ ok: false, error: { code: 'price.not_found', message: 'not found' } });
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    const result = await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    expect(result.success).toBe(true);
    expect((result.data as { totalWatches: number }).totalWatches).toBe(0);
  });

  it('detects "above" threshold crossing', async () => {
    const getPrice = vi.fn()
      .mockResolvedValueOnce(okPrice(150))
      .mockResolvedValueOnce(okPrice(250));
    const resolvePriceTarget = vi.fn().mockResolvedValue(okResolve('SOL', 'solana', 150));
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    await watchTokenTool.execute({ symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' }, ctx);
    const result = await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as { triggered: Array<{ symbol: string; currentPrice: number }> };
    expect(data.triggered).toHaveLength(1);
    expect(data.triggered[0]!.symbol).toBe('SOL');
    expect(data.triggered[0]!.currentPrice).toBe(250);
  });

  it('does not trigger immediately when a watch starts already above the threshold', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(okResolve('SOL', 'solana', 250));
    const getPrice = vi.fn()
      .mockResolvedValueOnce(okPrice(250))
      .mockResolvedValueOnce(okPrice(250));
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    await watchTokenTool.execute({ symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' }, ctx);
    const result = await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    const data = result.data as { triggered: unknown[] };
    expect(data.triggered).toHaveLength(0);
  });

  it('does not trigger "above" when price is at or below threshold', async () => {
    const getPrice = vi.fn()
      .mockResolvedValueOnce(okPrice(150))
      .mockResolvedValueOnce(okPrice(150));
    const resolvePriceTarget = vi.fn().mockResolvedValue(okResolve('SOL', 'solana', 150));
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    await watchTokenTool.execute({ symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' }, ctx);
    const result = await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    const data = result.data as { triggered: unknown[] };
    expect(data.triggered).toHaveLength(0);
  });

  it('detects "below" threshold crossing', async () => {
    const getPrice = vi.fn()
      .mockResolvedValueOnce(okPrice(70_000, 'execution'))
      .mockResolvedValueOnce(okPrice(50_000, 'execution'));
    const resolvePriceTarget = vi.fn().mockResolvedValue(okResolve('BTC', 'hyperliquid', 70_000));
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    await watchTokenTool.execute({ symbol: 'BTC', chain: 'hyperliquid', thresholdPrice: 60_000, condition: 'below' }, ctx);
    const result = await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    const data = result.data as { triggered: Array<{ symbol: string }> };
    expect(data.triggered).toHaveLength(1);
    expect(data.triggered[0]!.symbol).toBe('BTC');
  });

  it('removes triggered watches when removeTriggered is true', async () => {
    const getPrice = vi.fn()
      .mockResolvedValueOnce(okPrice(150))
      .mockResolvedValueOnce(okPrice(250));
    const resolvePriceTarget = vi.fn().mockResolvedValue(okResolve('SOL', 'solana', 150));
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    await watchTokenTool.execute({ symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' }, ctx);
    await checkWatchesTool.execute({ removeTriggered: true }, ctx);

    const listResult = await listWatchesTool.execute({}, ctx);
    expect((listResult.data as { watches: unknown[] }).watches).toHaveLength(0);
  });

  it('does not remove triggered watches when removeTriggered is false', async () => {
    const getPrice = vi.fn()
      .mockResolvedValueOnce(okPrice(150))
      .mockResolvedValueOnce(okPrice(250))
      .mockResolvedValueOnce(okPrice(250));
    const resolvePriceTarget = vi.fn().mockResolvedValue(okResolve('SOL', 'solana', 150));
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    await watchTokenTool.execute({ symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' }, ctx);
    const firstResult = await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    const listResult = await listWatchesTool.execute({}, ctx);
    expect((listResult.data as { watches: unknown[] }).watches).toHaveLength(1);

    const secondResult = await checkWatchesTool.execute({ removeTriggered: false }, ctx);
    expect((firstResult.data as { triggered: unknown[] }).triggered).toHaveLength(1);
    expect((secondResult.data as { triggered: unknown[] }).triggered).toHaveLength(0);
  });

  it('deduplicates price lookups for watches on the same symbol and chain', async () => {
    const getPriceMock = vi.fn()
      .mockResolvedValueOnce(okPrice(150))
      .mockResolvedValueOnce(okPrice(150))
      .mockResolvedValueOnce(okPrice(350));
    const resolvePriceTarget = vi.fn().mockResolvedValue(okResolve('SOL', 'solana', 150));
    const ctx = makeCtx({ priceService: { getPrice: getPriceMock, resolvePriceTarget } });

    // Two watches on the same symbol+chain
    await watchTokenTool.execute({ symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' }, ctx);
    await watchTokenTool.execute({ symbol: 'SOL', chain: 'solana', thresholdPrice: 300, condition: 'above' }, ctx);

    getPriceMock.mockClear();

    await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    // Should only fetch once for the same symbol+chain pair
    expect(getPriceMock).toHaveBeenCalledTimes(1);
  });

  it('preserves Solana mint casing when evaluating watches', async () => {
    const mint = 'So11111111111111111111111111111111111111112';
    let lookupCount = 0;
    const getPriceMock = vi.fn(async (symbol: string, chain: string) => {
      expect(symbol).toBe(mint);
      expect(chain).toBe('solana');
      lookupCount += 1;
      return lookupCount === 1 ? okPrice(150) : okPrice(250);
    });
    const resolvePriceTarget = vi.fn().mockResolvedValue(okResolve(mint, 'solana', 150));
    const ctx = makeCtx({ priceService: { getPrice: getPriceMock, resolvePriceTarget } });

    await watchTokenTool.execute({ symbol: mint, chain: 'solana', thresholdPrice: 200, condition: 'above' }, ctx);
    const result = await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    expect(result.success).toBe(true);
    expect(getPriceMock).toHaveBeenNthCalledWith(1, mint, 'solana', mint);
    expect(getPriceMock).toHaveBeenNthCalledWith(2, mint, 'solana', mint);
    expect((result.data as { triggered: Array<{ symbol: string }> }).triggered).toHaveLength(1);
  });

  it('places watches with unavailable prices in unchecked list', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(okResolve('UNKNOWN', 'solana', 0));
    const getPrice = vi.fn().mockResolvedValue({ ok: false, error: { code: 'price.not_found', message: 'not found' } });
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    await watchTokenTool.execute({ symbol: 'UNKNOWN', chain: 'solana', thresholdPrice: 1, condition: 'above' }, ctx);
    const result = await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    const data = result.data as { unchecked: Array<{ symbol: string; reason: string }> };
    expect(data.unchecked).toHaveLength(1);
    expect(data.unchecked[0]!.symbol).toBe('UNKNOWN');
  });

  it('surfaces edge-down (true → false) watchIds in data.reset', async () => {
    const getPrice = vi.fn()
      .mockResolvedValueOnce(okPrice(150))  // watch_token initial: below, not triggered
      .mockResolvedValueOnce(okPrice(250))  // check_watches #1: crosses above → triggered
      .mockResolvedValueOnce(okPrice(150)); // check_watches #2: falls back → reset
    const resolvePriceTarget = vi.fn().mockResolvedValue(okResolve('SOL', 'solana', 150));
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    const created = await watchTokenTool.execute(
      { symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' },
      ctx,
    );
    const watchId = (created.data as { watchId: string }).watchId;

    // Cross-up cycle: triggered (edge-up), no reset.
    const upResult = await checkWatchesTool.execute({ removeTriggered: false }, ctx);
    const upData = upResult.data as { triggered: Array<{ watchId: string }>; reset: string[] };
    expect(upData.triggered).toHaveLength(1);
    expect(upData.reset).toEqual([]);

    // Reset cycle: edge-down surfaces in reset, triggered is empty.
    const downResult = await checkWatchesTool.execute({ removeTriggered: false }, ctx);
    const downData = downResult.data as { triggered: unknown[]; reset: string[] };
    expect(downData.reset).toContain(watchId);
    expect(downData.triggered).toHaveLength(0);
  });

  it('returns an empty reset array on a cycle with no true → false transition', async () => {
    const getPrice = vi.fn()
      .mockResolvedValueOnce(okPrice(150))  // watch_token initial: below
      .mockResolvedValueOnce(okPrice(250))  // check_watches: crosses above → triggered, no reset
      .mockResolvedValueOnce(okPrice(260)); // check_watches: still above (true → true), no reset
    const resolvePriceTarget = vi.fn().mockResolvedValue(okResolve('SOL', 'solana', 150));
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    await watchTokenTool.execute(
      { symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' },
      ctx,
    );

    const firstResult = await checkWatchesTool.execute({ removeTriggered: false }, ctx);
    expect((firstResult.data as { reset: string[] }).reset).toEqual([]);

    const secondResult = await checkWatchesTool.execute({ removeTriggered: false }, ctx);
    expect((secondResult.data as { reset: string[] }).reset).toEqual([]);
  });
});

// ── Notified-set integration tests ───────────────────────────────────────
// The agent.ts scout gating uses a Redis SET (`agent:watches:notified:{agentId}`)
// to prevent a triggered watch from forcing escalation on every subsequent tick.
// check_watches clears the notified set when the condition resets (true → false),
// and remove_watch clears it on explicit removal.

describe('check_watches — notified set', () => {
  it('SREMs the notified set when a triggered watch condition resets (true → false)', async () => {
    const getPrice = vi.fn()
      .mockResolvedValueOnce(okPrice(150))  // watch_token initial: below, not triggered
      .mockResolvedValueOnce(okPrice(250))  // check_watches: crosses above → triggered
      .mockResolvedValueOnce(okPrice(150)); // check_watches: falls back → reset
    const resolvePriceTarget = vi.fn().mockResolvedValue(okResolve('SOL', 'solana', 150));
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    await watchTokenTool.execute(
      { symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' },
      ctx,
    );
    await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    // Verify it triggered
    const listAfterTrigger = (await listWatchesTool.execute({}, ctx)).data as { watches: Array<{ lastConditionMet: boolean }> };
    expect(listAfterTrigger.watches[0]!.lastConditionMet).toBe(true);

    // Reset: price falls back below
    await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    const listAfterReset = (await listWatchesTool.execute({}, ctx)).data as { watches: Array<{ lastConditionMet: boolean }> };
    expect(listAfterReset.watches[0]!.lastConditionMet).toBe(false);

    // Should have SREM'd from the notified set
    const sremCalls = (ctx.redis.srem as ReturnType<typeof vi.fn>).mock.calls;
    const notifiedCall = sremCalls.find(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('agent:watches:notified:'),
    );
    expect(notifiedCall).toBeDefined();
  });

  it('does NOT SREM the notified set when condition stays met (true → true)', async () => {
    const getPrice = vi.fn()
      .mockResolvedValueOnce(okPrice(150))
      .mockResolvedValueOnce(okPrice(250))
      .mockResolvedValueOnce(okPrice(260)); // still above
    const resolvePriceTarget = vi.fn().mockResolvedValue(okResolve('SOL', 'solana', 150));
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    await watchTokenTool.execute(
      { symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' },
      ctx,
    );
    await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    const sremCallsBefore = (ctx.redis.srem as ReturnType<typeof vi.fn>).mock.calls.length;
    await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    // No new SREM calls against the notified set
    const sremCallsAfter = (ctx.redis.srem as ReturnType<typeof vi.fn>).mock.calls;
    const newNotifiedSremCalls = sremCallsAfter.slice(sremCallsBefore).filter(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('agent:watches:notified:'),
    );
    expect(newNotifiedSremCalls).toHaveLength(0);
  });

  it('does NOT SREM the notified set when condition stays unmet (false → false)', async () => {
    const getPrice = vi.fn()
      .mockResolvedValueOnce(okPrice(150))
      .mockResolvedValueOnce(okPrice(140)) // still below
      .mockResolvedValueOnce(okPrice(130)); // still below
    const resolvePriceTarget = vi.fn().mockResolvedValue(okResolve('SOL', 'solana', 150));
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    await watchTokenTool.execute(
      { symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' },
      ctx,
    );
    await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    const sremCallsBefore = (ctx.redis.srem as ReturnType<typeof vi.fn>).mock.calls.length;
    await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    const sremCallsAfter = (ctx.redis.srem as ReturnType<typeof vi.fn>).mock.calls;
    const newNotifiedSremCalls = sremCallsAfter.slice(sremCallsBefore).filter(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('agent:watches:notified:'),
    );
    expect(newNotifiedSremCalls).toHaveLength(0);
  });
});

describe('remove_watch — notified set', () => {
  it('SREMs the watch ID from the notified set on removal', async () => {
    const ctx = makeCtx();
    const createResult = await watchTokenTool.execute(
      { symbol: 'WIF', chain: 'solana', thresholdPrice: 5, condition: 'above' },
      ctx,
    );
    const { watchId } = createResult.data as { watchId: string };

    await removeWatchTool.execute({ watchId }, ctx);

    // Should have called SREM on the notified set key with the watch ID
    const sremCalls = (ctx.redis.srem as ReturnType<typeof vi.fn>).mock.calls;
    const notifiedCall = sremCalls.find(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('agent:watches:notified:') && call[1] === watchId,
    );
    expect(notifiedCall).toBeDefined();
  });
});

// ── Discovery and pinning ────────────────────────────────────────────────

describe('watch_token — discovery and pinning', () => {
  it('resolves and stores pinned identity when chain is "any"', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('PEPE', 'solana', 0.00005, { address: '0xpepe_sol' }),
    );
    const getPrice = vi.fn(async (s: string, c: string) => {
      const r = await resolvePriceTarget(s, c);
      if (!r.ok) return r;
      return { ok: true as const, data: { priceUsd: r.data.priceUsd, source: r.data.source, fetchedAt: r.data.fetchedAt, stale: r.data.stale } };
    });
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    const result = await watchTokenTool.execute(
      { symbol: 'PEPE', chain: 'any', thresholdPrice: 0.001, condition: 'above' },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.symbol).toBe('PEPE');
    expect(data.chain).toBe('any');
    expect(data.resolvedChain).toBe('solana');
    expect(data.resolvedAddress).toBe('0xpepe_sol');

    // Verify stored watch has resolved fields
    const hsetCalls = (ctx.redis.hset as ReturnType<typeof vi.fn>).mock.calls;
    const watchCall = hsetCalls.find(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].startsWith('agent:watches:') && !(c[0] as string).includes('summary'),
    );
    const storedWatch = JSON.parse((watchCall as unknown[])[2] as string);
    expect(storedWatch.resolvedChain).toBe('solana');
    expect(storedWatch.resolvedAddress).toBe('0xpepe_sol');
    expect(storedWatch.chain).toBe('any');
  });

  it('with explicit chain also stores resolved address in the watch entry', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('PEPE', 'solana', 0.00005, { address: '0xpepe_sol' }),
    );
    const getPrice = vi.fn().mockResolvedValue(okPrice(0.00005));
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    const result = await watchTokenTool.execute(
      { symbol: 'PEPE', chain: 'solana', thresholdPrice: 0.001, condition: 'above' },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.symbol).toBe('PEPE');
    expect(data.chain).toBe('solana');
    expect(data.resolvedAddress).toBe('0xpepe_sol');

    // Stored watch should have the resolved address
    const hsetCalls = (ctx.redis.hset as ReturnType<typeof vi.fn>).mock.calls;
    const watchCall = hsetCalls.find(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].startsWith('agent:watches:') && !(c[0] as string).includes('summary'),
    );
    const storedWatch = JSON.parse((watchCall as unknown[])[2] as string);
    expect(storedWatch.resolvedAddress).toBe('0xpepe_sol');
    expect(storedWatch.chain).toBe('solana');
  });

  it('fails closed when resolution fails for chain "any"', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue({
      ok: false as const,
      error: { code: 'price.not_found', message: 'not found' },
    });
    const getPrice = vi.fn();
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    const result = await watchTokenTool.execute(
      { symbol: 'UNKNOWN', chain: 'any', thresholdPrice: 1, condition: 'above' },
      ctx,
    );

    expect(result.success).toBe(false);
    // The error message comes from resolution.error.message
    expect(result.error).toBe('not found');
    expect(ctx.redis.hset).not.toHaveBeenCalled();
  });

  it('fails closed when resolution fails for an explicit chain', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue({
      ok: false as const,
      error: { code: 'price.not_found', message: 'not found' },
    });
    const getPrice = vi.fn();
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    const result = await watchTokenTool.execute(
      { symbol: 'UNKNOWN', chain: 'solana', thresholdPrice: 1, condition: 'above' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('not found');
    expect(ctx.redis.hset).not.toHaveBeenCalled();
  });

  it('tool response includes both requested and resolved identity fields', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('PEPE', 'ethereum', 0.00004, { address: '0xeth_pepe' }),
    );
    const getPrice = vi.fn(async (s: string, c: string) => {
      const r = await resolvePriceTarget(s, c);
      if (!r.ok) return r;
      return { ok: true as const, data: { priceUsd: r.data.priceUsd, source: r.data.source, fetchedAt: r.data.fetchedAt, stale: r.data.stale } };
    });
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    const result = await watchTokenTool.execute(
      { symbol: 'PEPE', chain: 'any', thresholdPrice: 0.001, condition: 'above' },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    // Requested identity
    expect(data.symbol).toBe('PEPE');
    expect(data.chain).toBe('any');
    // Resolved identity — always stored, even when same as requested
    expect(data.resolvedSymbol).toBe('PEPE');
    expect(data.resolvedChain).toBe('ethereum');
    expect(data.resolvedAddress).toBe('0xeth_pepe');
  });
});

describe('check_watches — pinned identity repair', () => {
  it('uses pinned identity for repricing (does not drift)', async () => {
    // Create a watch pinned to solana PEPE
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('PEPE', 'solana', 0.00005, { address: '0xpepe_sol' }),
    );
    const getPrice = vi.fn()
      .mockResolvedValueOnce(okPrice(0.00005))   // initial price during watch_token
      .mockResolvedValueOnce(okPrice(0.00006));   // price during check_watches
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    await watchTokenTool.execute(
      { symbol: 'PEPE', chain: 'any', thresholdPrice: 0.001, condition: 'above' },
      ctx,
    );

    getPrice.mockClear();

    await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    // Must price against the pinned solana identity, not 'any'
    expect(getPrice).toHaveBeenCalledWith('PEPE', 'solana', '0xpepe_sol');
  });

  it('lazily repairs unpinned explicit-chain watch on first check', async () => {
    const watchId = '00000000-0000-4000-8000-000000000001';
    const unpinnedWatch = {
      watchId,
      symbol: 'PEPE',
      chain: 'solana',
      thresholdPrice: 0.001,
      condition: 'above',
      purpose: 'alert',
      createdAt: new Date().toISOString(),
      lastConditionMet: null,
      schemaVersion: 2,
    };

    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('PEPE', 'solana', 0.00005, { address: '0xpepe_sol' }),
    );
    const getPrice = vi.fn().mockResolvedValue(okPrice(0.00005));
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    // Insert unpinned watch directly (no resolved fields)
    await ctx.redis.hset(`agent:watches:${ctx.agentId}`, watchId, JSON.stringify(unpinnedWatch));

    await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    // Should have persisted the repaired watch back.
    // Use the LAST matching hset call — the initial insert comes first,
    // then the repair persist, then the status update.
    const hsetCalls = (ctx.redis.hset as ReturnType<typeof vi.fn>).mock.calls;
    const watchCalls = hsetCalls.filter(
      (c: unknown[]) =>
        typeof c[0] === 'string' && c[0].startsWith('agent:watches:') &&
        !(c[0] as string).includes('summary') && c[1] === watchId,
    );
    expect(watchCalls.length).toBeGreaterThanOrEqual(2); // initial insert + repair (or status update)
    const lastCall = watchCalls[watchCalls.length - 1]!;
    const repairedWatch = JSON.parse((lastCall as unknown[])[2] as string);
    expect(repairedWatch.resolvedChain).toBe('solana');
    expect(repairedWatch.resolvedAddress).toBe('0xpepe_sol');
    expect(repairedWatch.resolvedSymbol).toBe('PEPE');
    expect(repairedWatch.chain).toBe('solana');
  });

  it('lazily repairs unpinned chain="any" watch to explicit chain', async () => {
    const watchId = '00000000-0000-4000-8000-000000000002';
    const unpinnedWatch = {
      watchId,
      symbol: 'PEPE',
      chain: 'any',
      thresholdPrice: 0.001,
      condition: 'above',
      purpose: 'alert',
      createdAt: new Date().toISOString(),
      lastConditionMet: null,
      schemaVersion: 2,
    };

    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('PEPE', 'ethereum', 0.00004, { address: '0xeth_pepe' }),
    );
    const getPrice = vi.fn().mockResolvedValue(okPrice(0.00004));
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    await ctx.redis.hset(`agent:watches:${ctx.agentId}`, watchId, JSON.stringify(unpinnedWatch));

    await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    const hsetCalls = (ctx.redis.hset as ReturnType<typeof vi.fn>).mock.calls;
    const watchCalls = hsetCalls.filter(
      (c: unknown[]) =>
        typeof c[0] === 'string' && c[0].startsWith('agent:watches:') &&
        !(c[0] as string).includes('summary') && c[1] === watchId,
    );
    expect(watchCalls.length).toBeGreaterThanOrEqual(2);
    const lastCall = watchCalls[watchCalls.length - 1]!;
    const repairedWatch = JSON.parse((lastCall as unknown[])[2] as string);
    expect(repairedWatch.resolvedChain).toBe('ethereum');
    expect(repairedWatch.resolvedAddress).toBe('0xeth_pepe');
    expect(repairedWatch.chain).toBe('any');
  });

  it('returns unresolvable watch in unchecked list', async () => {
    const watchId = '00000000-0000-4000-8000-000000000003';
    const unpinnedWatch = {
      watchId,
      symbol: 'NONEXISTENT',
      chain: 'solana',
      thresholdPrice: 1,
      condition: 'above' as const,
      purpose: 'alert' as const,
      createdAt: new Date().toISOString(),
      lastConditionMet: null,
      schemaVersion: 2,
    };

    const resolvePriceTarget = vi.fn().mockResolvedValue({
      ok: false as const,
      error: { code: 'price.not_found', message: 'not found' },
    });
    const getPrice = vi.fn();
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    await ctx.redis.hset(`agent:watches:${ctx.agentId}`, watchId, JSON.stringify(unpinnedWatch));

    const result = await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as { unchecked: Array<{ watchId: string; symbol: string }> };
    expect(data.unchecked).toHaveLength(1);
    expect(data.unchecked[0]!.watchId).toBe(watchId);
    expect(data.unchecked[0]!.symbol).toBe('NONEXISTENT');
  });

  it('newly created "any" watch is fully pinned and does not re-resolve on first check', async () => {
    // The core regression this feature prevents: a watch created from 'any'
    // must be concrete from the start — not re-resolved on the first check.
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('PEPE', 'solana', 0.00005, { address: '0xpepe_sol' }),
    );
    const getPrice = vi.fn()
      .mockResolvedValueOnce(okPrice(0.00005))   // initial price during watch_token
      .mockResolvedValueOnce(okPrice(0.00006));   // price during check_watches
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    await watchTokenTool.execute(
      { symbol: 'PEPE', chain: 'any', thresholdPrice: 0.001, condition: 'above' },
      ctx,
    );

    // resolvePriceTarget called exactly once (during creation), not again.
    expect(resolvePriceTarget).toHaveBeenCalledTimes(1);
    resolvePriceTarget.mockClear();

    await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    // After creation, the watch is already pinned. check_watches must NOT
    // call resolvePriceTarget again for this watch.
    expect(resolvePriceTarget).not.toHaveBeenCalled();

    // Must price against the pinned solana identity, not 'any'.
    expect(getPrice).toHaveBeenCalledWith('PEPE', 'solana', '0xpepe_sol');
  });

  it('does not re-repair an already-pinned watch', async () => {
    const watchId = '00000000-0000-4000-8000-000000000004';
    const alreadyPinnedWatch = {
      watchId,
      symbol: 'PEPE',
      chain: 'any',
      resolvedSymbol: 'PEPE',
      resolvedChain: 'solana',
      resolvedAddress: '0xpepe_sol',
      address: '0xpepe_sol',
      thresholdPrice: 0.001,
      condition: 'above',
      createdAt: new Date().toISOString(),
      lastConditionMet: null,
    };

    const resolvePriceTarget = vi.fn(); // should NOT be called
    const getPrice = vi.fn().mockResolvedValue(okPrice(0.00005));
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    await ctx.redis.hset(`agent:watches:${ctx.agentId}`, watchId, JSON.stringify(alreadyPinnedWatch));

    await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    // Already pinned — resolvePriceTarget should NOT have been called
    expect(resolvePriceTarget).not.toHaveBeenCalled();
  });

  it('two same-symbol watches on different addresses produce separate lookups', async () => {
    // Newly created watches now always store resolvedSymbol, so they are fully
    // pinned from creation — ensurePinnedWatchIdentity will not re-resolve them.
    const resolvePriceTarget = vi.fn()
      .mockResolvedValueOnce(okResolve('PEPE', 'solana', 0.00005, { address: '0xfirst' }))   // watch_token #1
      .mockResolvedValueOnce(okResolve('PEPE', 'solana', 0.00005, { address: '0xsecond' }));  // watch_token #2
    const getPrice = vi.fn()
      .mockResolvedValueOnce(okPrice(0.00005))  // initial price watch 1
      .mockResolvedValueOnce(okPrice(0.00005))  // initial price watch 2
      .mockResolvedValueOnce(okPrice(0.00006))  // check_watches: first unique lookup
      .mockResolvedValueOnce(okPrice(0.00006)); // check_watches: second unique lookup
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    // Create two PEPE watches on same chain but different addresses
    await watchTokenTool.execute(
      { symbol: 'PEPE', chain: 'any', thresholdPrice: 0.001, condition: 'above' },
      ctx,
    );
    await watchTokenTool.execute(
      { symbol: 'PEPE', chain: 'any', thresholdPrice: 0.0009, condition: 'above' },
      ctx,
    );

    getPrice.mockClear();

    await checkWatchesTool.execute({ removeTriggered: false }, ctx);

    // Two distinct lookups — one per unique (chain, symbol, address) tuple
    expect(getPrice).toHaveBeenCalledTimes(2);
    const calls = (getPrice as ReturnType<typeof vi.fn>).mock.calls;
    const argSets = calls.map((c: unknown[]) => ({ symbol: c[0], chain: c[1], address: c[2] }));
    expect(argSets).toContainEqual({ symbol: 'PEPE', chain: 'solana', address: '0xfirst' });
    expect(argSets).toContainEqual({ symbol: 'PEPE', chain: 'solana', address: '0xsecond' });
  });
});

// ── Instrument identity resolution ────────────────────────────────────────
// The watch_token tool resolves canonical venue + instrumentId from the
// trading system's instrument repository. This is best-effort — watch
// creation does NOT fail if instrumentRepo is unavailable or returns no matches.

function makeInstrumentRow(overrides: Partial<{
  id: string;
  symbol: string;
  base: string;
  quote: string;
  type: string;
  venue: string;
  tickSize: string;
  lotSize: string;
}> = {}) {
  return {
    id: 'BTC-USD',
    symbol: 'BTC-USD',
    base: 'BTC',
    quote: 'USD',
    type: 'perpetual',
    venue: 'hyperliquid',
    tickSize: '0.1',
    lotSize: '0.001',
    ...overrides,
  };
}

describe('watch_token — instrument identity resolution', () => {
  it('resolves instrument identity when instrumentRepo returns a match', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('BTC-USD', 'hyperliquid', 60_000),
    );
    const getPrice = vi.fn().mockResolvedValue(okPrice(60_000));
    const search = vi.fn().mockResolvedValue([
      makeInstrumentRow({ id: 'BTC-USD', symbol: 'BTC-USD', venue: 'hyperliquid' }),
    ]);
    const ctx = makeCtx({
      priceService: { getPrice, resolvePriceTarget },
      instrumentRepo: { search },
    });

    const result = await watchTokenTool.execute(
      { symbol: 'BTC-USD', chain: 'hyperliquid', thresholdPrice: 70_000, condition: 'above' },
      ctx,
    );

    expect(result.success).toBe(true);

    // Verify instrument is in the tool response data
    const data = result.data as Record<string, unknown>;
    expect(data.instrument).toBeDefined();
    expect(data.instrument).toMatchObject({
      venue: 'hyperliquid',
      instrumentId: 'BTC-USD',
      symbol: 'BTC-USD',
    });

    // Verify instrument is persisted in the watch entry
    const hsetCalls = (ctx.redis.hset as ReturnType<typeof vi.fn>).mock.calls;
    const watchCall = hsetCalls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' && c[0].startsWith('agent:watches:') && !(c[0] as string).includes('summary'),
    );
    const storedWatch = JSON.parse((watchCall as unknown[])[2] as string);
    expect(storedWatch.instrument).toBeDefined();
    expect(storedWatch.instrument).toMatchObject({
      venue: 'hyperliquid',
      instrumentId: 'BTC-USD',
      symbol: 'BTC-USD',
    });
  });

  it('creates watch without instrument when instrumentRepo returns no matches', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('UNKNOWN', 'solana', 0.01),
    );
    const getPrice = vi.fn().mockResolvedValue(okPrice(0.01));
    const search = vi.fn().mockResolvedValue([]);
    const ctx = makeCtx({
      priceService: { getPrice, resolvePriceTarget },
      instrumentRepo: { search },
    });

    const result = await watchTokenTool.execute(
      { symbol: 'UNKNOWN', chain: 'solana', thresholdPrice: 1, condition: 'above' },
      ctx,
    );

    expect(result.success).toBe(true);

    // No instrument in tool response
    const data = result.data as Record<string, unknown>;
    expect(data.instrument).toBeUndefined();

    // No instrument in persisted watch
    const hsetCalls = (ctx.redis.hset as ReturnType<typeof vi.fn>).mock.calls;
    const watchCall = hsetCalls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' && c[0].startsWith('agent:watches:') && !(c[0] as string).includes('summary'),
    );
    const storedWatch = JSON.parse((watchCall as unknown[])[2] as string);
    expect(storedWatch.instrument).toBeUndefined();
  });

  it('creates watch without instrument when instrumentRepo.search throws (best-effort)', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('BTC-USD', 'hyperliquid', 60_000),
    );
    const getPrice = vi.fn().mockResolvedValue(okPrice(60_000));
    const search = vi.fn().mockRejectedValue(new Error('DB connection lost'));
    const ctx = makeCtx({
      priceService: { getPrice, resolvePriceTarget },
      instrumentRepo: { search },
    });

    const result = await watchTokenTool.execute(
      { symbol: 'BTC-USD', chain: 'hyperliquid', thresholdPrice: 70_000, condition: 'above' },
      ctx,
    );

    // Watch should still be created despite instrument repo error
    expect(result.success).toBe(true);

    // No instrument in tool response
    const data = result.data as Record<string, unknown>;
    expect(data.instrument).toBeUndefined();

    // No instrument in persisted watch
    const hsetCalls = (ctx.redis.hset as ReturnType<typeof vi.fn>).mock.calls;
    const watchCall = hsetCalls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' && c[0].startsWith('agent:watches:') && !(c[0] as string).includes('summary'),
    );
    const storedWatch = JSON.parse((watchCall as unknown[])[2] as string);
    expect(storedWatch.instrument).toBeUndefined();
  });

  it('creates watch without instrument when instrumentRepo is undefined on ToolContext', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('BTC-USD', 'hyperliquid', 60_000),
    );
    const getPrice = vi.fn().mockResolvedValue(okPrice(60_000));
    const ctx = makeCtx({
      priceService: { getPrice, resolvePriceTarget },
      instrumentRepo: null, // explicitly null → undefined on context
    });

    const result = await watchTokenTool.execute(
      { symbol: 'BTC-USD', chain: 'hyperliquid', thresholdPrice: 70_000, condition: 'above' },
      ctx,
    );

    // Watch should be created successfully without instrument
    expect(result.success).toBe(true);

    // No instrument in tool response
    const data = result.data as Record<string, unknown>;
    expect(data.instrument).toBeUndefined();

    // No instrument in persisted watch
    const hsetCalls = (ctx.redis.hset as ReturnType<typeof vi.fn>).mock.calls;
    const watchCall = hsetCalls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' && c[0].startsWith('agent:watches:') && !(c[0] as string).includes('summary'),
    );
    const storedWatch = JSON.parse((watchCall as unknown[])[2] as string);
    expect(storedWatch.instrument).toBeUndefined();
  });
});

// ── Purpose and coverage metadata ────────────────────────────────────────

describe('watch_token — purpose', () => {
  it('creates a watch with an explicit purpose', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('SOL', 'solana', 150),
    );
    const getPrice = vi.fn().mockResolvedValue(okPrice(150));
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    const result = await watchTokenTool.execute(
      { symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above', purpose: 'entry' },
      ctx,
    );

    expect(result.success).toBe(true);

    // Purpose in tool response
    const data = result.data as Record<string, unknown>;
    expect(data.purpose).toBe('entry');

    // Purpose in persisted watch
    const hsetCalls = (ctx.redis.hset as ReturnType<typeof vi.fn>).mock.calls;
    const watchCall = hsetCalls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' && c[0].startsWith('agent:watches:') && !(c[0] as string).includes('summary'),
    );
    const storedWatch = JSON.parse((watchCall as unknown[])[2] as string);
    expect(storedWatch.purpose).toBe('entry');
  });

  it('defaults purpose to "alert" when not specified', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('SOL', 'solana', 150),
    );
    const getPrice = vi.fn().mockResolvedValue(okPrice(150));
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    const result = await watchTokenTool.execute(
      { symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' },
      ctx,
    );

    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    expect(data.purpose).toBe('alert');

    const hsetCalls = (ctx.redis.hset as ReturnType<typeof vi.fn>).mock.calls;
    const watchCall = hsetCalls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' && c[0].startsWith('agent:watches:') && !(c[0] as string).includes('summary'),
    );
    const storedWatch = JSON.parse((watchCall as unknown[])[2] as string);
    expect(storedWatch.purpose).toBe('alert');
    expect(storedWatch.schemaVersion).toBe(2);

    // Verify the persisted record round-trips through parseWatch cleanly.
    const { parseWatch } = await import('../watch-types.js');
    const reparsed = parseWatch(JSON.stringify(storedWatch));
    expect(reparsed).not.toBeNull();
    expect(reparsed!.purpose).toBe('alert');
  });

  it.each([
    'entry',
    'exit',
    'stop_loss',
    'take_profit',
    'monitor',
    'alert',
  ] as const)('accepts purpose "%s"', async (purpose) => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('SOL', 'solana', 150),
    );
    const getPrice = vi.fn().mockResolvedValue(okPrice(150));
    // Protective purposes need either instrument identity or coverage linkage.
    // Provide instrument identity via instrumentRepo so the fail-closed check passes.
    const ctx = makeCtx({
      priceService: { getPrice, resolvePriceTarget },
      instrumentRepo: {
        search: vi.fn().mockResolvedValue([
          makeInstrumentRow({ id: 'SOL-USDC', symbol: 'SOL', venue: 'jupiter' }),
        ]),
      },
    });

    const result = await watchTokenTool.execute(
      { symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above', purpose },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.purpose).toBe(purpose);
  });
});

describe('watch_token — coverage', () => {
  it('creates a watch with full coverage metadata (positionKey derived by worker)', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('BTC-USD', 'hyperliquid', 60_000),
    );
    const getPrice = vi.fn().mockResolvedValue(okPrice(60_000));
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    const coverage = {
      actorType: 'agent' as const,
      actorId: 'agent-1',
      intentGroup: 'momentum-entry',
    };

    const result = await watchTokenTool.execute(
      {
        symbol: 'BTC-USD',
        chain: 'hyperliquid',
        thresholdPrice: 70_000,
        condition: 'above',
        purpose: 'entry',
        coverage,
      },
      ctx,
    );

    expect(result.success).toBe(true);

    // Coverage in tool response — positionKey is NOT accepted as input;
    // the worker derives it from targetPosition (not provided here).
    const data = result.data as Record<string, unknown>;
    const returnedCoverage = data.coverage as Record<string, unknown> | undefined;
    expect(returnedCoverage).toBeDefined();
    expect(returnedCoverage!.actorType).toBe('agent');
    expect(returnedCoverage!.actorId).toBe('agent-1');
    expect(returnedCoverage!.intentGroup).toBe('momentum-entry');
    expect(returnedCoverage!.positionKey).toBeUndefined();

    // Coverage in persisted watch
    const hsetCalls = (ctx.redis.hset as ReturnType<typeof vi.fn>).mock.calls;
    const watchCall = hsetCalls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' && c[0].startsWith('agent:watches:') && !(c[0] as string).includes('summary'),
    );
    const storedWatch = JSON.parse((watchCall as unknown[])[2] as string);
    expect(storedWatch.coverage).toBeDefined();
    expect(storedWatch.coverage.positionKey).toBeUndefined();
  });

  it('rejects raw positionKey in coverage (worker owns the linkage contract)', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('SOL', 'solana', 150),
    );
    const getPrice = vi.fn().mockResolvedValue(okPrice(150));
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    // positionKey is no longer in the schema — it will be silently stripped.
    // The coverage object with only positionKey becomes empty.
    const coverage = { positionKey: 'SOL-USD-short' } as Record<string, unknown>;

    const result = await watchTokenTool.execute(
      {
        symbol: 'SOL',
        chain: 'solana',
        thresholdPrice: 100,
        condition: 'below',
        coverage,
      } as unknown as Record<string, unknown>,
      ctx,
    );

    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    // coverage with only positionKey becomes empty and may be omitted
    const returnedCoverage = data.coverage as Record<string, unknown> | undefined;
    expect(returnedCoverage?.positionKey).toBeUndefined();

    const hsetCalls = (ctx.redis.hset as ReturnType<typeof vi.fn>).mock.calls;
    const watchCall = hsetCalls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' && c[0].startsWith('agent:watches:') && !(c[0] as string).includes('summary'),
    );
    const storedWatch = JSON.parse((watchCall as unknown[])[2] as string);
    expect(storedWatch.coverage?.positionKey).toBeUndefined();
  });

  it('creates a watch without coverage', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('SOL', 'solana', 150),
    );
    const getPrice = vi.fn().mockResolvedValue(okPrice(150));
    const ctx = makeCtx({ priceService: { getPrice, resolvePriceTarget } });

    const result = await watchTokenTool.execute(
      { symbol: 'SOL', chain: 'solana', thresholdPrice: 200, condition: 'above' },
      ctx,
    );

    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    expect(data.coverage).toBeUndefined();

    const hsetCalls = (ctx.redis.hset as ReturnType<typeof vi.fn>).mock.calls;
    const watchCall = hsetCalls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' && c[0].startsWith('agent:watches:') && !(c[0] as string).includes('summary'),
    );
    const storedWatch = JSON.parse((watchCall as unknown[])[2] as string);
    expect(storedWatch.coverage).toBeUndefined();
  });

  // ── Auto-link protective watches ───────────────────────────────────

  it('auto-links a protective watch to a single matching open position', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('BTC-USD', 'hyperliquid', 60_000),
    );
    const getPrice = vi.fn().mockResolvedValue(okPrice(60_000));
    const getOpenPositions = vi.fn().mockResolvedValue([
      {
        actorType: 'agent',
        actorId: 'agent-test-1',
        venue: 'hyperliquid',
        instrumentId: 'BTC-USD',
        symbol: 'BTC',
        side: 'long',
        size: '0.008',
        entryPrice: '62825',
        openedAt: new Date(),
      },
    ]);
    const ctx = makeCtx({
      priceService: { getPrice, resolvePriceTarget },
      instrumentRepo: {
        search: vi.fn().mockResolvedValue([
          makeInstrumentRow({ id: 'BTC-USD', symbol: 'BTC-USD', venue: 'hyperliquid' }),
        ]),
      },
      botRepo: { getOpenPositionsByCreator: getOpenPositions } as unknown as ToolContext['botRepo'],
    });

    const result = await watchTokenTool.execute(
      { symbol: 'BTC-USD', chain: 'hyperliquid', thresholdPrice: 70_000, condition: 'above', purpose: 'take_profit' },
      ctx,
    );

    expect(result.success).toBe(true);

    const hsetCalls = (ctx.redis.hset as ReturnType<typeof vi.fn>).mock.calls;
    const watchCall = hsetCalls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' && c[0].startsWith('agent:watches:') && !(c[0] as string).includes('summary'),
    );
    const storedWatch = JSON.parse((watchCall as unknown[])[2] as string);
    expect(storedWatch.coverage).toBeDefined();
    expect(storedWatch.coverage.positionKey).toBe('hyperliquid::BTC-USD::long');
  });

  it('auto-links using instrumentId when available (canonical identity)', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('BTC-USD', 'hyperliquid', 60_000),
    );
    const getPrice = vi.fn().mockResolvedValue(okPrice(60_000));
    const getOpenPositions = vi.fn().mockResolvedValue([
      {
        actorType: 'agent',
        actorId: 'agent-test-1',
        venue: 'hyperliquid',
        instrumentId: 'BTC-USD-PERP',
        symbol: 'BTC-PERP',
        side: 'long',
        size: '0.008',
        entryPrice: '62825',
        openedAt: new Date(),
      },
    ]);
    const ctx = makeCtx({
      priceService: { getPrice, resolvePriceTarget },
      instrumentRepo: {
        search: vi.fn().mockResolvedValue([
          makeInstrumentRow({ id: 'BTC-USD-PERP', symbol: 'BTC-USD', venue: 'hyperliquid' }),
        ]),
      },
      botRepo: { getOpenPositionsByCreator: getOpenPositions } as unknown as ToolContext['botRepo'],
    });

    const result = await watchTokenTool.execute(
      { symbol: 'BTC-USD', chain: 'hyperliquid', thresholdPrice: 70_000, condition: 'above', purpose: 'stop_loss' },
      ctx,
    );

    expect(result.success).toBe(true);
    const hsetCalls = (ctx.redis.hset as ReturnType<typeof vi.fn>).mock.calls;
    const watchCall = hsetCalls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' && c[0].startsWith('agent:watches:') && !(c[0] as string).includes('summary'),
    );
    const storedWatch = JSON.parse((watchCall as unknown[])[2] as string);
    // instrumentId matching wins: the position has BTC-USD-PERP but the
    // instrument repo resolved the same instrumentId, so it matches.
    expect(storedWatch.coverage.positionKey).toBe('hyperliquid::BTC-USD-PERP::long');
  });

  it('exact canonical instrumentId auto-link succeeds for stop_loss', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('BTC-USD', 'hyperliquid', 60_000),
    );
    const getPrice = vi.fn().mockResolvedValue(okPrice(60_000));
    const getOpenPositions = vi.fn().mockResolvedValue([
      {
        actorType: 'agent',
        actorId: 'agent-test-1',
        venue: 'hyperliquid',
        instrumentId: 'BTC-USD',
        symbol: 'BTC',
        side: 'long',
        size: '0.008',
        entryPrice: '62825',
        openedAt: new Date(),
      },
    ]);
    const ctx = makeCtx({
      priceService: { getPrice, resolvePriceTarget },
      instrumentRepo: {
        search: vi.fn().mockResolvedValue([
          makeInstrumentRow({ id: 'BTC-USD', symbol: 'BTC-USD', venue: 'hyperliquid' }),
        ]),
      },
      botRepo: { getOpenPositionsByCreator: getOpenPositions } as unknown as ToolContext['botRepo'],
    });

    const result = await watchTokenTool.execute(
      { symbol: 'BTC-USD', chain: 'hyperliquid', thresholdPrice: 70_000, condition: 'above', purpose: 'stop_loss' },
      ctx,
    );

    // Exact canonical instrumentId match — auto-links successfully.
    expect(result.success).toBe(true);
    const hsetCalls = (ctx.redis.hset as ReturnType<typeof vi.fn>).mock.calls;
    const watchCall = hsetCalls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' && c[0].startsWith('agent:watches:') && !(c[0] as string).includes('summary'),
    );
    const storedWatch = JSON.parse((watchCall as unknown[])[2] as string);
    expect(storedWatch.coverage.positionKey).toBe('hyperliquid::BTC-USD::long');
  });

  it('rejects protective watch when instrumentId mismatch cannot be resolved (no symbol fallback)', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('BTC-USD', 'hyperliquid', 60_000),
    );
    const getPrice = vi.fn().mockResolvedValue(okPrice(60_000));
    const getOpenPositions = vi.fn().mockResolvedValue([
      {
        actorType: 'agent',
        actorId: 'agent-test-1',
        venue: 'hyperliquid',
        instrumentId: 'BTC-DIFFERENT-ID',
        symbol: 'BTC-USD',
        side: 'long',
        size: '0.008',
        entryPrice: '62825',
        openedAt: new Date(),
      },
    ]);
    const ctx = makeCtx({
      priceService: { getPrice, resolvePriceTarget },
      instrumentRepo: {
        search: vi.fn().mockResolvedValue([
          makeInstrumentRow({ id: 'BTC-USD', symbol: 'BTC-USD', venue: 'hyperliquid' }),
        ]),
      },
      botRepo: { getOpenPositionsByCreator: getOpenPositions } as unknown as ToolContext['botRepo'],
    });

    const result = await watchTokenTool.execute(
      { symbol: 'BTC-USD', chain: 'hyperliquid', thresholdPrice: 70_000, condition: 'above', purpose: 'stop_loss' },
      ctx,
    );

    // No symbol fallback — canonical instrumentId mismatch must be rejected.
    expect(result.success).toBe(false);
    expect(result.error).toContain('instrumentId');
  });

  it('rejects protective watch when no open position matches (zero matches)', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('BTC-USD', 'hyperliquid', 60_000),
    );
    const getPrice = vi.fn().mockResolvedValue(okPrice(60_000));
    const getOpenPositions = vi.fn().mockResolvedValue([]);
    const ctx = makeCtx({
      priceService: { getPrice, resolvePriceTarget },
      instrumentRepo: {
        search: vi.fn().mockResolvedValue([
          makeInstrumentRow({ id: 'BTC-USD', symbol: 'BTC-USD', venue: 'hyperliquid' }),
        ]),
      },
      botRepo: { getOpenPositionsByCreator: getOpenPositions } as unknown as ToolContext['botRepo'],
    });

    const result = await watchTokenTool.execute(
      { symbol: 'BTC-USD', chain: 'hyperliquid', thresholdPrice: 70_000, condition: 'above', purpose: 'stop_loss' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('No open position found');
  });

  it('rejects protective watch when multiple positions match (ambiguous)', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('BTC-USD', 'hyperliquid', 60_000),
    );
    const getPrice = vi.fn().mockResolvedValue(okPrice(60_000));
    const getOpenPositions = vi.fn().mockResolvedValue([
      {
        actorType: 'agent',
        actorId: 'agent-test-1',
        venue: 'hyperliquid',
        instrumentId: 'BTC-USD',
        symbol: 'BTC-USD',
        side: 'long',
        size: '0.008',
        entryPrice: '62825',
        openedAt: new Date(),
      },
      {
        actorType: 'agent',
        actorId: 'agent-test-1',
        venue: 'hyperliquid',
        instrumentId: 'BTC-USD',
        symbol: 'BTC-USD',
        side: 'short',
        size: '0.002',
        entryPrice: '63000',
        openedAt: new Date(),
      },
    ]);
    const ctx = makeCtx({
      priceService: { getPrice, resolvePriceTarget },
      instrumentRepo: {
        search: vi.fn().mockResolvedValue([
          makeInstrumentRow({ id: 'BTC-USD', symbol: 'BTC-USD', venue: 'hyperliquid' }),
        ]),
      },
      botRepo: { getOpenPositionsByCreator: getOpenPositions } as unknown as ToolContext['botRepo'],
    });

    const result = await watchTokenTool.execute(
      { symbol: 'BTC-USD', chain: 'hyperliquid', thresholdPrice: 70_000, condition: 'above', purpose: 'stop_loss' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Ambiguous target');
  });

  it('skips auto-link for non-protective purposes', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('BTC-USD', 'hyperliquid', 60_000),
    );
    const getPrice = vi.fn().mockResolvedValue(okPrice(60_000));
    const getOpenPositions = vi.fn().mockResolvedValue([
      {
        actorType: 'agent',
        actorId: 'agent-test-1',
        venue: 'hyperliquid',
        instrumentId: 'BTC-USD',
        symbol: 'BTC-USD',
        side: 'long',
        size: '0.008',
        entryPrice: '62825',
        openedAt: new Date(),
      },
    ]);
    const ctx = makeCtx({
      priceService: { getPrice, resolvePriceTarget },
      instrumentRepo: {
        search: vi.fn().mockResolvedValue([
          makeInstrumentRow({ id: 'BTC-USD', symbol: 'BTC-USD', venue: 'hyperliquid' }),
        ]),
      },
      botRepo: { getOpenPositionsByCreator: getOpenPositions } as unknown as ToolContext['botRepo'],
    });

    const result = await watchTokenTool.execute(
      { symbol: 'BTC-USD', chain: 'hyperliquid', thresholdPrice: 70_000, condition: 'above', purpose: 'monitor' },
      ctx,
    );

    expect(result.success).toBe(true);
    const hsetCalls = (ctx.redis.hset as ReturnType<typeof vi.fn>).mock.calls;
    const watchCall = hsetCalls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' && c[0].startsWith('agent:watches:') && !(c[0] as string).includes('summary'),
    );
    const storedWatch = JSON.parse((watchCall as unknown[])[2] as string);
    // Non-protective → no auto-link, no positionKey
    expect(storedWatch.coverage?.positionKey).toBeUndefined();
  });

  // ── Fail-closed: reject unmatchable protective watches ─────────────

  it('rejects protective stop_loss watch when instrument and coverage are both absent', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('RANDOM-COIN', 'hyperliquid', 60_000),
    );
    const getPrice = vi.fn().mockResolvedValue(okPrice(60_000));
    // Instrument repo returns nothing — so instrument resolution fails.
    // botRepo returns no open positions — so auto-link finds nothing to link.
    const ctx = makeCtx({
      priceService: { getPrice, resolvePriceTarget },
      instrumentRepo: {
        search: vi.fn().mockResolvedValue([]),
      },
      botRepo: { getOpenPositionsByCreator: vi.fn().mockResolvedValue([]) } as unknown as ToolContext['botRepo'],
    });

    const result = await watchTokenTool.execute(
      { symbol: 'RANDOM-COIN', chain: 'hyperliquid', thresholdPrice: 10, condition: 'below', purpose: 'stop_loss' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Protective watch');
    expect(result.error).toContain('stop_loss');
  });

  it('rejects protective take_profit watch when instrument and coverage are both absent', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('RANDOM-COIN', 'hyperliquid', 60_000),
    );
    const getPrice = vi.fn().mockResolvedValue(okPrice(60_000));
    const ctx = makeCtx({
      priceService: { getPrice, resolvePriceTarget },
      instrumentRepo: {
        search: vi.fn().mockResolvedValue([]),
      },
      botRepo: { getOpenPositionsByCreator: vi.fn().mockResolvedValue([]) } as unknown as ToolContext['botRepo'],
    });

    const result = await watchTokenTool.execute(
      { symbol: 'RANDOM-COIN', chain: 'hyperliquid', thresholdPrice: 100, condition: 'above', purpose: 'take_profit' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Protective watch');
    expect(result.error).toContain('take_profit');
  });

  it('rejects protective exit watch when instrument and coverage are both absent', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('RANDOM-COIN', 'hyperliquid', 60_000),
    );
    const getPrice = vi.fn().mockResolvedValue(okPrice(60_000));
    const ctx = makeCtx({
      priceService: { getPrice, resolvePriceTarget },
      instrumentRepo: {
        search: vi.fn().mockResolvedValue([]),
      },
      botRepo: { getOpenPositionsByCreator: vi.fn().mockResolvedValue([]) } as unknown as ToolContext['botRepo'],
    });

    const result = await watchTokenTool.execute(
      { symbol: 'RANDOM-COIN', chain: 'hyperliquid', thresholdPrice: 10, condition: 'below', purpose: 'exit' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Protective watch');
    expect(result.error).toContain('exit');
  });

  it('allows protective watch when instrument identity is resolved (even without coverage)', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('BTC-USD', 'hyperliquid', 60_000),
    );
    const getPrice = vi.fn().mockResolvedValue(okPrice(60_000));
    const ctx = makeCtx({
      priceService: { getPrice, resolvePriceTarget },
      instrumentRepo: {
        search: vi.fn().mockResolvedValue([
          makeInstrumentRow({ id: 'BTC-USD', symbol: 'BTC-USD', venue: 'hyperliquid' }),
        ]),
      },
      // No botRepo — coverage resolution fails, but instrument identity is present
      botRepo: null,
    });

    const result = await watchTokenTool.execute(
      { symbol: 'BTC-USD', chain: 'hyperliquid', thresholdPrice: 70_000, condition: 'above', purpose: 'stop_loss' },
      ctx,
    );

    // Instrument identity resolved → allowed
    expect(result.success).toBe(true);
  });

  it('allows non-protective monitor watch even when instrument and coverage are absent', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(
      okResolve('RANDOM-COIN', 'hyperliquid', 60_000),
    );
    const getPrice = vi.fn().mockResolvedValue(okPrice(60_000));
    const ctx = makeCtx({
      priceService: { getPrice, resolvePriceTarget },
      instrumentRepo: {
        search: vi.fn().mockResolvedValue([]),
      },
      botRepo: null,
    });

    const result = await watchTokenTool.execute(
      { symbol: 'RANDOM-COIN', chain: 'hyperliquid', thresholdPrice: 10, condition: 'below', purpose: 'monitor' },
      ctx,
    );

    // Non-protective → allowed even without linkage
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Protective linkage against production-shaped data (bug 2026-10-06/001).
// Positions opened through decision intake store symbol = the instrumentId the
// agent submitted and instrument_id = null; the instruments table stores ccxt
// unified symbols with random UUID ids, so the canonical tier never links them.
// ---------------------------------------------------------------------------

describe('watch_token — protective linkage by venue + symbol', () => {
  function openPosition(overrides: Partial<{
    actorType: string;
    actorId: string;
    venue: string;
    symbol: string;
    side: string;
    instrumentId: string | null;
  }> = {}) {
    return {
      actorType: 'agent',
      actorId: 'agent-test-1',
      venue: 'hyperliquid',
      symbol: 'NEAR',
      instrumentId: null,
      side: 'long',
      size: '10',
      entryPrice: '3',
      openedAt: new Date(),
      ...overrides,
    };
  }

  const ccxtNearRow = makeInstrumentRow({
    id: '0192f0c4-7e1a-7000-8000-000000000001',
    symbol: 'NEAR/USDC:USDC',
    base: 'NEAR',
    quote: 'USDC',
    venue: 'hyperliquid',
  });

  function ctxWith(
    positions: unknown[],
    opts: { resolvedSymbol?: string; resolvedChain?: string; instrumentRows?: unknown[]; botRepo?: null } = {},
  ): ToolContext {
    return makeCtx({
      priceService: {
        getPrice: vi.fn().mockResolvedValue(okPrice(3)),
        resolvePriceTarget: vi.fn().mockResolvedValue(
          okResolve(opts.resolvedSymbol ?? 'NEAR', opts.resolvedChain ?? 'hyperliquid', 3),
        ),
      },
      instrumentRepo: { search: vi.fn().mockResolvedValue(opts.instrumentRows ?? [ccxtNearRow]) },
      botRepo: opts.botRepo === null
        ? null
        : { getOpenPositionsByCreator: vi.fn().mockResolvedValue(positions) } as unknown as ToolContext['botRepo'],
    });
  }

  function storedCoverage(ctx: ToolContext): Record<string, unknown> | undefined {
    const hsetCalls = (ctx.redis.hset as ReturnType<typeof vi.fn>).mock.calls;
    const watchCall = hsetCalls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' && c[0].startsWith('agent:watches:') && !(c[0] as string).includes('summary'),
    );
    return JSON.parse((watchCall as unknown[])[2] as string).coverage;
  }

  const nearStopLoss = {
    symbol: 'NEAR',
    chain: 'hyperliquid',
    thresholdPrice: 2.5,
    condition: 'below' as const,
    purpose: 'stop_loss' as const,
  };

  // ── Auto-link fallback (no coverage.targetPosition) ────────────────

  it('links a stop_loss below to the only long on the venue when the position has no instrumentId', async () => {
    const ctx = ctxWith([openPosition()]);

    const result = await watchTokenTool.execute(nearStopLoss, ctx);

    expect(result.success).toBe(true);
    expect(storedCoverage(ctx)?.positionKey).toBe('hyperliquid::NEAR::long');
  });

  it('links a take_profit below to a short', async () => {
    const ctx = ctxWith([openPosition({ side: 'short' })]);

    const result = await watchTokenTool.execute(
      { ...nearStopLoss, thresholdPrice: 2, purpose: 'take_profit' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(storedCoverage(ctx)?.positionKey).toBe('hyperliquid::NEAR::short');
  });

  it('matches the resolved symbol when the caller passed a perp alias', async () => {
    const ctx = ctxWith([openPosition()], { resolvedSymbol: 'NEAR' });

    const result = await watchTokenTool.execute({ ...nearStopLoss, symbol: 'NEAR-PERP' }, ctx);

    expect(result.success).toBe(true);
    expect(storedCoverage(ctx)?.positionKey).toBe('hyperliquid::NEAR::long');
  });

  it('falls back to venue + symbol when the resolved instrumentId matches no position', async () => {
    const ctx = ctxWith([openPosition()], {
      instrumentRows: [makeInstrumentRow({ id: 'uuid-near', symbol: 'NEAR', base: 'NEAR', venue: 'hyperliquid' })],
    });

    const result = await watchTokenTool.execute(nearStopLoss, ctx);

    expect(result.success).toBe(true);
    expect(storedCoverage(ctx)?.positionKey).toBe('hyperliquid::NEAR::long');
  });

  it('rejects a stop_loss whose condition implies the opposite side of the open position', async () => {
    const ctx = ctxWith([openPosition({ side: 'long' })]);

    const result = await watchTokenTool.execute({ ...nearStopLoss, thresholdPrice: 4, condition: 'above' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Protective watch (purpose=stop_loss) could not be auto-linked');
    expect(result.error).toContain('protects a short position');
    expect(result.error).toContain('position is long');
  });

  it('uses the implied side to choose between an agent long and a bot short on the same symbol', async () => {
    const ctx = ctxWith([
      openPosition({ side: 'long' }),
      openPosition({ actorType: 'bot', actorId: 'bot-1', side: 'short' }),
    ]);

    const result = await watchTokenTool.execute({ ...nearStopLoss, thresholdPrice: 4, condition: 'above' }, ctx);

    expect(result.success).toBe(true);
    expect(storedCoverage(ctx)?.positionKey).toBe('hyperliquid::NEAR::short');
  });

  it('rejects as ambiguous when two positions on the implied side match, listing them', async () => {
    const ctx = ctxWith([
      openPosition({ side: 'long' }),
      openPosition({ actorType: 'bot', actorId: 'bot-1', side: 'long' }),
    ]);

    const result = await watchTokenTool.execute(nearStopLoss, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Ambiguous target: 2 open positions match venue=hyperliquid symbol=NEAR side=long');
    expect(result.error).toContain('Your open positions (venue symbol side): hyperliquid NEAR long; hyperliquid NEAR long');
    expect(result.error).toContain('coverage.targetPosition');
  });

  it('links an exit watch when exactly one position has the symbol', async () => {
    const ctx = ctxWith([openPosition({ side: 'long' })]);

    const result = await watchTokenTool.execute({ ...nearStopLoss, condition: 'above', purpose: 'exit' }, ctx);

    expect(result.success).toBe(true);
    expect(storedCoverage(ctx)?.positionKey).toBe('hyperliquid::NEAR::long');
  });

  it('rejects an exit watch as ambiguous when positions on both sides match (exit implies no side)', async () => {
    const ctx = ctxWith([
      openPosition({ side: 'long' }),
      openPosition({ actorType: 'bot', actorId: 'bot-1', side: 'short' }),
    ]);

    const result = await watchTokenTool.execute({ ...nearStopLoss, purpose: 'exit' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Ambiguous target: 2 open positions match venue=hyperliquid symbol=NEAR.');
  });

  it('does not link when the watch price resolved on a different chain than the position venue', async () => {
    const ctx = ctxWith([openPosition()], { resolvedChain: 'ethereum' });

    const result = await watchTokenTool.execute(nearStopLoss, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('No open position found matching venue=ethereum symbol=NEAR side=long');
    expect(result.error).toContain('hyperliquid NEAR long');
  });

  it('does not auto-link swap-venue positions, and lists them for an explicit retry', async () => {
    const ctx = ctxWith(
      [openPosition({ venue: 'jupiter', symbol: 'SOL/USDC' })],
      { resolvedSymbol: 'SOL', resolvedChain: 'solana', instrumentRows: [] },
    );

    const result = await watchTokenTool.execute({ ...nearStopLoss, symbol: 'SOL', chain: 'solana', thresholdPrice: 120 }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('No open position found matching venue=solana symbol=SOL side=long');
    expect(result.error).toContain('jupiter SOL/USDC long');
  });

  it('caps the listed open positions in a rejection', async () => {
    const positions = Array.from({ length: 12 }, (_, i) => openPosition({ symbol: `TOK${i}` }));
    const ctx = ctxWith(positions);

    const result = await watchTokenTool.execute(nearStopLoss, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('hyperliquid TOK9 long');
    expect(result.error).not.toContain('TOK10');
    expect(result.error).toContain('(+2 more)');
  });

  it('auto-links when misnested coverage fields are stripped by the schema', async () => {
    // The reported error text is only reachable when coverage.targetPosition
    // never reaches execute(), e.g. venue/symbol/side placed directly on
    // coverage. Zod strips those keys, so the auto-link path must handle it.
    const ctx = ctxWith([openPosition()]);
    const parsed = watchTokenTool.parametersSchema!.parse({
      ...nearStopLoss,
      coverage: { venue: 'hyperliquid', symbol: 'NEAR', side: 'long', instrumentId: 'NEAR' },
    });

    const result = await watchTokenTool.execute(parsed, ctx);

    expect(result.success).toBe(true);
    expect(storedCoverage(ctx)?.positionKey).toBe('hyperliquid::NEAR::long');
  });

  it('explains that positions cannot be looked up when no position lookup is available', async () => {
    const ctx = ctxWith([], { instrumentRows: [], botRepo: null });

    const result = await watchTokenTool.execute(nearStopLoss, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Protective watch (purpose=stop_loss)');
    expect(result.error).toContain('open positions cannot be looked up in this context');
  });

  // ── Explicit coverage.targetPosition ───────────────────────────────

  it('links coverage.targetPosition carrying an instrumentId when the stored position has none', async () => {
    const ctx = ctxWith([openPosition()]);

    const result = await watchTokenTool.execute(
      {
        ...nearStopLoss,
        coverage: { targetPosition: { venue: 'hyperliquid', symbol: 'NEAR', side: 'long', instrumentId: 'NEAR' } },
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(storedCoverage(ctx)?.positionKey).toBe('hyperliquid::NEAR::long');
  });

  it('rejects an ambiguous coverage.targetPosition, listing open positions', async () => {
    const ctx = ctxWith([
      openPosition(),
      openPosition({ actorType: 'bot', actorId: 'bot-1' }),
    ]);

    const result = await watchTokenTool.execute(
      { ...nearStopLoss, coverage: { targetPosition: { venue: 'hyperliquid', symbol: 'NEAR', side: 'long' } } },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Ambiguous target: 2 open positions match venue=hyperliquid symbol=NEAR side=long');
    expect(result.error).toContain('Your open positions (venue symbol side): hyperliquid NEAR long; hyperliquid NEAR long');
  });

  it('rejects coverage.targetPosition whose instrumentId conflicts with the stored one, listing open positions', async () => {
    const ctx = ctxWith([openPosition({ instrumentId: 'NEAR-CANONICAL' })]);

    const result = await watchTokenTool.execute(
      {
        ...nearStopLoss,
        coverage: { targetPosition: { venue: 'hyperliquid', symbol: 'NEAR', side: 'long', instrumentId: 'OTHER' } },
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('No open position found matching venue=hyperliquid symbol=NEAR side=long');
    expect(result.error).toContain('Your open positions (venue symbol side): hyperliquid NEAR long');
  });
});
