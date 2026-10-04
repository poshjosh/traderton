import { describe, expect, it, vi, beforeEach } from 'vitest';

const { applyOperation, getByOwnerActorVenueAccount } = vi.hoisted(() => ({
  applyOperation: vi.fn(),
  getByOwnerActorVenueAccount: vi.fn(),
}));

vi.mock('@traderton/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@traderton/db')>();
  return {
    ...actual,
    AgentTradingProfileRepository: class {
      applyOperation = applyOperation;
      getByOwnerActorVenueAccount = getByOwnerActorVenueAccount;
    },
  };
});

import { tradingProfileTools } from './trading-profiles.js';

beforeEach(() => {
  applyOperation.mockReset();
  getByOwnerActorVenueAccount.mockReset();
  getByOwnerActorVenueAccount.mockResolvedValue(null);
});

const setProfile = tradingProfileTools.find((tool) => tool.name === 'set_agent_trading_profile')!;
const getOperatorDefaults = tradingProfileTools.find((tool) => tool.name === 'get_operator_defaults')!;

const operatorRiskDefaults = {
  dailyLossLimitDefaultRatio: 0.05,
  maxOpenPositions: 10,
  maxPositionSizePct: 100,
  maxPositionSize: 1_000_000,
  stopLossPct: 10,
  dailyMaxLossPct: 20,
  stopLossCooldownMs: 300_000,
  maxOrderNotionalMultiplier: 1,
  botConfigInvalidHaltThreshold: 1,
  botExecutionErrorHaltThreshold: 5,
  botLlmProviderErrorHaltThreshold: 1,
  agentDecisionNoContextThreshold: 10,
  agentDecisionSwapInstrumentFormatThreshold: 5,
  maxDrawdown: 1_000_000_000,
  maxDrawdownPct: 20,
  perTradeLevelMonitorIntervalMs: 5000,
  maxBots: 5,
};

function context(ownerId = 'owner-1', agentId = 'agent-1', venue = 'hyperliquid', marketDataConfig?: Record<string, unknown>) {
  return {
    ownerId,
    agentId,
    operatorRiskDefaults,
    marketDataConfig,
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [{ id: 'venue-1', venue }] }),
        }),
      }),
    },
  } as never;
}

const params = {
  actorId: 'agent-1',
  venueAccountId: 'venue-1',
  operationId: 'operation-1',
  actionId: 'action-1',
  capital: '100',
  riskPosture: null,
  executionDefaults: { mode: 'paper' as const },
};

describe('set_agent_trading_profile tool identity boundary', () => {
  it('rejects a payload actor that differs from the signed subject before any repository operation', async () => {
    const result = await setProfile.execute({ ...params, actorId: 'agent-2' }, context());

    expect(result).toMatchObject({ success: false, errorCode: 'authorization.denied' });
    expect(applyOperation).not.toHaveBeenCalled();
  });

  it('passes the signed owner and actor to the repository after owner-scoped venue authorization', async () => {
    applyOperation.mockResolvedValue(new Map([['action-1', 1n]]));

    const result = await setProfile.execute(params, context());

    expect(result).toMatchObject({ success: true, data: { operationId: 'operation-1', revision: '1' } });
    expect(applyOperation).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: 'owner-1', actorId: 'agent-1', operationId: 'operation-1',
    }));
  });

  it('rejects a riskPosture field above the operator ceiling before any repository operation', async () => {
    const result = await setProfile.execute(
      { ...params, riskPosture: { maxOpenPositions: 11 } },
      context(),
    );

    expect(result).toMatchObject({ success: false, fault: false, errorCode: 'validation.risk_ceiling' });
    expect(result.error).toContain('maxOpenPositions cannot exceed the operator ceiling of 10');
    expect(applyOperation).not.toHaveBeenCalled();
  });

  it('rejects with a fault when operator risk defaults are absent (fail closed)', async () => {
    const ctx = context();
    const { operatorRiskDefaults: _dropped, ...withoutDefaults } = ctx;

    const result = await setProfile.execute(
      { ...params, riskPosture: { maxOpenPositions: 11 } },
      withoutDefaults as never,
    );

    expect(result).toMatchObject({ success: false, fault: true, errorCode: 'risk_defaults.unavailable' });
    expect(applyOperation).not.toHaveBeenCalled();
  });

  it('accepts a within-ceiling riskPosture and proceeds to the repository', async () => {
    applyOperation.mockResolvedValue(new Map([['action-1', 1n]]));

    const result = await setProfile.execute(
      { ...params, riskPosture: { maxOpenPositions: 5, maxPositionSizePct: 50 } },
      context(),
    );

    expect(result).toMatchObject({ success: true });
    expect(applyOperation).toHaveBeenCalled();
  });
});

