// In-process drive target + bot-lifecycle handler (Phase 9b item D — AUTHORED
// seam / wiring). Do NOT confuse with a copy of the herobids platform broker.
//
// herobids ran the agent container and the message broker as SEPARATE processes:
// the drive-path tools `xadd`-ed an envelope to a Redis stream (`publishToInbound`,
// apps/worker/src/agent.ts:1229) that the broker consumed and routed by
// `envelope.type` (`processInbound`, agent-message-broker.ts:140/:277/:321).
// Traderton M1 is an in-process library (000/005), so the transport hop collapses
// to a synchronous in-process dispatch. THIS FILE IS THE AUTHORED SEAM — the
// transport cut — NOT authored trading behaviour: it carries a decision/command
// VALUE to Traderton-owned surfaces (item C's `submitDecision`, the bot
// lifecycle) and injects no planning/risk/execution behaviour
// (ports-carry-values, 000/004).
//
// Traces (herobids, READ-ONLY reference):
//  - `publishToInbound`            agent.ts:1229
//  - `processInbound` routing      agent-message-broker.ts:140 / :277 / :321
//  - decision reply write          instance-event-publisher.ts:134 (lpush + expire)
//  - `handleManageBot` TRADING CORE agent-message-broker.ts:552–988 (the
//    agent/session/connection-grant/LLM-model-policy SHELL is DROPPED — platform,
//    decisions 7–13; see the per-action notes below).

import type { Redis } from 'ioredis';
import {
  AGENT_MESSAGE_TYPES,
  BotConfigSchema,
  checkModeEscalation,
  validateExecutionCapability,
  type DecisionIntent,
  type ManageBotResult,
} from '@traderton/domain';

import { createLogger } from '../logger.js';
import type { WorkerRuntime } from '../runtime.js';
import type { DecisionSubmitInput, DecisionSubmitResult } from './decision-intake.js';

const logger = createLogger('drive-target');

/** Bot row shape the handler reads (the subset of the `@traderton/db` bot row). */
export interface DriveBotRecord {
  id: string;
  status: string;
  config: Record<string, unknown>;
  creatorType: string;
  creatorId: string | null;
  ownerId: string;
  /**
   * The bot's bound venue account (the `bots.venue_account_id` COLUMN — read-only
   * here). The ActorFactory reads `venueAccountId` from the config it is handed,
   * so `startBot` stamps this onto the enqueued config; the persisted row is the
   * source of truth for a bot's actual account (decisions 11–13).
   */
  venueAccountId: string;
  startedAt: Date | null;
  stoppedAt: Date | null;
}

/**
 * The bot-repository surface the handler drives. A subset of the `@traderton/db`
 * `BotRepository` (the persist/limit primitives were deleted Phase 2 —
 * platform-coupled; their re-keyed replacement is item E, see `botLimit` below).
 */
export interface DriveBotRepo {
  getBotById(botId: string): Promise<DriveBotRecord | null>;
  updateBotConfig(botId: string, config: Record<string, unknown>): Promise<void>;
  restoreBotConfig(botId: string, config: Record<string, unknown>): Promise<void>;
  markBotStopped(botId: string): Promise<void>;
  markBotRunning(botId: string): Promise<void>;
  restoreBotRuntimeState(state: { botId: string; status: string; startedAt: Date | null; stoppedAt: Date | null }): Promise<void>;
}

/**
 * The per-`ownerId` maxBots limit seam — ITEM E fills this (013 §7 / 021 §9).
 *
 * In herobids the create/start persistence was `tryCreateBotWithLimit` /
 * `tryMarkBotRunningWithLimit`: an ATOMIC count+insert (create) / count+mark
 * (start) that BOTH persisted the bot row AND enforced the per-agent limit in a
 * single transaction (row-locking the platform `agents` table). Those methods
 * were deleted from `@traderton/db` in Phase 2 (platform-coupled); their
 * re-keyed (per-`ownerId`, Postgres-advisory-lock) replacement is the item-E
 * authored primitive. Because create-persistence and the limit are ONE atomic
 * operation in the source, item D exposes them as ONE injected seam here rather
 * than as a separate limit pre-check + a (non-existent) `botRepo.insertBot` —
 * D authors ONLY the seam SHAPE + the wiring around it, never the limit or the
 * insert.
 *
 * SURFACED (refines 021 §5, which assumed a separable `botLimitCheck?(ownerId)`
 * pre-check + `botRepo` persist): the persist method does not exist and cannot be
 * authored in D without pre-empting item E's atomic primitive, so the create/
 * start limit-and-persist is modelled as this atomic seam. At M1 (pre-E) the seam
 * is absent → `create_and_start` / a non-reclaim `start` return a clear
 * `bot_limit_unavailable` result (parity is not degraded: herobids ALWAYS ran
 * with the limit wired; Traderton simply refuses rather than persisting without
 * it). Item E injects the seam and the paths become fully live.
 */
