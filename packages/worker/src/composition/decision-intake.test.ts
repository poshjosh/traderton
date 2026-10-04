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
import type { ConsumerNotifier } from './consumer-notifier.js';
import type { TechnicalScanState } from '../scan-types.js';
import type { ActiveStrategy, AgentWakePayload, TechnicalConfig } from '@traderton/domain';
import type { PersistableScanCandidate, ScanMetricInput } from '../complete-technical-scan.js';

/** A fake ConsumerNotifier recording every call — the E3-T wiring assertion seam. */
function makeFakeNotifier(): ConsumerNotifier & {
  scanCompleted: ReturnType<typeof vi.fn>;
  agentWake: ReturnType<typeof vi.fn>;
  journalEvent: ReturnType<typeof vi.fn>;
  botStatus: ReturnType<typeof vi.fn>;
  agentStatus: ReturnType<typeof vi.fn>;
} {
  return {
    scanCompleted: vi.fn(async () => {}),
    agentWake: vi.fn(async () => {}),
    journalEvent: vi.fn(async () => {}),
    botStatus: vi.fn(async () => {}),
    agentStatus: vi.fn(async () => {}),
  };
}

/** A minimal TechnicalScanState with `count` placeholder signals for cap tests. */
function makeScanWithSignals(count: number): TechnicalScanState {
  return {
    timestamp: new Date().toISOString(),
    scanIntervalMs: 60_000,
    regimeResult: null,
    signals: Array.from({ length: count }, (_unused, i) => ({ symbol: `SYM-${i}` })) as TechnicalScanState['signals'],
    positionIndicators: [],
    summary: { scanned: count, rejected: 0, passed: count },
    symbolOutcomes: [],
    discovered: count,
    symbolsSelected: count,
    eligible: count,
    fetched: count,
    unsupported: 0,
    fetchFailures: 0,
    signalsGenerated: count,
  };
}

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
  function buildRuntimeDeps(
    cache: VenueInstrumentCache,
    opts?: { notifier?: ConsumerNotifier; scanMaxSignals?: number },
  ): AgentActorRuntimeDeps {
    return {
      fillRepo: { getLatestFillByInstrument: async () => null },
      fallbackMarkSource: { fetchMark: async () => ({ ok: false, error: { code: 'unavailable', message: 'stub' } }) },
      markStalenessThresholdMs: 30_000,
      agentRiskDefaults: AgentRiskDefaultsSchema.parse({}),
      instrumentCache: cache,
      oneInchConfig: { tokenSafetyNetwork: 'ethereum', chainId: 1 },
      canonicalTokens: {},
      perTradeLevelMonitorIntervalMs: 7_000,
      consumerNotifier: opts?.notifier ?? makeFakeNotifier(),
      scanMaxSignals: opts?.scanMaxSignals ?? 20,
    } as unknown as AgentActorRuntimeDeps;
  }

  const spec: AgentActorSpec = {
    agentId: 'agent-cache-1',
    ownerId: 'owner-1',
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

describe('constructAndRegisterAgentActor — consumer-notifier wiring (AUTHORED — E3-T T3)', () => {
  beforeEach(() => {
    agentActorCtorSpy.mockReset();
  });

  /** Local runtime-deps builder (only the fields the wiring reads matter). */
  function buildRuntimeDeps(
    cache: VenueInstrumentCache,
    opts?: { notifier?: ConsumerNotifier; scanMaxSignals?: number },
  ): AgentActorRuntimeDeps {
    return {
      fillRepo: { getLatestFillByInstrument: async () => null },
      fallbackMarkSource: { fetchMark: async () => ({ ok: false, error: { code: 'unavailable', message: 'stub' } }) },
      markStalenessThresholdMs: 30_000,
      agentRiskDefaults: AgentRiskDefaultsSchema.parse({}),
      instrumentCache: cache,
      consumerNotifier: opts?.notifier ?? makeFakeNotifier(),
      scanMaxSignals: opts?.scanMaxSignals ?? 20,
    } as unknown as AgentActorRuntimeDeps;
  }

  const spec: AgentActorSpec = {
    agentId: 'agent-notify-1',
    ownerId: 'owner-42',
    executionMode: 'paper',
    venueAccountId: 'va-1',
    venue: 'hyperliquid',
    venueType: 'orderbook',
  };

  /**
   * Construct the (stubbed) actor and hand back the deps the constructor
   * captured, so each test can invoke a callback directly. These callbacks only
   * fire once E1 wires the scan loop; driving them here proves the wiring in
   * isolation (plan T3).
   */
  function constructAndCaptureDeps(
    runtimeDeps: AgentActorRuntimeDeps,
    registry = { register: vi.fn(), deregister: vi.fn() },
  ): { deps: AgentTradingActorDeps; registry: { register: ReturnType<typeof vi.fn>; deregister: ReturnType<typeof vi.fn> } } {
    const cache = new VenueInstrumentCache({ info: () => {}, warn: () => {}, error: () => {} } as never);
    constructAndRegisterAgentActor(registry, { ...runtimeDeps, instrumentCache: cache }, spec);
    const deps = agentActorCtorSpy.mock.calls[0]![0] as AgentTradingActorDeps;
    return { deps, registry };
  }

  it('forwards a completed technical scan to the agent through the notifier', async () => {
    const notifier = makeFakeNotifier();
    const cache = new VenueInstrumentCache({ info: () => {}, warn: () => {}, error: () => {} } as never);
    const { deps } = constructAndCaptureDeps(buildRuntimeDeps(cache, { notifier }));
    const scan = makeScanWithSignals(3);

    await deps.onTechnicalScanComplete!('agent-notify-1', scan);

    expect(notifier.scanCompleted).toHaveBeenCalledOnce();
    expect(notifier.scanCompleted).toHaveBeenCalledWith({
      ownerId: 'owner-42',
      agentId: 'agent-notify-1',
      scan,
    });
  });

  it('caps scan signals at the configured maximum and flags truncation', async () => {
    const notifier = makeFakeNotifier();
    const cache = new VenueInstrumentCache({ info: () => {}, warn: () => {}, error: () => {} } as never);
    const { deps } = constructAndCaptureDeps(buildRuntimeDeps(cache, { notifier, scanMaxSignals: 5 }));

    await deps.onTechnicalScanComplete!('agent-notify-1', makeScanWithSignals(12));

    expect(notifier.scanCompleted).toHaveBeenCalledOnce();
    const forwarded = notifier.scanCompleted.mock.calls[0]![0] as {
      scan: TechnicalScanState & { signalsTruncated?: boolean };
    };
    expect(forwarded.scan.signals).toHaveLength(5);
    expect(forwarded.scan.signalsTruncated).toBe(true);
  });

  it('does not flag truncation when the scan fits under the cap', async () => {
    const notifier = makeFakeNotifier();
    const cache = new VenueInstrumentCache({ info: () => {}, warn: () => {}, error: () => {} } as never);
    const { deps } = constructAndCaptureDeps(buildRuntimeDeps(cache, { notifier, scanMaxSignals: 20 }));

    await deps.onTechnicalScanComplete!('agent-notify-1', makeScanWithSignals(3));

    const forwarded = notifier.scanCompleted.mock.calls[0]![0] as {
      scan: TechnicalScanState & { signalsTruncated?: boolean };
    };
    expect(forwarded.scan.signals).toHaveLength(3);
    expect(forwarded.scan.signalsTruncated).toBeUndefined();
  });

  it('routes an agent wake through the notifier', async () => {
    const notifier = makeFakeNotifier();
    const cache = new VenueInstrumentCache({ info: () => {}, warn: () => {}, error: () => {} } as never);
    const { deps } = constructAndCaptureDeps(buildRuntimeDeps(cache, { notifier }));
    const wake: AgentWakePayload = {
      wakeId: 'wake-1',
      reason: 'scanner signals',
      source: 'scanner',
      context: { signalCount: 2 },
    } as AgentWakePayload;

    await deps.emitAgentWake!('agent-notify-1', wake);

    expect(notifier.agentWake).toHaveBeenCalledWith({
      ownerId: 'owner-42',
      agentId: 'agent-notify-1',
      wake,
    });
  });

  it('routes a journal event through the notifier with a JSON detail and null botId', async () => {
    const notifier = makeFakeNotifier();
    const cache = new VenueInstrumentCache({ info: () => {}, warn: () => {}, error: () => {} } as never);
    const { deps } = constructAndCaptureDeps(buildRuntimeDeps(cache, { notifier }));

    deps.onJournalEvent!({ type: 'reconciliation.drift', payload: { symbol: 'BTC/USD:USD' } });
    // Let the floated best-effort write settle.
    await Promise.resolve();

    expect(notifier.journalEvent).toHaveBeenCalledWith({
      ownerId: 'owner-42',
      agentId: 'agent-notify-1',
      botId: null,
      journalType: 'reconciliation.drift',
      detail: JSON.stringify({ symbol: 'BTC/USD:USD' }),
    });
  });

  it('deregisters and notifies agent_status crashed when the actor crashes', async () => {
    const notifier = makeFakeNotifier();
    const cache = new VenueInstrumentCache({ info: () => {}, warn: () => {}, error: () => {} } as never);
    const { deps, registry } = constructAndCaptureDeps(buildRuntimeDeps(cache, { notifier }));

    await deps.onCrashed!(new Error('venue stream died'));

    expect(registry.deregister).toHaveBeenCalledWith('agent-notify-1');
    expect(notifier.agentStatus).toHaveBeenCalledWith({
      ownerId: 'owner-42',
      agentId: 'agent-notify-1',
      status: 'crashed',
      error: 'venue stream died',
    });
  });
});

describe('constructAndRegisterAgentActor — technical scan loop wiring (AUTHORED — E1-T T4)', () => {
  beforeEach(() => {
    agentActorCtorSpy.mockReset();
  });

  /** A minimal resolved technical config (only the fields the wiring reads). */
  function makeTechnical(): TechnicalConfig {
    return {
      filters: { venue: 'hyperliquid', venueType: 'orderbook', quoteAssetSymbol: 'USDC' },
      candles: { interval: '1h', limit: 200 },
      indicators: {},
      signalBias: {},
      scanIntervalMs: 60_000,
    } as unknown as TechnicalConfig;
  }

  function makeActiveStrategy(): ActiveStrategy {
    return {
      presetKey: 'momentum',
      styleTier: 'standard',
      behaviorVersion: 'ts-standard-v1',
      technical: makeTechnical(),
      source: 'creator',
      changedAt: new Date().toISOString(),
    };
  }

  /** A spy AgentScanRepository recording insertCandidates / insertMetrics calls. */
  function makeScanRepo(): { insertCandidates: ReturnType<typeof vi.fn>; insertMetrics: ReturnType<typeof vi.fn> } {
    return { insertCandidates: vi.fn(async () => {}), insertMetrics: vi.fn(async () => {}) };
  }

  /**
   * Build runtime deps carrying the T4 scan singletons. fetchCandles /
   * discoverCandidates registry / scanRepo are the load-bearing ones the wiring
   * reads; the rest are the base deps the stubbed actor never touches.
   */
  function buildScanRuntimeDeps(opts: {
    scanRepo?: { insertCandidates: ReturnType<typeof vi.fn>; insertMetrics: ReturnType<typeof vi.fn> };
    withScanSingletons?: boolean;
    markOk?: boolean;
  }): AgentActorRuntimeDeps {
    const base = {
      fillRepo: { getLatestFillByInstrument: async () => null },
      fallbackMarkSource: { fetchMark: async () => ({ ok: false, error: { code: 'unavailable', message: 'stub' } }) },
      markStalenessThresholdMs: 30_000,
      agentRiskDefaults: AgentRiskDefaultsSchema.parse({}),
      instrumentCache: new VenueInstrumentCache({ info: () => {}, warn: () => {}, error: () => {} } as never),
      consumerNotifier: makeFakeNotifier(),
      scanMaxSignals: 20,
    };
    if (opts.withScanSingletons === false) {
      return base as unknown as AgentActorRuntimeDeps;
    }
    return {
      ...base,
      // Per-actor mark source resolves to the fallback (ok:false by default),
      // so the orderbook mark-coverage filter is exercised. markOk flips it.
      fallbackMarkSource: {
        fetchMark: async () =>
          opts.markOk
            ? { ok: true, data: { instrument: 'x', price: '1', source: 'oracle', timestamp: new Date().toISOString() } }
            : { ok: false, error: { code: 'unavailable', message: 'stub' } },
      },
      getMarketDataRegistry: () => undefined, // no registry → DEX candidates persist defensively
      scannerCandleFetcher: vi.fn(async () => []),
      scanRepo: opts.scanRepo,
      candleFetchRetry: { enabled: true, maxRetries: 3, baseDelayMs: 250, maxDelayMs: 2000 },
      candleFetchBreaker: undefined,
      maxConcurrentScans: 4,
      scannerMaxCandidates: 20,
      signalFingerprintStore: { get: async () => null, set: async () => undefined },
      scannerSignalDedup: { enabled: true, topN: 5, confidenceBucketSize: 0.05, ttlSeconds: 600 },
      swapScannerConfig: { enabled: false },
    } as unknown as AgentActorRuntimeDeps;
  }

  const scanSpec: AgentActorSpec = {
    agentId: 'agent-scan-1',
    ownerId: 'owner-7',
    executionMode: 'paper',
    venueAccountId: 'va-1',
    venue: 'hyperliquid',
    venueType: 'orderbook',
    scanMode: 'scanner_gated',
    activeStrategy: makeActiveStrategy(),
  };

  function captureDeps(spec: AgentActorSpec, runtimeDeps: AgentActorRuntimeDeps): AgentTradingActorDeps {
    const registry = { register: vi.fn(), deregister: vi.fn() };
    constructAndRegisterAgentActor(registry, runtimeDeps, spec);
    return agentActorCtorSpy.mock.calls[0]![0] as AgentTradingActorDeps;
  }

  it('starts a scan loop for a scanner-gated agent', () => {
    const deps = captureDeps(scanSpec, buildScanRuntimeDeps({ scanRepo: makeScanRepo() }));

    // The copied loop starts iff technicalConfig + discoverCandidates +
    // fetchCandles are all present — assert the wiring fed all three.
    expect(deps.technicalConfig).toEqual(scanSpec.activeStrategy!.technical);
    expect(deps.isHybridMode).toBe(true);
    expect(typeof deps.discoverCandidates).toBe('function');
    expect(typeof deps.fetchCandles).toBe('function');
    expect(deps.maxConcurrentScans).toBe(4);
    expect(deps.signalFingerprintStore).toBeDefined();
    expect(deps.scannerSignalDedup).toEqual({ enabled: true, topN: 5, confidenceBucketSize: 0.05, ttlSeconds: 600 });
    expect(typeof deps.onPersistScanCandidates).toBe('function');
    expect(typeof deps.onPersistScanMetrics).toBe('function');
  });

  it('runs no scan loop when scan mode is absent', () => {
    const noScanSpec: AgentActorSpec = { ...scanSpec, scanMode: null, activeStrategy: null };
    const deps = captureDeps(noScanSpec, buildScanRuntimeDeps({ scanRepo: makeScanRepo() }));

    expect(deps.technicalConfig).toBeUndefined();
    expect(deps.discoverCandidates).toBeUndefined();
    expect(deps.fetchCandles).toBeUndefined();
    expect(deps.onPersistScanCandidates).toBeUndefined();
    expect(deps.onPersistScanMetrics).toBeUndefined();
  });

  it('runs no scan loop when scan mode is set but the active strategy is absent', () => {
    const noStratSpec: AgentActorSpec = { ...scanSpec, scanMode: 'scanner_gated', activeStrategy: null };
    const deps = captureDeps(noStratSpec, buildScanRuntimeDeps({ scanRepo: makeScanRepo() }));

    // scanMode set but no resolved strategy ⇒ the actor runs without a scan loop.
    expect(deps.technicalConfig).toBeUndefined();
    expect(deps.discoverCandidates).toBeUndefined();
    expect(deps.fetchCandles).toBeUndefined();
  });

  it('persists scan candidates and metrics after a scan', async () => {
    const scanRepo = makeScanRepo();
    // markOk: true → the orderbook mark-coverage filter passes the candidate through.
    const deps = captureDeps(scanSpec, buildScanRuntimeDeps({ scanRepo, markOk: true }));

    const candidate: PersistableScanCandidate = {
      id: 'cand-1',
      agentId: 'agent-scan-1',
      scannedAt: new Date().toISOString(),
      scanVersion: 'ts-standard-v1',
      activePresetKey: 'momentum',
      presetBehaviorVersion: 'ts-standard-v1',
      instrumentKind: 'orderbook',
      venueFamily: 'hyperliquid',
      styleTier: 'standard',
      symbol: 'BTC',
      candidateRank: 1,
      signalFacts: {},
      disposition: 'entry_candidate',
    };
    await deps.onPersistScanCandidates!([candidate]);

    expect(scanRepo.insertCandidates).toHaveBeenCalledOnce();
    expect(scanRepo.insertCandidates.mock.calls[0]![0]).toEqual([candidate]);

    const metric: ScanMetricInput = {
      agentId: 'agent-scan-1',
      presetKey: 'momentum',
      presetBehaviorVersion: 'ts-standard-v1',
      venueFamily: 'hyperliquid',
      styleTier: 'standard',
      scanScope: { discovered: 1, symbolsSelected: 1, eligible: 1, fetched: 1, scored: 1, signals: 1 },
      scannedAt: new Date().toISOString(),
      candidatesDiscovered: 1,
      candidatesScored: 1,
      signalsGenerated: 1,
      scanHealth: 'healthy_signals',
      topConfidence: 0.9,
      regimeBucket: null,
    };
    await deps.onPersistScanMetrics!(metric);

    expect(scanRepo.insertMetrics).toHaveBeenCalledOnce();
    expect(scanRepo.insertMetrics.mock.calls[0]![0]).toEqual(metric);
  });

  it('drops an orderbook candidate whose mark is unavailable before persisting', async () => {
    const scanRepo = makeScanRepo();
    // markOk: false → the mark-coverage filter drops the orderbook candidate.
    const deps = captureDeps(scanSpec, buildScanRuntimeDeps({ scanRepo, markOk: false }));

    await deps.onPersistScanCandidates!([
      {
        id: 'cand-2',
        agentId: 'agent-scan-1',
        scannedAt: new Date().toISOString(),
        scanVersion: 'v1',
        activePresetKey: 'momentum',
        presetBehaviorVersion: 'v1',
        instrumentKind: 'orderbook',
        venueFamily: 'hyperliquid',
        styleTier: 'standard',
        symbol: 'ETH',
        candidateRank: 1,
        signalFacts: {},
        disposition: 'entry_candidate',
      },
    ]);

    // All candidates filtered out → nothing inserted.
    expect(scanRepo.insertCandidates).not.toHaveBeenCalled();
  });

  it('persists a DEX candidate defensively even when no price registry is available', async () => {
    const scanRepo = makeScanRepo();
    // getMarketDataRegistry → undefined, so the DEX pricing check is skipped and
    // the candidate is persisted anyway (defensive).
    const deps = captureDeps(scanSpec, buildScanRuntimeDeps({ scanRepo, markOk: false }));

    const dexCandidate: PersistableScanCandidate = {
      id: 'cand-dex',
      agentId: 'agent-scan-1',
      scannedAt: new Date().toISOString(),
      scanVersion: 'v1',
      activePresetKey: 'momentum',
      presetBehaviorVersion: 'v1',
      instrumentKind: 'dex',
      venueFamily: 'jupiter',
      styleTier: 'standard',
      symbol: 'WIF',
      network: 'solana',
      address: '0xabc',
      candidateRank: 1,
      signalFacts: {},
      disposition: 'entry_candidate',
    };
    await deps.onPersistScanCandidates!([dexCandidate]);

    expect(scanRepo.insertCandidates).toHaveBeenCalledOnce();
    expect(scanRepo.insertCandidates.mock.calls[0]![0]).toEqual([dexCandidate]);
  });
});
