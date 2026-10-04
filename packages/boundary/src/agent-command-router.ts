// Agent-actor owner routing (001 S3 — command forwarding + stop signal).
//
// Multi-replica safety for agent actors. S2's lease-aware ensure makes exactly
// one boundary container the OWNER of an agent (`agent:{agentId}` on the shared
// `InstanceLease`). The only actor-bound command is `submit_decision`
// (`DECISION_SUBMIT`) — it must run where the live actor is. This module carries
// such a decision to the owner and runs it there:
//
//  - SENDER (`wrapPublishToInbound`): the context factory wraps the real local
//    drive target with the ensure's ownership result. A `DECISION_SUBMIT` for a
//    REMOTELY-owned agent is RPUSH-ed onto the owner's command list
//    (`agent-actor:cmd:{workerId}`) instead of running locally; everything else
//    (MANAGE_BOT acts through run-state + bot rows, fine on any container) runs
//    locally.
//  - CONSUMER (`startAgentCommandConsumer`): one blocking-pop loop per container
//    on its OWN command list, with a dedicated Redis connection (BLPOP blocks the
//    connection). It re-checks the lease before executing (the authoritative
//    split-brain guard, 001 S2 note) and runs the LOCAL drive target rebuilt from
//    the envelope's injection. Reschedules on failure; stops cleanly on shutdown.
//  - STOP SIGNAL (`subscribeAgentActorStopSignals`): `agent-actor:stop:*`
//    subscriber modelled on `bot-stop-subscriber.ts`. Broadcast-safe — a
//    non-owner stop is a no-op.
//
// Replies need no new plumbing: the copied `submit_decision` tool BLPOPs
// `agent:decision:reply:{decisionId}`, and the owner's drive target writes there
// exactly as the local path does (drive-target.ts `handleDecisionSubmit`). When
// this module cannot execute (unknown owner, or lease lost mid-flight) it writes
// a `precondition.not_ready` reply in the SAME shape the tool parses, so the
// waiting tool returns a fast, clear rejection rather than hanging to its 30s
// BLPOP timeout. NOTE: the copied tool does NOT honour a top-level `retryable`
// flag — it derives `retryable:true` only from `capability_denied:*` codes
// (trading.ts) — so `precondition.not_ready` surfaces to the caller as
// `retryable:false`. The benefit here is the PROMPT fail, not a transport-level
// retry flag. Re-submission is driven by the agent's own reasoning loop (and the
// next decision's re-ensure resolving a concrete owner, or taking over locally),
// not by any flag the tool reads. Making `precondition.not_ready` transport-
// retryable would require a tool-parse change — deliberately out of S3 scope.

import { AGENT_MESSAGE_TYPES } from '@traderton/domain';
import type { PublishToInbound } from '@traderton/worker';
import type {
  AgentDirectActorInjection,
  AgentDirectActorResult,
} from './agent-direct-actor-ensure.js';

/** The owner's command list (one per container, keyed by worker id). */
export const AGENT_ACTOR_CMD_LIST_PREFIX = 'agent-actor:cmd:';
/** The agent-actor stop broadcast channel (one per agent id). */
export const AGENT_ACTOR_STOP_CHANNEL_PREFIX = 'agent-actor:stop:';
export const AGENT_ACTOR_STOP_CHANNEL_PATTERN = `${AGENT_ACTOR_STOP_CHANNEL_PREFIX}*`;
/** The decision-reply key the copied `submit_decision` tool BLPOPs (shared Redis). */
export const DECISION_REPLY_KEY_PREFIX = 'agent:decision:reply:';

/** The command list key for a worker id. */
export function agentCmdListKey(workerId: string): string {
  return `${AGENT_ACTOR_CMD_LIST_PREFIX}${workerId}`;
}

/** The decision-reply key for a decision id. */
export function decisionReplyKey(decisionId: string): string {
  return `${DECISION_REPLY_KEY_PREFIX}${decisionId}`;
}

/**
 * The envelope RPUSH-ed onto the owner's command list. It carries the decision
 * `type` + `payload` UNCHANGED (including `decisionId` + `_expectsReply`, so the
 * owner's drive target writes the reply the sender's tool is BLPOP-waiting on),
 * plus the resolved `injection` the owner needs to REBUILD the local drive target
 * (ownerId, actorId, ownerMode, venue, venueType, venueAccountId). The owner's
 * container has not necessarily resolved these for this call, so they ride the
 * envelope rather than being re-derived.
 *
 * NOTE: `injection` is a TRUSTED intra-cluster value — it was resolved by the
 * sending container (the ensure) and travels over the shared internal Redis. The
 * owner does NOT re-validate it owner-side; it rebuilds the local drive target
 * from it directly. The command list is not an external trust boundary.
 */
