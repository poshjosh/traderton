import {
  Decimal,
  type Decision,
  type DecisionId,
  type VenueAccountId,
  type InstrumentId,
  type DecisionIntent,
  type ActorType,
  type RiskPosture,
  type AgentRiskDefaultsConfig,
  type AgentRiskOverrides,
  type MarkSource,
} from '@traderton/domain';
import {
  submitDecisionForExecution,
  validatePerTradeLevels,
  DecisionContextHashMismatchError,
  createFillFirstMarkSource,
  type DecisionIntakeDeps,
} from '@traderton/engine';

import { createLogger } from '../logger.js';
import type { ExecutionActor } from '../execution-actor.js';
import { isIntakeRejection } from '../execution-actor.js';
import { AgentTradingActor, type AgentTradingActorDeps } from '../agent-trading-actor.js';
import type { VenueInstrumentCache } from '../venue-instrument-cache.js';
import { buildAgentRiskLimits } from '../agent-risk-limits.js';
import { POSITION_GROWING_INTENTS, formatLevelValidationMessage } from '../shared/decision-validation.js';

const logger = createLogger('decision-intake');

/**
 * The value a consumer submits for execution (Phase 9b item C — AUTHORED).
 *
 * Ports-carry-values (000/004): this is a plain decision **value**. It carries
 * no trading behaviour. The herobids handler took `(MessageEnvelope,
 * DecisionSubmitPayload)` — both are platform agent-protocol types that were
 * dropped in Phase 1 (they are owned by the consumer / item-D drive path). This
 * Traderton-owned input carries only the fields needed to build the engine
 * `Decision`, plus the routing key (`actorId`) and attribution
 * (`actorType`/`initiatorId`). The `envelope.createdAt` field maps to
 * `timestamp`; the caller stamps it.
 */
export interface DecisionSubmitInput {
  /** Registry key of the target ExecutionActor (bot id or agent id). */
  actorId: string;
  decisionId: string;
  instrumentId: string;
  intent: DecisionIntent;
  targetSize: string;
  limitPrice?: string | null;
  stopLoss?: string | null;
  takeProfit?: string | null;
  confidence?: number | null;
  rationaleSummary?: string;
  contextHash?: string;
  metadata?: Record<string, unknown>;
  /** ISO 8601 timestamp the decision was created (maps to Decision.timestamp). */
  timestamp: string;
  /** Actor attribution for the produced Decision (initiator, not the routing key). */
  actorType: ActorType;
  initiatorId: string;
  /** Optional swap token-safety override id (merged into intake deps). */
  safetyOverrideId?: string;
}

/** The typed result the handler returns to its caller (item D drives it). */
export type DecisionSubmitResult =
  | { status: 'accepted'; planId?: string; message?: string }
  | { status: 'rejected'; code: string; message: string; retryable: boolean }
  | { status: 'error'; code: string; message: string };

/**
 * submitDecision — the slim, authored decision router (Phase 9b item C).
 *
 * AUTHORED WIRING ONLY. It routes a decision **value** to a registered, running
 * ExecutionActor's own (already-copied) intake, then drives the already-copied
 * engine (`submitDecisionForExecution` / `validatePerTradeLevels`). It
 * re-implements no trading logic.
 *
 * Traced to herobids apps/worker/src/agents/agent-decision-handler.ts
 * (`handleDecisionSubmit`), keeping step 4→8 and DROPPING (per 013 §5 / 019 §4,
 * all platform / consumer-owned):
 *  - step 1 paused/stopped gate (agents table — platform)
 *  - step 2 stale_session gate (agent session lifecycle — platform)
 *  - step 3/3a authorizationMode + the entire approval_required block, short
 *    codes, Telegram, pending-approval, approvalRepo (approvals are
 *    consumer-owned; decision_approvals deleted — 004)
 *  - all eventPublisher emit / publish + decisionFailureRepo.recordFailure
 *    side-channels (event emits → item C2; M1 no-op)
 *  - the per-instrument circuit-breaker failure counters (they lived on the
 *    handler in herobids; kept simple here — the rejection is still typed. The
 *    actor's OWN VenueCircuitBreaker [via getIntakeDeps → circuit_breaker_open]
 *    is preserved. See the divergence note in 013 §5.)
 *
 * The composite resolver (herobids index.ts:818–864) collapses to its single
 * `actor?.isRunning` arm — there is no grant-fallback (locked decision (a)).
 */
