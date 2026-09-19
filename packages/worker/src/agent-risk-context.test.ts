// A3 tests — the boundary RiskSource seam. Verifies that:
// 1. `buildRiskContractOpsFromRiskSource` (the copied ops) resolves the
//    contract/profile through the single RiskSource interface — capital,
//    creator riskPosture, and overrides all take effect with the correct
//    provenance; absent values degrade to operator defaults with
//    `hasCapital` gating maxPositionSizePct enforcement.
// 2. `adjustOverrides` fails closed (no durable write home until B1).
// 3. `riskSourceIsEmpty` classifies spec-less payloads.

import { describe, it, expect } from 'vitest';
import type { AgentRiskDefaultsConfig } from '@traderton/domain';
import {
  buildRiskContractOpsFromRiskSource,
  riskSourceIsEmpty,
  type RiskSource,
} from './agent-risk-context.js';

const DEFAULTS: AgentRiskDefaultsConfig = {
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
} as AgentRiskDefaultsConfig;

function source(overrides?: Partial<RiskSource>): RiskSource {
  return {
    capital: null,
    riskPosture: null,
    riskOverrides: {},
    ...overrides,
  };
}

describe('riskSourceIsEmpty', () => {
  it('is true when the spec carries nothing', () => {
    expect(riskSourceIsEmpty(source())).toBe(true);
    expect(riskSourceIsEmpty({ capital: null, riskPosture: null, riskOverrides: undefined as unknown as RiskSource['riskOverrides'] })).toBe(true);
  });

  it('is false when any field is present', () => {
    expect(riskSourceIsEmpty(source({ capital: '1000' }))).toBe(false);
    expect(riskSourceIsEmpty(source({ riskPosture: { maxOpenPositions: 3 } }))).toBe(false);
    expect(riskSourceIsEmpty(source({ riskOverrides: { maxDrawdownPct: 5 } }))).toBe(false);
  });
});

describe('buildRiskContractOpsFromRiskSource (the copied ops over the seam)', () => {
  it('creator riskPosture values win with source user + mutable false', async () => {
    const ops = buildRiskContractOpsFromRiskSource({
      agentRiskDefaults: DEFAULTS,
      source: source({ capital: '1000', riskPosture: { maxOpenPositions: 3, stopLossPct: 5 } }),
    });

    const contract = await ops.getContract();
    expect(contract.maxOpenPositions).toMatchObject({ effectiveValue: 3, source: 'user', mutable: false });
    expect(contract.stopLossPct).toMatchObject({ effectiveValue: 5, source: 'user', mutable: false });
    // Unspecified fields fall back to the operator default (mutable, at ceiling).
    expect(contract.maxDrawdownPct).toMatchObject({ effectiveValue: DEFAULTS.maxDrawdownPct, source: 'default', mutable: true });
  });

  it('overrides cap at the operator ceiling with source agent_override', async () => {
    const ops = buildRiskContractOpsFromRiskSource({
      agentRiskDefaults: DEFAULTS,
      source: source({ riskOverrides: { maxDrawdownPct: 5 } }),
    });

    const contract = await ops.getContract();
    expect(contract.maxDrawdownPct).toMatchObject({
      effectiveValue: 5,
      source: 'agent_override',
      mutable: true,
      operatorCeiling: DEFAULTS.maxDrawdownPct,
      overrideValue: 5,
    });
  });

  it('marks maxPositionSizePct enforced:false when sourced from defaults without capital', async () => {
    const ops = buildRiskContractOpsFromRiskSource({
      agentRiskDefaults: DEFAULTS,
      source: source(),
    });
    const contract = await ops.getContract();
    expect(contract.maxPositionSizePct.enforced).toBe(false);

    const withCapital = buildRiskContractOpsFromRiskSource({
      agentRiskDefaults: DEFAULTS,
      source: source({ capital: '1000' }),
    });
    expect((await withCapital.getContract()).maxPositionSizePct.enforced).not.toBe(false);
  });

  it('getProfile resolves the 9-field read model, deriving maxOrderNotional from capital', async () => {
    const ops = buildRiskContractOpsFromRiskSource({
      agentRiskDefaults: DEFAULTS,
      source: source({ capital: '1000' }),
    });

    const profile = await ops.getProfile!();
    expect(profile.dailyMaxLossPct).toMatchObject({ effectiveValue: DEFAULTS.dailyMaxLossPct, source: 'default' });
    expect(profile.maxOrderNotional.effectiveValue).toBe(1000);
  });

  it('adjustOverrides fails closed — never writes (B1 hand-off)', async () => {
    const ops = buildRiskContractOpsFromRiskSource({
      agentRiskDefaults: DEFAULTS,
      source: source({ capital: '1000', riskOverrides: {} }),
    });

    const result = await ops.adjustOverrides({ maxOpenPositions: 4 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('B1');
    // The source is unchanged — a per-call spec cannot be durably mutated.
    expect((await ops.getContract()).maxOpenPositions.effectiveValue).toBe(DEFAULTS.maxOpenPositions);
  });
});