export interface BotLimitSeam {
  /**
   * Atomically enforce the per-`ownerId` limit and create the bot (create_and_start).
   * Returns the new bot id, or `created:false` when the limit is reached.
   * The re-keyed herobids `tryCreateBotWithLimit` (item E).
   */
  tryCreateBotWithLimit(spec: {
    ownerId: string;
    venueAccountId: string;
    config: Record<string, unknown>;
    creatorType: string;
    creatorId: string;
  }): Promise<{ created: boolean; botId?: string }>;
  /**
   * Atomically enforce the per-`ownerId` limit and mark a bot running (non-reclaim
   * start). Returns whether the running slot was claimed. The re-keyed herobids
   * `tryMarkBotRunningWithLimit` (item E). Reclaim (bot already running) is exempt
   * and does not call this.
   */
  tryMarkBotRunningWithLimit(spec: {
    botId: string;
    ownerId: string;
    creatorType: string;
    creatorId: string;
  }): Promise<boolean>;
}

/**
 * Minimal redis surface the decision-reply write needs — the in-process
 * expression of herobids `publishDecisionReply` (instance-event-publisher.ts:134):
 * `lpush(replyKey, JSON.stringify(reply))` + `expire(replyKey, 60)`, which the
 * copied `tools/trading.ts` awaits via `blpop(replyKey, 30)`.
 */