export async function submitDecision(
  registry: Map<string, ExecutionActor>,
  input: DecisionSubmitInput,
): Promise<DecisionSubmitResult> {
  // 1. Resolve the target ExecutionActor from the registry. No actor / not
  //    running → instance_not_running. This is the whole "no grant-fallback"
  //    decision — there is no second arm.
  const actor = registry.get(input.actorId);
  if (!actor || !actor.isRunning) {
    return {
      status: 'rejected',
      code: 'instance_not_running',
      message: 'No execution context — ensure the actor is active and running',
      retryable: true,
    };
  }

  // 2. Resolve execution deps from the actor's own (copied) intake.
  const intakeResult = await actor.getIntakeDeps(input.instrumentId);
  if (!intakeResult) {
    return {
      status: 'rejected',
      code: 'instance_not_running',
      message: 'No execution context — actor is not ready to accept decisions',
      retryable: true,
    };
  }
  if (isIntakeRejection(intakeResult)) {
    return {
      status: 'rejected',
      code: intakeResult.code,
      message: intakeResult.message,
      retryable: intakeResult.retryable,
    };
  }
  const intakeDeps = intakeResult;

  // 3. Instrument-mismatch check — skip for agents (multi-symbol).
  if (intakeDeps.actorType !== 'agent' && input.instrumentId !== intakeDeps.symbol) {
    return {
      status: 'rejected',
      code: 'instrument_mismatch',
      message: 'Decision instrument does not match the actor symbol',
      retryable: false,
    };
  }

  // 4. Decision context + position from the actor's own (copied) intake.
  const context = await actor.getDecisionContext(input.instrumentId);
  if (!context) {
    return {
      status: 'rejected',
      code: 'no_context',
      message: 'No decision context available — actor may still be initializing or mark price unavailable',
      retryable: true,
    };
  }

  const position = await actor.getPosition(input.instrumentId);
  if (!position) {
    return {
      status: 'rejected',
      code: 'no_position_state',
      message: 'Position state not available',
      retryable: true,
    };
  }

  // 5. Build the Decision (verbatim field mapping from the reference).
  //    venueAccountId comes from intake.venueAccountId — the INJECTED value that
  //    flowed through the venue-account-direct seam (the actor was constructed
  //    with it), NOT a connection-grant join.
  const decision: Decision = {
    id: input.decisionId as DecisionId,
    venueAccountId: intakeDeps.venueAccountId as VenueAccountId,
    instrumentId: input.instrumentId as InstrumentId,
    intent: input.intent,
    targetSize: new Decimal(input.targetSize),
    limitPrice: input.limitPrice ? new Decimal(input.limitPrice) : undefined,
    stopLoss: input.stopLoss ? new Decimal(input.stopLoss) : undefined,
    takeProfit: input.takeProfit ? new Decimal(input.takeProfit) : undefined,
    timestamp: input.timestamp,
    contextHash: input.contextHash,
    metadata: {
      ...input.metadata,
      rationaleSummary: input.rationaleSummary,
      confidence: input.confidence,
    },
    actorType: input.actorType,
    actorId: input.initiatorId,
  };

  // 6. Per-trade stopLoss/takeProfit level validation for position-growing
  //    intents (the POSITION_GROWING_INTENTS block). Skip for exit intents.
  if (POSITION_GROWING_INTENTS.has(decision.intent) && (decision.stopLoss || decision.takeProfit)) {
    let validationSide: 'long' | 'short' | null = null;
    if (decision.intent === 'go_long') {
      validationSide = 'long';
    } else if (decision.intent === 'go_short') {
      validationSide = 'short';
    } else if (decision.intent === 'increase') {
      if (position.side === 'long' || position.side === 'short') {
        validationSide = position.side;
      }
      // Flat position with 'increase' intent is anomalous — skip validation.
    }

    if (validationSide) {
      const markPriceStr = context.referenceMark.price;
      let markPrice: Decimal | undefined;
      if (markPriceStr) {
        try {
          markPrice = new Decimal(markPriceStr);
        } catch {
          logger.warn({ decisionId: input.decisionId, markPriceStr }, 'Skipping per-trade level validation — malformed mark price');
        }
      }

      if (markPrice) {
        const validationError = validatePerTradeLevels({
          side: validationSide,
          markPrice,
          stopLoss: decision.stopLoss,
          takeProfit: decision.takeProfit,
        });

        if (validationError) {
          const message = formatLevelValidationMessage(validationError);
          return {
            status: 'rejected',
            code: `level.${validationError.reason}`,
            message,
            retryable: false,
          };
        }
      } else {
        logger.warn({ decisionId: input.decisionId }, 'Skipping per-trade level validation — mark price unavailable');
      }
    }
  }

  // 7. Submit through the shared (copied) decision-intake pipeline.
  try {
    const depsWithOverride: DecisionIntakeDeps = input.safetyOverrideId
      ? { ...intakeDeps, safetyOverrideId: input.safetyOverrideId }
      : intakeDeps;
    const result = await submitDecisionForExecution(decision, context, position, depsWithOverride);

    // Track execution outcome for the actor's circuit breaker.
    if (result.executionFailed) {
      actor.recordExecutionOutcome?.(false);
    } else if (result.executionResult) {
      actor.recordExecutionOutcome?.(true);
    }

    if (result.preExecutionRejection) {
      return {
        status: 'rejected',
        code: result.preExecutionRejection.code,
        message: result.preExecutionRejection.message,
        retryable: result.preExecutionRejection.retryable,
      };
    }

    if (result.riskRejected) {
      const riskCode = result.riskError?.code ?? 'risk.rejected';
      const riskMsg = result.riskError?.message ?? 'Decision rejected by risk gate';
      return { status: 'rejected', code: riskCode, message: riskMsg, retryable: false };
    }

    if (result.executionFailed) {
      const errCode = result.executionError?.code ?? 'execution.failed';
      const errMsg = result.executionError?.message ?? 'Decision accepted by risk gate but execution failed';
      return { status: 'error', code: errCode, message: errMsg };
    }

    // Accepted — execution succeeded or produced a no-op plan.
    return { status: 'accepted', planId: result.plan?.id, message: buildAcceptedMessage(decision) };
  } catch (err) {
    // 8. Typed rejection for a context-hash mismatch; other throws → error.
    if (err instanceof DecisionContextHashMismatchError) {
      return {
        status: 'rejected',
        code: 'context_hash_mismatch',
        message: 'Decision context hash does not match the server-resolved context',
        retryable: false,
      };
    }
    logger.error({ decisionId: input.decisionId, err }, 'Decision execution failed');
    const errMsg = err instanceof Error ? err.message : 'Unknown execution error';
    return { status: 'error', code: 'execution_error', message: errMsg };
  }
}