// A minimal custom technical config. filters.venue/venueType are overwritten by
// the resolver with the venue binding, so leave them as placeholders here.
function customTechnical(overrides: Record<string, unknown> = {}) {
  return {
    filters: { venue: 'placeholder', venueType: 'orderbook' },
    indicators: {},
    candles: { interval: '15m', limit: 100 },
    signalBias: 'trend-following',
    scanIntervalMs: 60_000,
    scanBatchSize: 5,
    autonomousExit: false,
    ...overrides,
  };
}

describe('set_agent_trading_profile scan configuration', () => {
  beforeEach(() => applyOperation.mockResolvedValue(new Map([['action-1', 1n]])));

  it('rejects a scanner-gated profile without a creator strategy', async () => {
    const result = await setProfile.execute(
      { ...params, scanMode: 'scanner_gated' },
      context(),
    );

    expect(result).toMatchObject({ success: false, fault: false, errorCode: 'validation.strategy_required' });
    expect(applyOperation).not.toHaveBeenCalled();
  });

  it('resolves a creator preset to the same technical config herobids produced', async () => {
    const result = await setProfile.execute(
      { ...params, scanMode: 'scanner_gated', creatorStrategy: { presetKey: 'momentum', styleTier: 'standard' } },
      context(),
    );

    expect(result).toMatchObject({ success: true });
    expect(applyOperation).toHaveBeenCalledWith(expect.objectContaining({
      actions: [expect.objectContaining({
        scanMode: 'scanner_gated',
        creatorStrategy: { presetKey: 'momentum', styleTier: 'standard' },
      })],
    }));
  });

  it('repairs a mixed-mode technical config with defaults', async () => {
    // Omit scanBatchSize/autonomousExit — lenient TechnicalConfigSchema fills
    // defaults rather than rejecting, so a mixed-mode set succeeds.
    const technical = customTechnical();
    delete (technical as Record<string, unknown>)['scanBatchSize'];
    delete (technical as Record<string, unknown>)['autonomousExit'];

    const result = await setProfile.execute(
      { ...params, scanMode: 'mixed', creatorStrategy: { customTechnical: technical } },
      context(),
    );

    expect(result).toMatchObject({ success: true });
    expect(applyOperation).toHaveBeenCalled();
  });

  it('rejects an incoherent swap scanner config', async () => {
    // scanner_gated on a swap venue with no canonical tokens configured →
    // validateSwapScannerConfig fails closed.
    const technical = customTechnical({ filters: { venue: 'placeholder', venueType: 'swap', networks: ['solana'] } });

    const result = await setProfile.execute(
      { ...params, scanMode: 'scanner_gated', creatorStrategy: { customTechnical: technical } },
      context('owner-1', 'agent-1', 'jupiter', { tokenSafety: { canonicalTokens: {} } }),
    );

    expect(result).toMatchObject({ success: false, fault: false });
    expect(String(result.errorCode)).toMatch(/^swap\./);
    expect(applyOperation).not.toHaveBeenCalled();
  });

  it('keeps existing profiles valid when scan fields are absent', async () => {
    // Old caller: no scanMode/creatorStrategy. No scan validation runs; the
    // forward action carries nulls so the repo preserves any stored strategy.
    const result = await setProfile.execute(params, context());

    expect(result).toMatchObject({ success: true });
    expect(applyOperation).toHaveBeenCalledWith(expect.objectContaining({
      actions: [expect.objectContaining({ scanMode: null, creatorStrategy: null })],
    }));
  });

  it('accepts a scanner-gated resend that relies on the stored active strategy', async () => {
    // No new creatorStrategy, but a stored active config exists → scanner_gated
    // passes validation against the existing resolved technical config.
    getByOwnerActorVenueAccount.mockResolvedValue({
      activeStrategy: { technical: customTechnical() },
    });

    const result = await setProfile.execute(
      { ...params, scanMode: 'scanner_gated' },
      context(),
    );

    expect(result).toMatchObject({ success: true });
  });
});

describe('get_operator_defaults', () => {
  it('returns the injected operator risk defaults', async () => {
    const result = await getOperatorDefaults.execute({}, context());

    expect(result).toEqual({ success: true, data: operatorRiskDefaults });
  });

  it('returns the risk_defaults.unavailable fault when not configured', async () => {
    const result = await getOperatorDefaults.execute({}, {
      ownerId: 'owner-1',
      agentId: 'agent-1',
      db: undefined,
    } as never);

    expect(result).toMatchObject({ success: false, fault: true, errorCode: 'risk_defaults.unavailable' });
  });
});