import { describe, expect, it, vi, beforeEach } from 'vitest';

const { applyOperation } = vi.hoisted(() => ({ applyOperation: vi.fn() }));

vi.mock('@traderton/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@traderton/db')>();
  return {
    ...actual,
    AgentTradingProfileRepository: class {
      applyOperation = applyOperation;
    },
  };
});

import { tradingProfileTools } from './trading-profiles.js';

beforeEach(() => {
  applyOperation.mockReset();
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

function context(ownerId = 'owner-1', agentId = 'agent-1') {
  return {
    ownerId,
    agentId,
    operatorRiskDefaults,
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [{ id: 'venue-1' }] }),
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