export interface DriveReplyRedis {
  lpush(key: string, value: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

/**
 * The injected identity / venue VALUES + surfaces the drive target binds to
 * (ports-carry-values). At M1 the consumer constructs one drive target per
 * owned actor, supplying:
 *  - `ownerId` — the authenticated soft owner (decision 10; NOT the `agents`
 *    table). Bots are owner-scoped, and ownership on start/stop/adjust is
 *    validated against THIS value (herobids used `bot.userId === agent.userId`;
 *    dropped the agents table).
 *  - `actorId` — the registry key the decision routes to (bot id / agent id);
 *    also `creatorId` for created bots (decision (a): `ctx.agentId` /
 *    `creatorType='agent'` is the M1 ownership scope — the tools stay byte-faithful).
 *  - `ownerMode` — the owner/agent execution mode for the mode-escalation guard.
 *  - `venue` / `venueType` / `venueAccountId` — INJECTED (decisions 11–13); the
 *    herobids connection-grant resolution (`getRuntimeCapabilityDescriptor`,
 *    `getResolvedVenueAccount`, `isConnectionOwnedBy`) + LLM-model policy +
 *    `applyAgentCapitalLimit` + `emitInstanceStatus` are ALL DROPPED.
 */
export interface DriveTargetDeps {
  /** The BullMQ-backed lifecycle control (item B). The handler drives it via `enqueueLifecycle` only. */
  runtime: Pick<WorkerRuntime, 'enqueueLifecycle'>;
  /** Item C's decision router (exposed on `TradingRuntime.submitDecision`). */
  submitDecision(input: DecisionSubmitInput): Promise<DecisionSubmitResult>;
  /** Bot persistence/state surface (`@traderton/db` BotRepository subset). */
  botRepo: DriveBotRepo;
  /** Redis for the synchronous decision-reply write (lpush + expire). */
  redis: Pick<Redis, 'lpush' | 'expire'>;
  /** Per-`ownerId` maxBots limit + create/start persistence seam — item E fills it. */
  botLimit?: BotLimitSeam;

  // ── Injected identity / venue VALUES (per owned actor) ──
  ownerId: string;
  actorId: string;
  ownerMode: 'paper' | 'shadow' | 'live';
  venue: string;
  venueType: 'orderbook' | 'swap';
  venueAccountId: string;
}

/**
 * The `TradingToolContext.publishToInbound` port shape. Resolves `void` for most
 * message types; a `MANAGE_BOT` create_and_start resolves a `ManageBotResult`
 * carrying the synchronously-persisted `botId` (A1 — the row + id are synchronous;
 * only the actor START is deferred). Kept structurally identical to the domain
 * `TradingToolContext.publishToInbound` so `createDriveTarget` remains assignable.
 */
export type PublishToInbound = (
  type: string,
  payload: Record<string, unknown>,
) => Promise<void | ManageBotResult>;

/** The manage_bot payload shape the copied tools emit (herobids ManageBotPayload). */
interface ManageBotPayload {
  action: 'create_and_start' | 'start' | 'stop' | 'restart' | 'adjust_config';
  connectionId?: string;
  config?: Record<string, unknown>;
  botId?: string;
  rationale?: string;
}

/** Deep-merge patch into base (traces herobids `mergeBotConfig`, broker :1871). */
function mergeBotConfig(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = merged[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      merged[key] = mergeBotConfig(current, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * handleManageBot — the bot-lifecycle handler (Phase 9b item D — AUTHORED wiring).
 *
 * Traces the TRADING CORE of herobids `handleManageBot` (agent-message-broker.ts
 * :552–988) over the copied `WorkerRuntime` (via `enqueueLifecycle`); it
 * re-implements no start/stop/reclaim mechanics. It DROPS the platform shell —
 * `agentRepo.getAgent`/`getActiveSession`, the connection-grant descriptor
 * resolution, `resolveEffectiveLlmSelection`/`getUserAiModelConfig`,
 * `applyAgentCapitalLimit`, `emitInstanceStatus` — all consumer-owned
 * (decisions 7–13). `venue`/`venueType`/`venueAccountId` are INJECTED; ownership
 * is validated against the injected `ownerId`, never the `agents` table.
 */
export async function handleManageBot(
  deps: DriveTargetDeps,
  payload: ManageBotPayload,
): Promise<void | ManageBotResult> {
  switch (payload.action) {
    case 'create_and_start':
      return createAndStart(deps, payload);
    case 'start':
      return startBot(deps, payload);
    case 'stop':
      return stopBot(deps, payload);
    case 'restart':
      return restartBot(deps, payload);
    case 'adjust_config':
      return adjustConfig(deps, payload);
    default:
      throw new Error(`Unknown manage_bot action: ${(payload as { action: string }).action}`);
  }
}

async function createAndStart(deps: DriveTargetDeps, payload: ManageBotPayload): Promise<ManageBotResult> {
  if (!payload.config) throw new Error('config is required for create_and_start');

  // Stamp the INJECTED venue/venueType onto the raw config before validation —
  // agent-provided venue values are discarded (herobids broker :604–606). The
  // connection-grant resolution + LLM-model-policy stamping + applyAgentCapitalLimit
  // that wrapped this in herobids are DROPPED (platform, decisions 7–13).
  const rawConfig: Record<string, unknown> = {
    ...payload.config,
    venue: deps.venue,
    venueType: deps.venueType,
  };

  // Execution-capability guard (B1) — restores the pre-migration API-route parity
  // gap (herobids rejected paper+swap with a 400 at write time before the broker;
  // the boundary validated it nowhere). Copied from the quarantined API route
  // (packages/worker/src/_deferred-authoring/api-routes/bots.ts): it calls
  // `validateExecutionCapability({ actorType, executionMode, venueType })` and
  // surfaces the dedicated `execution_capability.<code>` on failure.
  //
  // GATED on an explicit mode being PRESENT in the raw config — faithfully mirrors
  // the source route's `if (botVenueType && botExecutionMode)`. A config with no
  // explicit mode is left to `BotConfigSchema` (which defaults `execution.mode` to
  // 'paper' and owns shape validation), so this guard does NOT shadow generic
  // schema failures (missing strategy, missing mode) with `execution_mode_required`.
  // Runs BEFORE the schema parse so paper+swap yields the DEDICATED code rather
  // than the generic schema-refine failure (`Bot config is invalid: …`), which
  // also rejects paper+swap and would otherwise shadow it. `deps.venueType` is the
  // INJECTED venue type.
  const requestedMode = (rawConfig['execution'] as Record<string, unknown> | undefined)?.['mode'] as
    | 'paper'
    | 'shadow'
    | 'live'
    | undefined;
  if (requestedMode) {
    const capCheck = validateExecutionCapability({
      actorType: 'agent',
      executionMode: requestedMode,
      venueType: deps.venueType,
    });
    if (!capCheck.ok) {
      // Carry the DEDICATED code so the boundary can surface the paper_swap identity
      // distinctly from a generic schema-validation failure (see `create_bot`'s
      // capability-error mapping in tools/bots.ts). Namespaced as the herobids API
      // route did: `execution_capability.<code>`.
      const capError = new Error(capCheck.error.message) as Error & { code?: string };
      capError.code = `execution_capability.${capCheck.error.code}`;
      throw capError;
    }
  }

  // Validate the full config against the (mechanical-only, item A′) schema before
  // persisting (herobids broker :651–658).
  const validation = BotConfigSchema.safeParse(rawConfig);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
      .join('; ');
    throw new Error(`Bot config is invalid: ${issues}`);
  }
  const validatedConfig = validation.data;

  // Mode-escalation guard: bot execution mode must not exceed the owner's own
  // (herobids broker :666–671; `agentMode` → the injected `ownerMode`).
  const botMode = validatedConfig.execution.mode ?? 'paper';
  const modeCheck = checkModeEscalation(botMode, deps.ownerMode, 'create');
  if (!modeCheck.allowed) {
    throw new Error(modeCheck.error);
  }

  // Swap-venue symbol-format guard — copied VERBATIM from herobids
  // `agent-message-broker.ts:693–714` (a KEEP trading-domain validation, gated on
  // the INJECTED `venueType === 'swap'`). Each swap-venue binding maps to a specific
  // chain; reject bot creation when the symbol format is wrong or the symbol parts
  // look like raw addresses instead of human-readable tickers. NOT covered by
  // `BotConfigSchema` (plain `z.string()`), and distinct from the later per-decision
  // `swap.instrument_format` intake gate. Per-token network validity is enforced
  // downstream by token safety.
  if (deps.venueType === 'swap' && validatedConfig.symbol) {
    const symbol = validatedConfig.symbol;
    if (typeof symbol !== 'string') {
      throw new Error(
        `Invalid symbol type. Expected a string BASE/QUOTE format (e.g. "ETH/USDC"), got ${typeof symbol}.`,
      );
    }
    const parts = symbol.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(
        `Invalid symbol format "${symbol}". ` +
        `Swap venues require BASE/QUOTE format (e.g. "ETH/USDC" for 1inch on Base).`,
      );
    }
    // Reject raw addresses — agents must use human-readable symbols.
    const looksLikeAddress = (s: string) => s.startsWith('0x') || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
    if (looksLikeAddress(parts[0]!) || looksLikeAddress(parts[1]!)) {
      throw new Error(
        `Symbol "${symbol}" looks like a raw token address. ` +
        `Use a human-readable symbol (e.g. "ETH/USDC"), not a contract address.`,
      );
    }
  }

  // Atomic per-`ownerId` limit + persist (item E seam). herobids did this via
  // `tryCreateBotWithLimit` (broker :707–718) then `botStart` (:748). Absent at
  // M1 (pre-E) → refuse rather than persist without the limit.
  if (!deps.botLimit) {
    throw new Error('bot_limit_unavailable: limit-enforced bot creation is not configured (item E)');
  }
  const createResult = await deps.botLimit.tryCreateBotWithLimit({
    ownerId: deps.ownerId,
    venueAccountId: deps.venueAccountId,
    config: validatedConfig as unknown as Record<string, unknown>,
    creatorType: 'agent',
    creatorId: deps.actorId,
  });
  if (!createResult.created || !createResult.botId) {
    throw new Error('Agent has reached its max concurrent bots limit. Stop a bot before creating a new one.');
  }
  const botId = createResult.botId;
  logger.info({ ownerId: deps.ownerId, botId }, 'Bot created via manage_bot');

  // Claim the running slot (create → mark), mirroring the herobids broker
  // (agent-message-broker.ts:738–743): the create inserts `status:'stopped'`, then
  // this atomic mark transitions to `running` before the start job enqueues. The
  // `running` mark is the `WorkerRuntime.reclaimOrphans` crash-recovery contract
  // (013 §7 decision 2). Absent the limit slot → reject with the herobids-parity
  // message (item E).
  const claimed = await deps.botLimit.tryMarkBotRunningWithLimit({
    botId,
    ownerId: deps.ownerId,
    creatorType: 'agent',
    creatorId: deps.actorId,
  });
  if (!claimed) {
    throw new Error('Agent has reached its max concurrent bots limit. Stop a bot before creating a new one.');
  }

  // Enqueue the start lifecycle job. The ActorFactory reads `venueAccountId` +
  // `ownerId` from the config object it is handed (create-trading-runtime.ts
  // ~:435), and `processJob('start')` starts the actor from the job config
  // DIRECTLY — so the ENQUEUED config must carry the INJECTED venueAccountId +
  // ownerId. The persisted `bots` row holds them in its columns (via the item-E
  // limit seam); this stamps them onto the config so the factory is self-sufficient
  // — matching how the production `instanceLoader` re-attaches them per item B.
  await deps.runtime.enqueueLifecycle('start', botId, {
    ...(validatedConfig as unknown as Record<string, unknown>),
    venueAccountId: deps.venueAccountId,
    ownerId: deps.ownerId,
  });
  logger.info({ ownerId: deps.ownerId, botId }, 'Bot enqueued for start');

  // Surface the synchronously-persisted botId back out (A1). The row + its id are
  // created SYNCHRONOUSLY above (`tryCreateBotWithLimit`); only the actor START is
  // deferred to the lifecycle queue. `createDriveTarget` returns this for the
  // create branch so `create_bot` can return the id in its ToolResult.data.
  return { botId };
}

async function startBot(deps: DriveTargetDeps, payload: ManageBotPayload): Promise<void> {
  if (!payload.botId) throw new Error('botId is required for start');
  const bot = await requireOwnedBot(deps, payload.botId);

  // Preflight: validate persisted config before marking running (herobids broker
  // :791–799). A persisted invalid config must not be pushed through start cycles.
  const configValidation = BotConfigSchema.safeParse(bot.config);
  if (!configValidation.success) {
    const details = configValidation.error.issues
      .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
      .join('; ');
    throw new Error(`Bot config is invalid — cannot start. Fix the config before retrying: ${details}`);
  }

  const isReclaim = bot.status === 'running';

  // Mark running (reclaim: preserve startedAt) then enqueue the start job
  // (herobids broker :807–841 consistency model). Non-reclaim starts go through
  // the atomic per-`ownerId` limit seam (item E); reclaim is exempt (already holds
  // a slot). Absent at M1 (pre-E) → refuse a non-reclaim start.
  if (isReclaim) {
    await deps.botRepo.markBotRunning(payload.botId);
  } else {
    if (!deps.botLimit) {
      throw new Error('bot_limit_unavailable: limit-enforced bot start is not configured (item E)');
    }
    const claimed = await deps.botLimit.tryMarkBotRunningWithLimit({
      botId: payload.botId,
      ownerId: deps.ownerId,
      creatorType: bot.creatorType,
      creatorId: bot.creatorId ?? '',
    });
    if (!claimed) {
      throw new Error('Agent has reached its max concurrent bots limit. Stop a bot before starting a new one.');
    }
  }

  try {
    // Stamp venueAccountId + ownerId onto the ENQUEUED config: the ActorFactory
    // reads them from the config it is handed and `processJob('start')` starts
    // from the job config DIRECTLY (never re-loads for a `start`). Prefer the
    // persisted row's `venueAccountId`/`ownerId` — the bot's ACTUAL account (a
    // different drive target may inject a different value); fall back to the
    // injected `deps.venueAccountId`.
    await deps.runtime.enqueueLifecycle('start', payload.botId, {
      ...bot.config,
      venueAccountId: bot.venueAccountId ?? deps.venueAccountId,
      ownerId: bot.ownerId,
    });
  } catch (err) {
    logger.error({ botId: payload.botId, err }, 'Failed to enqueue start job during start action');
    try {
      await deps.botRepo.restoreBotRuntimeState({
        botId: payload.botId,
        status: bot.status,
        startedAt: bot.startedAt,
        stoppedAt: bot.stoppedAt,
      });
    } catch (rollbackErr) {
      logger.error({ botId: payload.botId, rollbackErr }, 'CRITICAL: rollback after start enqueue failure also failed');
    }
    throw new Error('Bot start failed: unable to enqueue lifecycle start. Please try again.');
  }
}

async function stopBot(deps: DriveTargetDeps, payload: ManageBotPayload): Promise<void> {
  if (!payload.botId) throw new Error('botId is required for stop');
  await requireOwnedBot(deps, payload.botId);
  // herobids' `botStop` marks stopped + enqueues a stop lifecycle job (broker
  // :881–882 → the botStop closure → lifecycleQueue.add('stop-instance', …)).
  await deps.runtime.enqueueLifecycle('stop', payload.botId);
}

async function restartBot(deps: DriveTargetDeps, payload: ManageBotPayload): Promise<void> {
  if (!payload.botId) throw new Error('botId is required for restart');
  const bot = await requireOwnedBot(deps, payload.botId);
  // The copied `WorkerRuntime` exposes a native `restart` lifecycle command
  // (stop-then-start with config rehydration) — drive it directly rather than
  // re-implementing stop+start (013 §6.2, "restart(=stop+start)"). Stamp
  // venueAccountId + ownerId onto the enqueued config: `processJob('restart')`
  // starts from the job config directly when it is non-empty, and the ActorFactory
  // reads both from that config (same wiring as start).
  await deps.runtime.enqueueLifecycle('restart', payload.botId, {
    ...bot.config,
    venueAccountId: bot.venueAccountId ?? deps.venueAccountId,
    ownerId: bot.ownerId,
  });
}

async function adjustConfig(deps: DriveTargetDeps, payload: ManageBotPayload): Promise<void> {
  if (!payload.botId) throw new Error('botId is required for adjust_config');
  if (!payload.config) throw new Error('config is required for adjust_config');
  const bot = await requireOwnedBot(deps, payload.botId);

  // Deep-merge the patch onto the persisted config (herobids broker :919 via
  // `mergeBotConfig`). applyAgentCapitalLimit + the LLM provider/model preservation
  // branch are DROPPED (platform / mechanical-only, decisions 7–9).
  const mergedConfig = mergeBotConfig(bot.config, payload.config);

  // Validate the merged config before persisting (herobids broker :946–952).
  const validation = BotConfigSchema.safeParse(mergedConfig);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
      .join('; ');
    throw new Error(`Bot config is invalid after merge: ${issues}`);
  }

  // Mode-escalation guard after merge (herobids broker :955–961).
  const adjustedBotMode = validation.data.execution.mode ?? 'paper';
  const modeCheck = checkModeEscalation(adjustedBotMode, deps.ownerMode, 'adjust');
  if (!modeCheck.allowed) {
    throw new Error(modeCheck.error);
  }

  // Persist the merged config, then restart if running (herobids broker
  // :969–989 consistency model + rollback).
  await deps.botRepo.updateBotConfig(payload.botId, mergedConfig);
  if (bot.status === 'running') {
    try {
      // Stamp venueAccountId + ownerId onto the enqueued restart config (the
      // ActorFactory reads both from the config; same wiring as start/restart).
      await deps.runtime.enqueueLifecycle('restart', payload.botId, {
        ...mergedConfig,
        venueAccountId: bot.venueAccountId ?? deps.venueAccountId,
        ownerId: bot.ownerId,
      });
    } catch (err) {
      logger.error({ botId: payload.botId, err }, 'Failed to enqueue restart job during adjust_config');
      try {
        await deps.botRepo.restoreBotConfig(payload.botId, bot.config);
      } catch (rollbackErr) {
        logger.error({ botId: payload.botId, rollbackErr }, 'CRITICAL: config rollback after restart enqueue failure also failed');
      }
      throw new Error('Config adjustment failed: unable to enqueue restart. Please try again.');
    }
  }
}

/**
 * Resolve a bot by id and validate ownership against the INJECTED `ownerId`
 * (herobids used `bot.userId !== agent.userId`; the `agents` table is dropped —
 * ownership is by the soft `ownerId`, decisions 10–13). Throws on missing/foreign.
 */
async function requireOwnedBot(deps: DriveTargetDeps, botId: string): Promise<DriveBotRecord> {
  const bot = await deps.botRepo.getBotById(botId);
  if (!bot || bot.ownerId !== deps.ownerId) {
    throw new Error(`Bot ${botId} not found or not owned by this owner`);
  }
  return bot;
}

/**
 * Adapt the `submit_decision` tool payload into item C's `DecisionSubmitInput`,
 * route it through `submitDecision`, and write the typed result to
 * `agent:decision:reply:${decisionId}` in the shape the copied `tools/trading.ts`
 * `blpop` parses. Traces broker :277–283 (DECISION_SUBMIT → decision handler) +
 * the reply write (instance-event-publisher.ts:134). The tool only publishes when
 * it expects a reply (`_expectsReply: true`) and after handling `dryRun` itself.
 */
async function handleDecisionSubmit(deps: DriveTargetDeps, payload: Record<string, unknown>): Promise<void> {
  const decisionId = String(payload['decisionId']);
  const replyKey = `agent:decision:reply:${decisionId}`;

  const input: DecisionSubmitInput = {
    actorId: deps.actorId,
    decisionId,
    instrumentId: String(payload['instrumentId']),
    intent: payload['intent'] as DecisionIntent,
    targetSize: String(payload['targetSize']),
    limitPrice: (payload['limitPrice'] as string | undefined) ?? null,
    stopLoss: (payload['stopLoss'] as string | undefined) ?? null,
    takeProfit: (payload['takeProfit'] as string | undefined) ?? null,
    confidence: (payload['confidence'] as number | undefined) ?? null,
    rationaleSummary: payload['rationaleSummary'] as string | undefined,
    timestamp: new Date().toISOString(),
    actorType: 'agent',
    initiatorId: deps.actorId,
    ...(payload['safetyOverrideId'] ? { safetyOverrideId: String(payload['safetyOverrideId']) } : {}),
  };

  const result = await deps.submitDecision(input);

  // Only write a reply when the tool is awaiting one (herobids `_expectsReply`).
  if (payload['_expectsReply'] !== true) return;

  try {
    await deps.redis.lpush(replyKey, JSON.stringify(result));
    await deps.redis.expire(replyKey, 60);
  } catch (err) {
    logger.warn({ decisionId, err }, 'Failed to publish decision reply — agent will not receive synchronous feedback');
  }
}

/**
 * createDriveTarget — build the in-process `publishToInbound` port (the seam the
 * copied tools call). Dispatches synchronously by `type`:
 *  - `DECISION_SUBMIT` → adapt → item C `submitDecision` → reply write.
 *  - `MANAGE_BOT`      → the bot-lifecycle handler.
 *  - `BOT_QUERY`       → NOT routed (locked decision, 013 §6.1 / 021 §2): neither
 *    copied tool emits it; the constant exists only for vocabulary fidelity.
 */
export function createDriveTarget(deps: DriveTargetDeps): PublishToInbound {
  return async (type: string, payload: Record<string, unknown>): Promise<void | ManageBotResult> => {
    switch (type) {
      case AGENT_MESSAGE_TYPES.DECISION_SUBMIT:
        await handleDecisionSubmit(deps, payload);
        return;
      case AGENT_MESSAGE_TYPES.MANAGE_BOT:
        // Only create_and_start returns a ManageBotResult (the synchronous botId,
        // A1); start/stop/restart/adjust_config resolve void.
        return handleManageBot(deps, payload as unknown as ManageBotPayload);
      default:
        // No BOT_QUERY route (decision). Unknown types are ignored — the tools
        // only ever emit DECISION_SUBMIT + MANAGE_BOT.
        logger.warn({ type }, 'publishToInbound received an unrouted message type — ignoring');
        return;
    }
  };
}