/**
 * Non-blocking reminder for position-growing intents missing stopLoss/takeProfit.
 * Copied shape from herobids agent-decision-handler.ts buildAcceptedMessage.
 */
function buildAcceptedMessage(decision: Decision): string | undefined {
  if (!POSITION_GROWING_INTENTS.has(decision.intent)) return undefined;
  const hasSl = decision.stopLoss !== undefined;
  const hasTp = decision.takeProfit !== undefined;
  if (!hasSl && !hasTp) {
    return "Accepted. Note: no stopLoss or takeProfit set — this position is unprotected if you're unable to trade.";
  }
  if (!hasSl) {
    return "Accepted. Note: no stopLoss set — this position has no downside protection if you're unable to trade.";
  }
  if (!hasTp) {
    return "Accepted. Note: no takeProfit set — profits won't be captured if you're unable to trade.";
  }
  return undefined;
}

// ── AgentTradingActor construct + register (Phase 9b item C, decision (c)) ─────

/**
 * The venue-account-direct injected values needed to construct an agent actor
 * that item B's factory does not already carry per-agent.
 *
 * Ports-carry-values: every field here is a platform-owned VALUE the consumer
 * injects (000/004). `venueAccountId` is the resolved venue-account (decisions
 * 11–13 — the connection-grant front-end is consumer-side, never resolved here).
 * `capital` / `riskPosture` / `riskOverrides` feed `buildAgentRiskLimits` and
 * come from the consumer / config — NEVER from the platform `agents` table.
 */
