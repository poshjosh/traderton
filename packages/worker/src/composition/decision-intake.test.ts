/**
 * AUTHORED test (Phase 9b item C) — NOT a copied parity oracle.
 *
 * The decision-intake surface is authored WIRING (a slim router over the
 * already-copied actor-owned intake + the copied engine), so there is no
 * herobids test to copy. This test asserts the router's behaviour
 * deterministically: no real Redis, DB, or network.
 *
 * It stubs the ENGINE BOUNDARY (`submitDecisionForExecution`) and provides a
 * stub `ExecutionActor`, but does NOT stub the handler's own routing — the real
 * `submitDecision` resolves the actor from the registry, calls the stub actor's
 * intake, drives the (mocked) engine, and maps the result. `validatePerTradeLevels`
 * and `DecisionContextHashMismatchError` are the REAL copied engine primitives.
 *
 * Coverage (per 019 §9):
 *  - registered, running actor + successful engine → `accepted` (plan id).
 *  - unregistered / not-running actor → `instance_not_running`.
 *  - actor whose getIntakeDeps returns an IntakeRejection → that typed rejection.
 *  - a validatePerTradeLevels failure → typed `level.*` rejection.
 *  - a DecisionContextHashMismatchError from the engine → `context_hash_mismatch`.
 *  - a risk rejection from the engine → the typed risk rejection.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { price, quantity, AgentRiskDefaultsSchema, type DecisionIntent } from '@traderton/domain';

// ── Engine boundary stub — mock ONLY submitDecisionForExecution ──────────────
// The rest of @traderton/engine (validatePerTradeLevels, the hash-mismatch
// error, createFillFirstMarkSource) stays REAL so the handler's own routing +
// level-validation are exercised, not stubbed.
const { submitDecisionForExecutionMock } = vi.hoisted(() => ({
  submitDecisionForExecutionMock: vi.fn(),
}));
vi.mock('@traderton/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@traderton/engine')>();
  return { ...actual, submitDecisionForExecution: submitDecisionForExecutionMock };
});

// ── AgentTradingActor constructor spy — capture the deps passed to construct ──
// The actor is heavy (venue adapters, timers) and its `deps` are private, so we
// stub the class and record the constructor argument. This lets us assert
// deterministically — with no network, DB, or real cache warmup — that
// constructAndRegisterAgentActor threads a defined `instrumentCache` into the
// actor's deps (the gap this fix closes).
const { agentActorCtorSpy } = vi.hoisted(() => ({ agentActorCtorSpy: vi.fn() }));
vi.mock('../agent-trading-actor.js', () => ({
  AgentTradingActor: class {
    agentId: string;
    isRunning = false;
    constructor(deps: { agentId: string }) {
      agentActorCtorSpy(deps);
      this.agentId = deps.agentId;
    }
    async stop(): Promise<void> {}
  },
}));

import { submitDecision, constructAndRegisterAgentActor, type DecisionSubmitInput, type AgentActorRuntimeDeps, type AgentActorSpec } from './decision-intake.js';
import type { AgentTradingActorDeps } from '../agent-trading-actor.js';
import { VenueInstrumentCache } from '../venue-instrument-cache.js';
import type { ExecutionActor, IntakeResult } from '../execution-actor.js';
import type { DecisionContext, PositionState, DecisionIntakeDeps } from '@traderton/engine';

/** Minimal intake deps the handler reads pre-submit (actorType/symbol/venueAccountId). */
function stubIntakeDeps(overrides?: Partial<DecisionIntakeDeps>): DecisionIntakeDeps {
  return {
    actorType: 'agent',
    actorId: 'agent-1',
    venue: 'hyperliquid',
    symbol: 'BTC/USD:USD',
    venueAccountId: 'va-1',
    ...overrides,
  } as DecisionIntakeDeps;
}

function stubContext(markPrice = '50000'): DecisionContext {
  return {
    snapshot: { symbol: 'BTC/USD:USD', price: markPrice, timestamp: new Date().toISOString() },
    position: null,
    referenceMark: { price: markPrice, source: 'oracle' },
    strategyParams: {},
  };
}

function stubPosition(side: 'flat' | 'long' | 'short' = 'flat'): PositionState {
  return {
    venue: 'hyperliquid',
    symbol: 'BTC/USD:USD',
    side,
    size: quantity('0'),
    entryPrice: price('0'),
    realizedPnl: price('0'),
  } as PositionState;
}