export interface AgentCommandEnvelope {
  type: string;
  payload: Record<string, unknown>;
  injection: AgentDirectActorInjection;
}

/**
 * The `precondition.not_ready` reply the sender/consumer writes when it refuses
 * to execute (an unknown owner, or a lease lost before execution). Shaped as the
 * `DecisionSubmitResult` `rejected` variant so the copied `submit_decision` tool
 * parses it (`parsed.status === 'rejected'`) and the waiting tool returns
 * PROMPTLY with a clear `precondition.not_ready` rejection rather than hanging to
 * its 30s BLPOP timeout. That fast fail is the real benefit here.
 *
 * The top-level `retryable: true` is ADVISORY and currently IGNORED by the tool:
 * the copied `submit_decision` (trading.ts) derives `retryable:true` only from
 * `capability_denied:*` codes, so this reply surfaces to the caller as
 * `retryable:false`. It does NOT drive a transport-level retry. Re-submission is
 * driven by the agent's reasoning loop and the next decision's re-ensure
 * resolving a concrete owner (or taking over locally). The field is kept because
 * it is harmless and documents intent; making `precondition.not_ready` actually
 * transport-retryable would require a tool-parse change (out of S3 scope).
 */
function notReadyReply(message: string): string {
  return JSON.stringify({
    status: 'rejected',
    code: 'precondition.not_ready',
    message,
    // Advisory only — the current tool ignores this field (see doc above).
    retryable: true,
  });
}