export interface AgentActorSpec {
  agentId: string;
  executionMode: 'paper' | 'shadow' | 'live';
  /** INJECTED resolved venue-account (decisions 11–13). Validated non-empty. */
  venueAccountId: string;
  venue: string;
  venueType: 'orderbook' | 'swap';
  swapAssets?: { baseAsset: string; quoteAsset: string; baseDecimals: number; quoteDecimals: number };
  /** INJECTED risk inputs (consumer/config) — fed to buildAgentRiskLimits. */
  capital?: string | null;
  riskPosture?: RiskPosture | null;
  riskOverrides?: AgentRiskOverrides;
}

/**
 * The item-B singletons the agent actor shares with bots. Item B constructs
 * these once-per-process; item C threads them into the agent actor's deps so B
 * and C compose over the same infrastructure.
 */
export interface AgentActorRuntimeDeps {
  venueAdapterFactory: AgentTradingActorDeps['venueAdapterFactory'];
  journal: AgentTradingActorDeps['journal'];
  idGen: AgentTradingActorDeps['idGen'];
  positionRepo: AgentTradingActorDeps['positionRepo'];
  fillRepo: AgentTradingActorDeps['fillRepo'];
  planRepo: AgentTradingActorDeps['planRepo'];
  orderRepo: AgentTradingActorDeps['orderRepo'];
  decisionRepo: AgentTradingActorDeps['decisionRepo'];
  balanceSnapshotRepo: AgentTradingActorDeps['balanceSnapshotRepo'];
  backtestingRepo: AgentTradingActorDeps['backtestingRepo'];
  reconciliationRepo: AgentTradingActorDeps['reconciliationRepo'];
  /** Worker-scoped fallback mark source (composite: Hyperliquid → oracle). */
  fallbackMarkSource: MarkSource;
  /** Per-actor createStreamPoolHandle closure (orderbook venues only). */
  createStreamPoolHandle?: (testnet: boolean) => AgentTradingActorDeps['streamPool'];
  reconciliationConfig?: AgentTradingActorDeps['reconciliationConfig'];
  streamConfig?: AgentTradingActorDeps['streamConfig'];
  liveRollout?: AgentTradingActorDeps['liveRollout'];
  driftAlertOnly?: boolean;
  feeConfig?: AgentTradingActorDeps['feeConfig'];
  maxConsecutiveVenueErrors?: number;
  slippageAlertBps?: number;
  crashPolicy?: AgentTradingActorDeps['crashPolicy'];
  liveOrderTimeoutPolicy?: AgentTradingActorDeps['liveOrderTimeoutPolicy'];
  /** Operator agent-risk defaults — fed to buildAgentRiskLimits (item A config). */
  agentRiskDefaults: AgentRiskDefaultsConfig;
  /** Staleness threshold for the per-actor fill-first mark source (marking config). */
  markStalenessThresholdMs: number;
  /**
   * Worker-scoped venue instrument cache for symbol validation at decision
   * intake (traced to herobids index.ts:1273 — the `instrumentCache` field).
   * Constructed + warmed once per process in item B's factory and shared by all
   * agent actors. When present + ready, the actor's copied
   * `validateTradeInstrument` gate (`agent-trading-actor.ts:~886`,
   * `if (this.deps.instrumentCache?.isReady())`) rejects `instrument_unknown`;
   * without it that copied KEEP behaviour silently fails open.
   */
  instrumentCache: VenueInstrumentCache;
  /**
   * 1inch operator config for swap-venue network resolution inside
   * `validateTradeInstrument` (herobids index.ts:1274 — `config.venues['1inch']`).
   */
  oneInchConfig?: { tokenSafetyNetwork?: string; chainId?: number };
  /**
   * Canonical token definitions for swap-venue quote-address validation
   * (herobids index.ts:1276 — `config.marketData?.tokenSafety?.canonicalTokens`).
   */
  canonicalTokens?: Record<string, Record<string, { address: string; name: string; aliases: string[] }>>;
  /**
   * Interval (ms) for the actor's per-trade stop-loss / take-profit monitor loop
   * (herobids index.ts:1279 — `config.agentRiskDefaults.perTradeLevelMonitorIntervalMs`).
   * Absent → the actor falls back to its hardcoded 5000ms default.
   */
  perTradeLevelMonitorIntervalMs?: number;
}

