/**
 * AUTHORED test (Wave E / E3-T T2) — the consumer notifier is an authored
 * composition seam, so there is no herobids parity oracle to copy.
 *
 * Pure unit test: no DB, no Redis, no network. The sink is a fake `append` spy
 * and the logger is an `{ error }` spy. The test asserts each of the five
 * methods routes exactly one notification with the correct `type`, routing
 * fields, and payload shape, and that a sink write failure is logged and
 * swallowed (the best-effort contract — a method must never throw into an actor).
 */
import { describe, it, expect, vi } from 'vitest';
import type { AgentWakePayload } from '@traderton/domain';
import type { InsertConsumerNotification } from '@traderton/db';

import {
  createConsumerNotifier,
  type ConsumerNotificationSink,
  type NotifierLogger,
} from './consumer-notifier.js';
import type { TechnicalScanState } from '../scan-types.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const OWNER_ID = 'owner-1';
const AGENT_ID = 'agent-1';
const BOT_ID = 'bot-1';

function makeScan(): TechnicalScanState {
  return {
    timestamp: '2026-10-04T00:00:00.000Z',
    scanIntervalMs: 60_000,
    regimeResult: null,
    signals: [],
    positionIndicators: [],
    summary: { scanned: 3, rejected: 1, passed: 2 },
    symbolOutcomes: [],
    discovered: 3,
    symbolsSelected: 2,
    eligible: 2,
    fetched: 2,
    unsupported: 0,
    fetchFailures: 0,
    signalsGenerated: 0,
  };
}

function makeWake(): AgentWakePayload {
  return {
    wakeId: 'wake-1',
    reason: 'scanner found signals',
    eventIds: ['evt-1'],
    priority: 'normal',
    requestedAt: '2026-10-04T00:00:00.000Z',
    source: 'scanner',
    context: { scannerKind: 'signal_scoring', signalCount: 2 },
  };
}

/** A fake sink whose `append` records calls; configurable to reject. */
function makeSink(impl?: (entry: InsertConsumerNotification) => Promise<void>) {
  return {
    append: vi.fn(impl ?? (async () => undefined)),
  } satisfies ConsumerNotificationSink;
}

function makeLogger() {
  return { error: vi.fn() } satisfies NotifierLogger;
}

// ── Routing ──────────────────────────────────────────────────────────────────

describe('createConsumerNotifier', () => {
  it('appends a routed notification for each method', async () => {
    const sink = makeSink();
    const logger = makeLogger();
    const notifier = createConsumerNotifier(sink, logger);

    const scan = makeScan();
    await notifier.scanCompleted({ ownerId: OWNER_ID, agentId: AGENT_ID, scan });

    const wake = makeWake();
    await notifier.agentWake({ ownerId: OWNER_ID, agentId: AGENT_ID, wake });

    await notifier.journalEvent({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      botId: BOT_ID,
      journalType: 'strategy.error',
      detail: '{"message":"boom"}',
    });

    await notifier.botStatus({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      botId: BOT_ID,
      status: 'stopped',
      reason: 'bot_halted_error_limit',
      managedBots: [{ id: BOT_ID, status: 'stopped' }],
    });

    await notifier.agentStatus({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      status: 'crashed',
      error: 'runtime failure',
    });

    expect(sink.append).toHaveBeenCalledTimes(5);
    expect(logger.error).not.toHaveBeenCalled();

    const entries = sink.append.mock.calls.map((call) => call[0]);

    expect(entries[0]).toEqual({
      type: 'scan_completed',
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      botId: null,
      payload: { scan },
    });

    expect(entries[1]).toEqual({
      type: 'agent_wake',
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      botId: null,
      payload: { wake },
    });

    expect(entries[2]).toEqual({
      type: 'journal_event',
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      botId: BOT_ID,
      payload: { journalType: 'strategy.error', detail: '{"message":"boom"}' },
    });

    expect(entries[3]).toEqual({
      type: 'bot_status',
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      botId: BOT_ID,
      payload: {
        status: 'stopped',
        reason: 'bot_halted_error_limit',
        managedBots: [{ id: BOT_ID, status: 'stopped' }],
      },
    });

    expect(entries[4]).toEqual({
      type: 'agent_status',
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      botId: null,
      payload: { status: 'crashed', error: 'runtime failure' },
    });
  });

  it('routes a user-created bot journal event to the owner with a null agent', async () => {
    const sink = makeSink();
    const notifier = createConsumerNotifier(sink, makeLogger());

    await notifier.journalEvent({
      ownerId: OWNER_ID,
      agentId: null,
      botId: BOT_ID,
      journalType: 'reconciliation.drift',
      detail: '{}',
    });

    expect(sink.append).toHaveBeenCalledTimes(1);
    expect(sink.append.mock.calls[0]![0]).toMatchObject({
      type: 'journal_event',
      ownerId: OWNER_ID,
      agentId: null,
      botId: BOT_ID,
    });
  });

  // ── Best-effort contract ─────────────────────────────────────────────────

  it('swallows and logs a write failure', async () => {
    const failure = new Error('db unavailable');
    const sink = makeSink(async () => {
      throw failure;
    });
    const logger = makeLogger();
    const notifier = createConsumerNotifier(sink, logger);

    // Must resolve (not reject) — a sink failure must never throw into an actor.
    await expect(
      notifier.scanCompleted({ ownerId: OWNER_ID, agentId: AGENT_ID, scan: makeScan() }),
    ).resolves.toBeUndefined();

    expect(sink.append).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [logObj] = logger.error.mock.calls[0]!;
    expect(logObj).toMatchObject({
      err: failure,
      type: 'scan_completed',
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
    });
  });
});