/** The Redis surface the sender needs (RPUSH to the owner's list + reply write). */
export interface AgentCommandSenderRedis {
  rpush(key: string, value: string): Promise<number>;
  lpush(key: string, value: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

export interface AgentCommandRouterLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Wrap the real local `publishToInbound` with the ensure's ownership result.
 *
 * For a `DECISION_SUBMIT` whose ensure reported `{ owner: 'remote', workerId }`
 * with a NON-EMPTY `workerId`: RPUSH the envelope onto `agent-actor:cmd:{workerId}`
 * and return WITHOUT running locally (the owner writes the reply the tool awaits).
 *
 * For a `DECISION_SUBMIT` whose ensure reported remote with an EMPTY `workerId`
 * (the "holder unknown" sentinel, 001 S2): do NOT forward to an empty key — write
 * a `precondition.not_ready` reply (when `_expectsReply`) so the tool fails fast
 * instead of hanging to its 30s timeout; the agent's next decision re-ensures a
 * concrete owner (or takes over locally).
 *
 * Everything else — any non-decision type, or an agent owned locally — delegates
 * to the real local drive target unchanged.
 */
export function wrapPublishToInbound(args: {
  local: PublishToInbound;
  ensureResult: AgentDirectActorResult;
  injection: AgentDirectActorInjection;
  redis: AgentCommandSenderRedis;
  logger: AgentCommandRouterLogger;
}): PublishToInbound {
  const { local, ensureResult, injection, redis, logger } = args;

  return async (type, payload) => {
    // Only a decision is actor-bound; the owner alone can run it. MANAGE_BOT (and
    // any other type) acts through run-state + bot rows, fine on any container.
    if (type !== AGENT_MESSAGE_TYPES.DECISION_SUBMIT || ensureResult.owner === 'local') {
      return local(type, payload);
    }

    const decisionId = typeof payload['decisionId'] === 'string' ? payload['decisionId'] : undefined;
    const expectsReply = payload['_expectsReply'] === true;

    // Remote with an EMPTY workerId = holder unknown (001 S2 sentinel). Do NOT
    // RPUSH to an empty key — write a precondition.not_ready reply so the tool
    // returns promptly instead of hanging to its 30s timeout. The caller does not
    // auto-retry (the tool ignores the reply's `retryable` flag); re-submission is
    // the agent's next decision, whose re-ensure resolves a concrete owner (or
    // takes over locally).
    if (ensureResult.workerId === '') {
      logger.warn(
        { ownerId: injection.ownerId, agentId: injection.actorId, decisionId },
        'agent decision owner unknown — writing a precondition.not_ready reply rather than forwarding',
      );
      if (decisionId && expectsReply) {
        await writeReply(redis, decisionId, notReadyReply('agent actor owner unknown — not ready'), logger);
      }
      return;
    }

    const envelope: AgentCommandEnvelope = { type, payload, injection };
    const listKey = agentCmdListKey(ensureResult.workerId);
    logger.info(
      { ownerId: injection.ownerId, agentId: injection.actorId, workerId: ensureResult.workerId, decisionId },
      'forwarding agent decision to the owning worker',
    );
    await redis.rpush(listKey, JSON.stringify(envelope));
    // Do NOT run locally — the owner executes it and writes the reply the sender's
    // tool is BLPOP-waiting on.
  };
}

/** Write a reply to the tool's BLPOP key (lpush + 60s expire), best-effort. */
async function writeReply(
  redis: Pick<AgentCommandSenderRedis, 'lpush' | 'expire'>,
  decisionId: string,
  value: string,
  logger: AgentCommandRouterLogger,
): Promise<void> {
  const key = decisionReplyKey(decisionId);
  try {
    await redis.lpush(key, value);
    await redis.expire(key, 60);
  } catch (err) {
    logger.warn({ err, decisionId }, 'failed to write agent decision reply');
  }
}

/** The dedicated blocking-pop connection the consumer owns (BLPOP blocks it). */
export interface AgentCommandConsumerRedis {
  /** `BLPOP key timeout` → `[key, value]` or null on timeout. */
  blpop(key: string, timeoutSeconds: number): Promise<[string, string] | null>;
  lpush(key: string, value: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  /** Close the dedicated connection — teardown relies on it to unblock the BLPOP. */
  quit(): Promise<unknown>;
}

/** The lease surface the consumer re-checks before executing (own-id only). */
export interface AgentCommandConsumerLease {
  holder(id: string): Promise<string | null>;
}

export interface AgentCommandConsumerDeps {
  /** Dedicated Redis connection — BLPOP blocks it, so it cannot be shared. */
  redis: AgentCommandConsumerRedis;
  /** This container's worker id — its command list is `agent-actor:cmd:{workerId}`. */
  workerId: string;
  /** The agent-actor lease (001 S1); only `agent:{agentId}` ids are read here. */
  lease: AgentCommandConsumerLease;
  /** Build the LOCAL drive target for an injection (runtime.createDriveTarget). */
  createDriveTarget: (injection: AgentDirectActorInjection) => PublishToInbound;
  logger: AgentCommandRouterLogger;
  /** BLPOP block seconds (default 5) — short enough that stop() unblocks promptly. */
  blockSeconds?: number;
}

/** A running consumer loop handle (stop unblocks + closes the dedicated connection). */
export interface AgentCommandConsumer {
  stop(): void;
}

/**
 * Start the self-rescheduling blocking-pop loop on this container's OWN command
 * list (`agent-actor:cmd:{workerId}`). For each popped envelope:
 *  1. parse it (a malformed envelope is logged + dropped — it carries no decision
 *     id we could reply on);
 *  2. GUARD: re-check `lease.holder('agent:'+agentId) === workerId`. The agentId
 *     is read from `envelope.injection.actorId` (the decision payload does not
 *     carry it — the drive target stamps it from the injection). If we no longer
 *     hold the lease, write a `precondition.not_ready` reply (when `_expectsReply`)
 *     rather than executing — the authoritative split-brain guard. The tool fails
 *     fast on it (it does not auto-retry the reply);
 *  3. otherwise run the LOCAL drive target rebuilt from the envelope's injection,
 *     which writes the reply the sender's tool awaits.
 *
 * Reschedules on any failure (AGENTS async-loop rule) and stops cleanly on
 * shutdown via `stop()`.
 */
export function startAgentCommandConsumer(deps: AgentCommandConsumerDeps): AgentCommandConsumer {
  const { redis, workerId, lease, createDriveTarget, logger } = deps;
  const blockSeconds = deps.blockSeconds ?? 5;
  const listKey = agentCmdListKey(workerId);
  let stopped = false;

  const handleEnvelope = async (raw: string): Promise<void> => {
    let envelope: AgentCommandEnvelope;
    try {
      envelope = JSON.parse(raw) as AgentCommandEnvelope;
    } catch (err) {
      logger.error({ err, listKey }, 'agent command consumer: dropping a malformed envelope');
      return;
    }

    const { injection, payload, type } = envelope;
    // The agentId for the lease guard is the decision's actorId. The decision
    // payload does NOT carry it (the drive target stamps `deps.actorId` from the
    // injection), so read it from the envelope's injection — the authoritative
    // source for who this decision belongs to.
    const agentId = injection.actorId;
    const decisionId = typeof payload['decisionId'] === 'string' ? payload['decisionId'] : undefined;
    const expectsReply = payload['_expectsReply'] === true;

    // Split-brain guard: confirm we STILL own the agent before executing. The
    // lease could have expired (silent renewal failure, 001 S2) after the sender
    // forwarded to us. If we no longer hold it, refuse with a precondition.not_ready
    // reply so the sender's tool returns promptly rather than us running a decision
    // for an agent we no longer own. The tool does not auto-retry (it ignores the
    // reply's `retryable` flag); the agent's next decision re-ensures the new owner.
    const holder = await lease.holder(`agent:${agentId}`);
    if (holder !== workerId) {
      logger.warn(
        { ownerId: injection.ownerId, agentId, holder, workerId, decisionId },
        'agent command consumer: lease no longer held — refusing the forwarded decision',
      );
      if (decisionId && expectsReply) {
        await writeReply(redis, decisionId, notReadyReply('agent actor ownership changed — not ready'), logger);
      }
      return;
    }

    const local = createDriveTarget(injection);
    await local(type, payload);
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const popped = await redis.blpop(listKey, blockSeconds);
        if (stopped) break;
        if (!popped) continue; // BLPOP timed out — re-block.
        const [, raw] = popped;
        await handleEnvelope(raw);
      } catch (err) {
        if (stopped) break;
        // Reschedule on failure (AGENTS async-loop rule): log + a short pause so a
        // persistent Redis fault does not spin a tight error loop.
        logger.error({ err, listKey }, 'agent command consumer loop error — rescheduling');
        await sleep(1000);
      }
    }
  };

  void loop();

  return {
    stop(): void {
      stopped = true;
      // Unblock the in-flight BLPOP + release the dedicated connection. A
      // subscriber/BLPOP-blocked connection cannot issue other commands, so it is
      // its own client — quitting it is the clean unblock (mirrors the bot-stop
      // subscriber teardown in boundary-shutdown.ts). Best-effort: process exit
      // also releases it.
      void redis.quit().catch(() => {
        /* best-effort — process exit also releases it */
      });
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The subset of an ioredis subscriber connection the stop subscriber needs. */
export interface AgentActorStopSubscriberConnection {
  psubscribe(pattern: string, callback: (err?: Error | null) => void): unknown;
  on(event: 'pmessage', listener: (pattern: string, channel: string, message: string) => void): unknown;
}

/**
 * Subscribe to `agent-actor:stop:*` and stop the named agent actor on this
 * process. Modelled on `subscribeBotStopSignals` (bot-stop-subscriber.ts).
 *
 * `stopAgentActor` must be a logged no-op when this process does not own the
 * agent (the lifecycle stop path's stop+deregister is keyed on the registry and
 * the evict releases only a lease we hold), so broadcasting to every boundary
 * process is safe. The signal carries only the agent id; the owner resolves any
 * extra coordinates it needs.
 */
export function subscribeAgentActorStopSignals(
  subscriber: AgentActorStopSubscriberConnection,
  stopAgentActor: (agentId: string) => Promise<void>,
  logger: AgentCommandRouterLogger,
): void {
  subscriber.psubscribe(AGENT_ACTOR_STOP_CHANNEL_PATTERN, (err) => {
    if (err) logger.error({ err }, 'Failed to subscribe to agent-actor:stop:* channels');
  });
  subscriber.on('pmessage', (_pattern, channel) => {
    if (!channel.startsWith(AGENT_ACTOR_STOP_CHANNEL_PREFIX)) return;
    const agentId = channel.slice(AGENT_ACTOR_STOP_CHANNEL_PREFIX.length);
    if (!agentId) return;
    logger.info({ agentId }, 'Received agent-actor:stop signal — stopping agent actor directly');
    stopAgentActor(agentId).catch((err: unknown) => {
      logger.error({ err, agentId }, 'Failed to stop agent actor via agent-actor:stop signal');
    });
  });
}