/**
 * The registry hooks item B exposes so item C registers/deregisters actors on
 * the SAME map (decision (b)). Item C never creates a second map.
 */
export interface ActorRegistryHooks {
  register(actorId: string, actor: ExecutionActor): void;
  deregister(actorId: string): void;
}

/**
 * constructAndRegisterAgentActor — build + register the agent-direct actor
 * (Phase 9b item C, decision (c)). AUTHORED WIRING ONLY.
 *
 * Traced to herobids apps/worker/src/index.ts:1209–1315 (the `new
 * AgentTradingActor({...})` construction), keeping the trading deps and
 * DROPPING the platform/scanner concerns per 019 §6:
 *  - riskLimits via buildAgentRiskLimits fed from INJECTED values (spec.capital
 *    / spec.riskPosture / spec.riskOverrides), NEVER an `agents` row.
 *  - status/event callbacks (onJournalEvent, emitAgentWake,
 *    onTechnicalScanComplete, …) → M1 no-op stubs (→ item C2).
 *  - onCrashed → deregister from the registry (trading lifecycle — kept).
 *  - the technical-scan / scanner-dedup / discover-candidates / fetch-candles
 *    machinery is agent-container drive concern (item D / consumer) — omitted
 *    here (optional deps; the actor runs without a scan loop).
 *  - swapTokenSafety left as item B left it (undefined — the existing Deferred
 *    token-safety divergence covers it; not re-opened).
 *  - instrumentCache + oneInchConfig + canonicalTokens +
 *    perTradeLevelMonitorIntervalMs threaded from the item-B runtime deps
 *    (traced to herobids index.ts:1273–1279) so the copied
 *    `validateTradeInstrument` `instrument_unknown` gate is live. `bindingProfile`
 *    is NOT wired — herobids sources it from the agent binding (`binding.profile`,
 *    index.ts:1275), a consumer/agent-container value not in Traderton config; it
 *    stays the actor's optional-undefined default.
 *
 * Does NOT start the actor or drive its lifecycle — that is item D / the M1
 * consumer. Returns the constructed actor; the caller starts it.
 */