/** A stub ExecutionActor whose intake behaviour is configurable per-test. */
function stubActor(opts?: {
  isRunning?: boolean;
  intake?: IntakeResult;
  context?: DecisionContext | undefined;
  position?: PositionState | undefined;
}): ExecutionActor & { recordExecutionOutcome: ReturnType<typeof vi.fn> } {
  return {
    isRunning: opts?.isRunning ?? true,
    getIntakeDeps: () => (opts?.intake !== undefined ? opts.intake : stubIntakeDeps()),
    getDecisionContext: () => (opts?.context !== undefined ? opts.context : stubContext()),
    getPosition: () => (opts?.position !== undefined ? opts.position : stubPosition()),
    recordExecutionOutcome: vi.fn(),
  };
}

function baseInput(overrides?: Partial<DecisionSubmitInput>): DecisionSubmitInput {
  return {
    actorId: 'agent-1',
    decisionId: 'dec-1',
    instrumentId: 'BTC/USD:USD',
    intent: 'go_long' as DecisionIntent,
    targetSize: '1',
    timestamp: new Date().toISOString(),
    actorType: 'agent',
    initiatorId: 'agent-1',
    ...overrides,
  };
}

describe('submitDecision (AUTHORED — Phase 9b item C)', () => {
  beforeEach(() => {
    submitDecisionForExecutionMock.mockReset();
  });

  it('routes to a registered, running actor and returns accepted on engine success', async () => {
    const actor = stubActor();
    const registry = new Map<string, ExecutionActor>([['agent-1', actor]]);
    submitDecisionForExecutionMock.mockResolvedValue({
      decision: {},
      plan: { id: 'plan-123' },
      riskRejected: false,
      executionFailed: false,
      executionResult: { orders: [], fills: [] },
      position: stubPosition(),
    });

    const result = await submitDecision(registry, baseInput());

    expect(submitDecisionForExecutionMock).toHaveBeenCalledOnce();
    expect(result.status).toBe('accepted');
    if (result.status === 'accepted') {
      expect(result.planId).toBe('plan-123');
    }
    expect(actor.recordExecutionOutcome).toHaveBeenCalledWith(true);
  });

  it('rejects with instance_not_running for an unregistered actor', async () => {
    const registry = new Map<string, ExecutionActor>();

    const result = await submitDecision(registry, baseInput());

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.code).toBe('instance_not_running');
      expect(result.retryable).toBe(true);
    }
    expect(submitDecisionForExecutionMock).not.toHaveBeenCalled();
  });

  it('rejects with instance_not_running when the actor is not running', async () => {
    const actor = stubActor({ isRunning: false });
    const registry = new Map<string, ExecutionActor>([['agent-1', actor]]);

    const result = await submitDecision(registry, baseInput());

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.code).toBe('instance_not_running');
    expect(submitDecisionForExecutionMock).not.toHaveBeenCalled();
  });

  it('surfaces a typed IntakeRejection from the actor getIntakeDeps', async () => {
    const actor = stubActor({
      intake: { rejected: true, code: 'circuit_breaker_open', message: 'breaker open', retryable: false },
    });
    const registry = new Map<string, ExecutionActor>([['agent-1', actor]]);

    const result = await submitDecision(registry, baseInput());

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.code).toBe('circuit_breaker_open');
      expect(result.retryable).toBe(false);
    }
    expect(submitDecisionForExecutionMock).not.toHaveBeenCalled();
  });

  it('rejects a validatePerTradeLevels failure with a typed level.* code', async () => {
    // go_long with a stopLoss ABOVE the mark price is invalid → level.above_mark_for_long.
    const actor = stubActor({ context: stubContext('50000') });
    const registry = new Map<string, ExecutionActor>([['agent-1', actor]]);

    const result = await submitDecision(
      registry,
      baseInput({ intent: 'go_long' as DecisionIntent, stopLoss: '55000' }),
    );

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.code).toBe('level.above_mark_for_long');
    }
    // The engine is never reached — the level check rejects first.
    expect(submitDecisionForExecutionMock).not.toHaveBeenCalled();
  });

  it('maps a DecisionContextHashMismatchError from the engine to context_hash_mismatch', async () => {
    const { DecisionContextHashMismatchError } = await import('@traderton/engine');
    const actor = stubActor();
    const registry = new Map<string, ExecutionActor>([['agent-1', actor]]);
    submitDecisionForExecutionMock.mockRejectedValue(
      new DecisionContextHashMismatchError('canonical-hash', 'supplied-hash'),
    );

    const result = await submitDecision(registry, baseInput({ contextHash: 'supplied-hash' }));

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.code).toBe('context_hash_mismatch');
  });

  it('maps a risk rejection from the engine to the typed risk code', async () => {
    const actor = stubActor();
    const registry = new Map<string, ExecutionActor>([['agent-1', actor]]);
    submitDecisionForExecutionMock.mockResolvedValue({
      decision: {},
      riskRejected: true,
      riskError: { code: 'risk.daily_max_loss_exceeded', message: 'daily loss exceeded' },
      executionFailed: false,
      position: stubPosition(),
    });

    const result = await submitDecision(registry, baseInput());

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.code).toBe('risk.daily_max_loss_exceeded');
      expect(result.retryable).toBe(false);
    }
  });

  it('maps an execution failure from the engine to an error result', async () => {
    const actor = stubActor();
    const registry = new Map<string, ExecutionActor>([['agent-1', actor]]);
    submitDecisionForExecutionMock.mockResolvedValue({
      decision: {},
      riskRejected: false,
      executionFailed: true,
      executionError: { code: 'execution.timeout', message: 'executor timed out' },
      position: stubPosition(),
    });

    const result = await submitDecision(registry, baseInput());

    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.code).toBe('execution.timeout');
    expect(actor.recordExecutionOutcome).toHaveBeenCalledWith(false);
  });
});

