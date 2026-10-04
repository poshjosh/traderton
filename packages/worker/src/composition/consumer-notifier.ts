// Consumer notifier (Wave E / E3-T T2 — AUTHORED composition seam).
//
// The in-process herobids actors used to push events straight into the agent/
// user event system (apps/worker/src/index.ts ~L1320–1345 agent callbacks;
// ~L2192–2244 bot onHalted/onJournalEvent). Traderton now runs those actors in
// its own process, so the push collapses to a write into the dedicated outbox
// table (`consumer_notifications`, T1). A herobids relay polls that table and
// republishes the existing herobids message types (E3-H, gated).
//
// This module is the AUTHORED sink the actor wiring (T3 agent / T4 bot) calls.
// Each method maps to EXACTLY ONE notification `type` and the routing fields of
// the E3 event vocabulary table. The caller supplies the already-resolved
// routing values (ownerId / agentId / botId) — T4 owns the creatorType/creatorId
// resolution; this module just records what it is handed.
//
// BEST-EFFORT CONTRACT: the source callbacks were best-effort — a failed write
// must NEVER throw back into an actor's cycle. Every method wraps the append in
// try/catch, LOGS the failure (not swallowed silently), and resolves normally.

import type { AgentWakePayload } from '@traderton/domain';
import type { InsertConsumerNotification } from '@traderton/db';

import type { TechnicalScanState } from '../scan-types.js';

/**
 * The minimal structural sink the notifier needs — just `append`. Satisfied by
 * `@traderton/db`'s `ConsumerNotificationRepository`, but narrowed to a port so
 * the unit test can supply a fake without a database (matches the house style of
 * depending on narrow structural surfaces, e.g. `DriveBotRepo` in drive-target).
 */
export interface ConsumerNotificationSink {
  append(entry: InsertConsumerNotification): Promise<void>;
}

/**
 * Minimal logger surface — the pino `Logger` from the worker `createLogger`
 * satisfies it. Narrowed to `{ error }` the same way `boundary-shutdown.ts`
 * narrows its logger, so the unit test can assert the error log with a spy.
 */
export interface NotifierLogger {
  error(obj: object, msg: string): void;
}

/** `scan_completed` — the agent's technical scan finished (routed to the agent). */
export interface ScanCompletedArgs {
  ownerId: string;
  agentId: string;
  /** Signal-cap truncation is T3's responsibility; the notifier stores as-given. */
  scan: TechnicalScanState;
}

/** `agent_wake` — the agent was woken (reminder / watch / discovery / regime / scanner). */
export interface AgentWakeArgs {
  ownerId: string;
  agentId: string;
  wake: AgentWakePayload;
}

/**
 * `journal_event` — a forwarded audit event (reconciliation.*, strategy.error/
 * fatal, stream.disconnect, scanner.*). `botId` is null for agent-native events.
 */
export interface JournalEventArgs {
  ownerId: string;
  /** The agent to notify. Null for user-created bots with no owning agent. */
  agentId: string | null;
  /** The emitting bot, or null for agent-native journal events. */
  botId: string | null;
  journalType: string;
  /** JSON string, the source shape — forwarded verbatim. */
  detail: string;
}

/** `bot_status` — a bot halted (`stopped`) or crashed/failed to start (`crashed`). */
export interface BotStatusArgs {
  ownerId: string;
  /** The creator agent (when `creatorType==='agent'`), else null for user bots. */
  agentId: string | null;
  botId: string;
  status: 'stopped' | 'crashed';
  /** e.g. 'bot_halted_error_limit' | 'runtime_crash' | 'start_failed'. */
  reason: string;
  /** The creator's bots `{ id, status }` at emit time. */
  managedBots: Array<{ id: string; status: string }>;
}

/** `agent_status` — the agent actor crashed. */
export interface AgentStatusArgs {
  ownerId: string;
  agentId: string;
  status: 'crashed';
  /** The crash message only (no stack / provider internals). */
  error: string;
}

/**
 * The authored sink surface T3/T4 call. Each method appends exactly one routed
 * notification and is best-effort (resolves even if the write fails).
 */
export interface ConsumerNotifier {
  scanCompleted(args: ScanCompletedArgs): Promise<void>;
  agentWake(args: AgentWakeArgs): Promise<void>;
  journalEvent(args: JournalEventArgs): Promise<void>;
  botStatus(args: BotStatusArgs): Promise<void>;
  agentStatus(args: AgentStatusArgs): Promise<void>;
}

/**
 * Build the consumer notifier over a notification sink + logger.
 *
 * `repo` is the `ConsumerNotificationRepository` (`@traderton/db`), accepted
 * through the narrow `ConsumerNotificationSink` port so it is trivially fakeable
 * in a unit test. `logger` is the worker pino `Logger`.
 */
export function createConsumerNotifier(
  repo: ConsumerNotificationSink,
  logger: NotifierLogger,
): ConsumerNotifier {
  // One best-effort write path for all five methods: append, and on failure log
  // (never rethrow) so a sink error cannot propagate into an actor's cycle. The
  // routing fields are logged alongside the error for operability.
  const appendBestEffort = async (entry: InsertConsumerNotification): Promise<void> => {
    try {
      await repo.append(entry);
    } catch (err) {
      logger.error(
        { err, type: entry.type, ownerId: entry.ownerId, agentId: entry.agentId ?? null },
        'consumer notification append failed',
      );
    }
  };

  return {
    scanCompleted({ ownerId, agentId, scan }) {
      return appendBestEffort({
        type: 'scan_completed',
        ownerId,
        agentId,
        botId: null,
        payload: { scan },
      });
    },

    agentWake({ ownerId, agentId, wake }) {
      return appendBestEffort({
        type: 'agent_wake',
        ownerId,
        agentId,
        botId: null,
        payload: { wake },
      });
    },

    journalEvent({ ownerId, agentId, botId, journalType, detail }) {
      return appendBestEffort({
        type: 'journal_event',
        ownerId,
        agentId,
        botId,
        payload: { journalType, detail },
      });
    },

    botStatus({ ownerId, agentId, botId, status, reason, managedBots }) {
      return appendBestEffort({
        type: 'bot_status',
        ownerId,
        agentId,
        botId,
        payload: { status, reason, managedBots },
      });
    },

    agentStatus({ ownerId, agentId, status, error }) {
      return appendBestEffort({
        type: 'agent_status',
        ownerId,
        agentId,
        botId: null,
        payload: { status, error },
      });
    },
  };
}