export function constructAndRegisterAgentActor(
  registry: ActorRegistryHooks,
  runtimeDeps: AgentActorRuntimeDeps,
  spec: AgentActorSpec,
): AgentTradingActor {
  if (!spec.venueAccountId || spec.venueAccountId.trim().length === 0) {
    // Venue-account-direct seam: the injected venueAccountId must be present.
    // The venue-account-EXISTENCE guard (does this account row exist / have
    // credentials?) is enforced by the actor's own start() via
    // venueAdapterFactory (throws CredentialResolutionError) — NOT by resolving
    // a platform connection grant. See 019 §5.
    throw new Error(`Agent ${spec.agentId} has no injected venueAccountId — refusing to construct actor`);
  }

  // Per-actor fill-first mark source (agents/bots each get their own — the
  // actorId scopes fill lookups). Copied helper from @traderton/engine.
  const markSource = createFillFirstMarkSource({
    fillLookup: runtimeDeps.fillRepo,
    actorId: spec.agentId,
    fallbackSource: runtimeDeps.fallbackMarkSource,
    stalenessThresholdMs: runtimeDeps.markStalenessThresholdMs,
  });

  const deps: AgentTradingActorDeps = {
    agentId: spec.agentId,
    executionMode: spec.executionMode,
    venueAccountId: spec.venueAccountId,
    venue: spec.venue,
    venueType: spec.venueType,
    swapAssets: spec.swapAssets,
    // riskLimits via the AGENT path — buildAgentRiskLimits — fed from INJECTED
    // values (never the agents table). Traced to herobids index.ts:1224–1227.
    riskLimits: buildAgentRiskLimits(
      { capital: spec.capital ?? null, riskPosture: spec.riskPosture ?? null },
      runtimeDeps.agentRiskDefaults,
      spec.riskOverrides ?? {},
    ),
    venueAdapterFactory: runtimeDeps.venueAdapterFactory,
    createStreamPoolHandle: spec.venueType !== 'swap' ? runtimeDeps.createStreamPoolHandle : undefined,
    markSource,
    journal: runtimeDeps.journal,
    idGen: runtimeDeps.idGen,
    positionRepo: runtimeDeps.positionRepo,
    fillRepo: runtimeDeps.fillRepo,
    planRepo: runtimeDeps.planRepo,
    orderRepo: runtimeDeps.orderRepo,
    decisionRepo: runtimeDeps.decisionRepo,
    balanceSnapshotRepo: runtimeDeps.balanceSnapshotRepo,
    backtestingRepo: runtimeDeps.backtestingRepo,
    reconciliationRepo: runtimeDeps.reconciliationRepo,
    reconciliationConfig: runtimeDeps.reconciliationConfig,
    streamConfig: runtimeDeps.streamConfig,
    liveRollout: runtimeDeps.liveRollout,
    driftAlertOnly: runtimeDeps.driftAlertOnly,
    swapBaseTokenAddress: spec.venueType === 'swap' ? spec.swapAssets?.baseAsset : undefined,
    // swapTokenSafety: undefined — existing Deferred divergence (item B); not re-opened.
    swapTokenSafety: undefined,
    // Venue-specific instrument validation deps (traced to herobids
    // index.ts:1273–1279). instrumentCache is the load-bearing one — it gates the
    // copied `instrument_unknown` rejection (agent-trading-actor.ts:~886). Without
    // it that KEEP behaviour fails open. oneInchConfig/canonicalTokens support
    // swap-venue network + quote-address resolution inside validateTradeInstrument.
    // bindingProfile is NOT wired (agent-binding value, not config — left as the
    // actor's optional-undefined default).
    instrumentCache: runtimeDeps.instrumentCache,
    oneInchConfig: runtimeDeps.oneInchConfig,
    canonicalTokens: runtimeDeps.canonicalTokens,
    perTradeLevelMonitorIntervalMs: runtimeDeps.perTradeLevelMonitorIntervalMs,
    ...(spec.capital != null ? { capital: spec.capital } : {}),
    feeConfig: runtimeDeps.feeConfig,
    maxConsecutiveVenueErrors: runtimeDeps.maxConsecutiveVenueErrors,
    slippageAlertBps: runtimeDeps.slippageAlertBps,
    crashPolicy: runtimeDeps.crashPolicy,
    liveOrderTimeoutPolicy: runtimeDeps.liveOrderTimeoutPolicy,
    // Status/event callbacks — M1 no-op stubs (→ item C2). onCrashed keeps the
    // trading lifecycle: deregister from the registry on crash.
    onCrashed: async () => {
      registry.deregister(spec.agentId);
      logger.error({ agentId: spec.agentId }, 'Agent actor crashed — deregistered from registry');
    },
    onTechnicalScanComplete: () => {},
    emitAgentWake: async () => {},
    onJournalEvent: () => {},
  };

  const actor = new AgentTradingActor(deps);
  registry.register(spec.agentId, actor);
  logger.info({ agentId: spec.agentId, venue: spec.venue, venueType: spec.venueType }, 'Agent actor constructed and registered');
  return actor;
}

/**
 * stopAndDeregisterAgentActor — stop the actor and remove it from the registry
 * (Phase 9b item C). The lifecycle DRIVER (who decides to stop) is item D / the
 * M1 consumer; this is the paired teardown hook item C exposes.
 */
export async function stopAndDeregisterAgentActor(
  registry: ActorRegistryHooks,
  actor: AgentTradingActor,
): Promise<void> {
  await actor.stop();
  registry.deregister(actor.agentId);
  logger.info({ agentId: actor.agentId }, 'Agent actor stopped and deregistered');
}