describe('constructAndRegisterAgentActor — instrumentCache wiring (AUTHORED — item C gap fix)', () => {
  beforeEach(() => {
    agentActorCtorSpy.mockReset();
  });

  /**
   * Build a minimal AgentActorRuntimeDeps. Only the fields
   * constructAndRegisterAgentActor reads before constructing the (stubbed) actor
   * matter (agentRiskDefaults for buildAgentRiskLimits, fillRepo + fallbackMarkSource
   * + markStalenessThresholdMs for createFillFirstMarkSource, and the new
   * instrument-validation deps). The repos/singletons the stubbed actor never
   * touches are cast — this test asserts wiring, not actor internals.
   */
  function buildRuntimeDeps(cache: VenueInstrumentCache): AgentActorRuntimeDeps {
    return {
      fillRepo: { getLatestFillByInstrument: async () => null },
      fallbackMarkSource: { fetchMark: async () => ({ ok: false, error: { code: 'unavailable', message: 'stub' } }) },
      markStalenessThresholdMs: 30_000,
      agentRiskDefaults: AgentRiskDefaultsSchema.parse({}),
      instrumentCache: cache,
      oneInchConfig: { tokenSafetyNetwork: 'ethereum', chainId: 1 },
      canonicalTokens: {},
      perTradeLevelMonitorIntervalMs: 7_000,
    } as unknown as AgentActorRuntimeDeps;
  }

  const spec: AgentActorSpec = {
    agentId: 'agent-cache-1',
    executionMode: 'paper',
    venueAccountId: 'va-1',
    venue: 'hyperliquid',
    venueType: 'orderbook',
  };

  it('threads a defined instrumentCache (never warmed → fail-open) into the actor deps', () => {
    // Real cache, but never warmed — deterministic, no network. isReady() is false
    // so the actor's validateTradeInstrument gate stays fail-open in this test,
    // but the DEP is present (the gap was a permanently-undefined dep).
    const cache = new VenueInstrumentCache({ info: () => {}, warn: () => {}, error: () => {} } as never);
    const registry = { register: vi.fn(), deregister: vi.fn() };

    const actor = constructAndRegisterAgentActor(registry, buildRuntimeDeps(cache), spec);

    expect(actor.agentId).toBe('agent-cache-1');
    expect(registry.register).toHaveBeenCalledWith('agent-cache-1', actor);
    expect(agentActorCtorSpy).toHaveBeenCalledOnce();
    const deps = agentActorCtorSpy.mock.calls[0]![0] as AgentTradingActorDeps;
    expect(deps.instrumentCache).toBeDefined();
    expect(deps.instrumentCache).toBe(cache);
    // The paired validation deps are threaded too (herobids index.ts:1274–1279).
    expect(deps.oneInchConfig).toEqual({ tokenSafetyNetwork: 'ethereum', chainId: 1 });
    expect(deps.canonicalTokens).toEqual({});
    expect(deps.perTradeLevelMonitorIntervalMs).toBe(7_000);
    // bindingProfile is intentionally NOT wired (agent-binding value, not config).
    expect(deps.bindingProfile).toBeUndefined();
  });
});
