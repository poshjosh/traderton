import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';
import {
  initStrategyRegistry,
  getStrategyParameters,
  isStrategySupported,
  validateStrategyParams,
  listStrategyCombinations,
} from './strategy-parameters.js';

// Traderton divergence (decisions 7–9, bots are mechanical-only): Traderton does NOT
// call registerAgentDecisionModes({ llm, hybrid }) — the llm/hybrid decision modes are
// the agent's reasoning modes and stay agent-side. This test therefore covers only the
// mechanical + dca registry, and asserts that llm/hybrid modes resolve as unsupported.
// The source test's `momentum:hybrid uses HybridParamsSchema` assertion is intentionally
// dropped (Intentional Divergence, see docs/001 + docs/004); the `unsupported here`
// assertion below is its Traderton-side counterpart.
describe('StrategyParameterRegistry', () => {
  // Initialize the registry with test schemas before tests
  const testMechanicalSchema = z.object({
    stopLossPct: z.number().min(0).max(100),
    takeProfitPct: z.number().min(0),
  });

  beforeAll(() => {
    initStrategyRegistry({
      mechanical: testMechanicalSchema,
      empty: z.object({}).strict(),
    });
  });

  it('DCA has empty params for all decision modes', () => {
    for (const mode of ['mechanical', 'llm', 'hybrid'] as const) {
      const entry = getStrategyParameters('dca', mode);
      expect(entry).toBeDefined();
      expect(entry!.defaults).toEqual({});
      expect(entry!.schema.parse({})).toEqual({});
    }
  });

  it('momentum:mechanical uses MechanicalParamsSchema', () => {
    const entry = getStrategyParameters('momentum', 'mechanical');
    expect(entry).toBeDefined();
    const result = entry!.schema.parse({ stopLossPct: 5, takeProfitPct: 10 });
    expect(result.stopLossPct).toBe(5);
  });

  it('momentum:hybrid and momentum:llm are unsupported (mechanical-only — Intentional Divergence)', () => {
    // Traderton bots are mechanical-only; the agent decision modes are not registered.
    expect(getStrategyParameters('momentum', 'hybrid')).toBeUndefined();
    expect(getStrategyParameters('momentum', 'llm')).toBeUndefined();
    expect(isStrategySupported('momentum', 'hybrid')).toBe(false);
    expect(isStrategySupported('momentum', 'llm')).toBe(false);
  });

  it('isStrategySupported returns false for unknown types', () => {
    expect(isStrategySupported('unknown_type')).toBe(false);
    expect(isStrategySupported('momentum')).toBe(true);
  });

  it('validateStrategyParams throws for unsupported type', () => {
    expect(() => validateStrategyParams('unknown', 'mechanical', {}))
      .toThrow('Unsupported strategy');
  });

  it('validateStrategyParams validates params through registry', () => {
    const result = validateStrategyParams('momentum', 'mechanical', {
      stopLossPct: 5,
      takeProfitPct: 10,
    });
    expect(result.stopLossPct).toBe(5);
  });

  it('validateStrategyParams rejects invalid params', () => {
    expect(() => validateStrategyParams('momentum', 'mechanical', {
      stopLossPct: 500, // exceeds max 100
    })).toThrow();
  });

  it('listStrategyCombinations returns all registered combos', () => {
    const combos = listStrategyCombinations();
    expect(combos.length).toBeGreaterThan(0);
    // DCA should be registered for all 3 modes
    const dcaCombos = combos.filter(c => c.type === 'dca');
    expect(dcaCombos.length).toBe(3);
  });

  it('defaults decisionMode to mechanical when undefined', () => {
    const entry = getStrategyParameters('momentum');
    expect(entry).toBeDefined();
  });
});
