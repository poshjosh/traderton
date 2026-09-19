import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentRiskDefaultsConfig, AgentRiskOverrides, TradingToolContext } from '@traderton/domain';
import { accountTools, buildRiskContractOpsFromRiskSource, riskLimitsTools } from '@traderton/worker';

const AGENT_ID = 'agent-1';
const VENUE_ACCOUNT_ID = 'venue-1';
const AGENT_RISK_DEFAULTS: AgentRiskDefaultsConfig = {
  maxOpenPositions: 10,
  maxPositionSizePct: 100,
  stopLossPct: 10,
  stopLossCooldownMs: 300_000,
  maxDrawdownPct: 20,
  dailyMaxLossPct: 20,
  maxOrderNotionalMultiplier: 1,
};

interface StoredProfile {
  capital: string | null;
  riskPosture: Record<string, unknown> | null;
  riskOverrides: AgentRiskOverrides;
  executionDefaults: { mode: 'paper' | 'shadow' | 'live' } | null;
}

const getRiskLimits = riskLimitsTools.find((tool) => tool.name === 'get_risk_limits')!;
const adjustRiskLimits = riskLimitsTools.find((tool) => tool.name === 'adjust_risk_limits')!;
const getAccountSummary = accountTools.find((tool) => tool.name === 'get_account_summary')!;

let profiles: Map<string, StoredProfile>;

function selectedContext(venueAccountId: string): TradingToolContext {
  const profile = profiles.get(venueAccountId);
  if (!profile) throw new Error('selected trading profile is missing');

  const riskContractOps = buildRiskContractOpsFromRiskSource({
    agentRiskDefaults: AGENT_RISK_DEFAULTS,
    source: {
      capital: profile.capital,
      riskPosture: profile.riskPosture,
      riskOverrides: profile.riskOverrides,
    },
    setRiskOverrides: async (riskOverrides) => {
      const current = profiles.get(venueAccountId);
      if (!current) throw new Error('selected trading profile disappeared while updating risk overrides');
      profiles.set(venueAccountId, { ...current, riskOverrides });
    },
  });

  return {
    agentId: AGENT_ID,
    sessionId: 'session-1',
    ownerId: 'owner-1',
    executionMode: profile.executionDefaults?.mode ?? 'paper',
    authorizationMode: 'direct',
    redis: {
      hset: async () => 1, hget: async () => null, hgetall: async () => ({}),
      hdel: async () => 1, publish: async () => 1, blpop: async () => null,
      smembers: async () => [], sadd: async () => 1, srem: async () => 1, expire: async () => 1,
    } as TradingToolContext['redis'],
    publishToInbound: async () => {},
    riskContractOps,
    botRepo: {
      getOpenPositionsByCreator: async () => [],
      getAnalyticsByCreator: async () => ({
        realizedPnlUsd: '0', botCount: 0, openPositions: 0, closedPositions: 0,
        winningPositions: 0, totalFeesUsd: '0', recentFills: 0, avgHoldTimeHours: null, byBot: [],
      }),
    } as TradingToolContext['botRepo'],
    agentRepo: {
      getAgent: async () => ({ capital: profile.capital, risk: profile.riskPosture }),
    },
    executionConfig: {
      getExecutionConfig: async () => ({
        mode: profile.executionDefaults?.mode ?? null,
        positionSizeMode: null,
        fixedPositionSize: null,
      }),
    },
  };
}

function replaceProfileConfiguration(venueAccountId: string, configuration: Omit<StoredProfile, 'riskOverrides'>): void {
  const existing = profiles.get(venueAccountId);
  if (!existing) throw new Error('selected trading profile is missing');
  profiles.set(venueAccountId, { ...configuration, riskOverrides: existing.riskOverrides });
}

describe('C1 selected trading-profile risk seam', () => {
  beforeEach(() => {
    profiles = new Map([[VENUE_ACCOUNT_ID, {
      capital: '1000',
      riskPosture: { maxOpenPositions: 3, dailyMaxLossPct: 20 },
      riskOverrides: {},
      executionDefaults: { mode: 'paper' },
    }]]);
  });

  it('reads risk and account state from the selected profile, not request payload authority', async () => {
    const ctx = selectedContext(VENUE_ACCOUNT_ID);
    const suppliedPayload = {
      venueAccountId: VENUE_ACCOUNT_ID,
      capital: '999999',
      riskPosture: { maxOpenPositions: 9, dailyMaxLossPct: 1 },
      executionDefaults: { mode: 'live' },
    };

    const risk = await getRiskLimits.execute(suppliedPayload, ctx);
    const account = await getAccountSummary.execute(suppliedPayload, ctx);

    expect(risk).toMatchObject({ success: true });
    expect((risk.data as { limits: { maxOpenPositions: { value: number } } }).limits.maxOpenPositions.value).toBe(3);
    expect(account).toMatchObject({ success: true, data: { capital: '1000' } });
    await expect(ctx.executionConfig?.getExecutionConfig()).resolves.toMatchObject({ mode: 'paper' });
  });

  it('rejects selected profile reads when no persisted profile exists', () => {
    expect(() => selectedContext('missing-venue')).toThrow('selected trading profile is missing');
  });

  it('round-trips adjust_risk_limits overrides through the selected stored profile', async () => {
    const adjustment = await adjustRiskLimits.execute({ venueAccountId: VENUE_ACCOUNT_ID, maxDrawdownPct: 5 }, selectedContext(VENUE_ACCOUNT_ID));

    expect(adjustment).toMatchObject({ success: true });
    expect(profiles.get(VENUE_ACCOUNT_ID)?.riskOverrides).toEqual({ maxDrawdownPct: 5 });
    const read = await getRiskLimits.execute({ venueAccountId: VENUE_ACCOUNT_ID }, selectedContext(VENUE_ACCOUNT_ID));
    expect((read.data as { limits: { maxDrawdownPct: { value: number; source: string } } }).limits.maxDrawdownPct)
      .toEqual(expect.objectContaining({ value: 5, source: 'agent_override' }));
  });

  it('preserves persisted overrides when configuration writes replace profile fields', () => {
    profiles.set(VENUE_ACCOUNT_ID, {
      ...profiles.get(VENUE_ACCOUNT_ID)!,
      riskOverrides: { maxOpenPositions: 4 },
    });

    replaceProfileConfiguration(VENUE_ACCOUNT_ID, {
      capital: '2500',
      riskPosture: { maxOpenPositions: 2 },
      executionDefaults: { mode: 'shadow' },
    });

    expect(profiles.get(VENUE_ACCOUNT_ID)).toEqual(expect.objectContaining({
      capital: '2500',
      riskPosture: { maxOpenPositions: 2 },
      riskOverrides: { maxOpenPositions: 4 },
      executionDefaults: { mode: 'shadow' },
    }));
  });
});
