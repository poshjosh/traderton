// Unit tests for the agent-actor orphan sweep (Wave E / E1-T T5). The single-tick
// logic (`runAgentOrphanSweep`) is tested directly; the loop's reschedule-on-
// failure + stop() are tested with an injected scheduler, mirroring the prune-loop
// test style.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  runAgentOrphanSweep,
  startAgentOrphanSweep,
  type AgentOrphanSweepPorts,
  type AgentRunRecord,
} from './agent-orphan-sweep.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function buildLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const runRow = (actorId: string): AgentRunRecord => ({
  ownerId: 'o1', actorId, venueAccountId: 'va1', venue: 'hyperliquid', venueType: 'orderbook',
});

function makePorts(overrides: Partial<AgentOrphanSweepPorts> = {}): {
  ports: AgentOrphanSweepPorts;
  stopBot: ReturnType<typeof vi.fn>;
  reEnsureAgent: ReturnType<typeof vi.fn>;
} {
  const stopBot = vi.fn(async () => undefined);
  const reEnsureAgent = vi.fn(async () => undefined);
  const ports: AgentOrphanSweepPorts = {
    listRunningAgentRuns: async () => [],
    listRunningAgentBots: async () => [],
    isActorAlive: () => true,
    reEnsureAgent,
    stopBot,
    ...overrides,
  };
  return { ports, stopBot, reEnsureAgent };
}

describe('runAgentOrphanSweep', () => {
  it('stops running bots of a stopped/absent agent and leaves bots of a running agent alone', async () => {
    const { ports, stopBot } = makePorts({
      // Only agent "live" is running.
      listRunningAgentRuns: async () => [runRow('live')],
      listRunningAgentBots: async () => [
        { id: 'bot-of-live', creatorId: 'live' },     // creator running → keep
        { id: 'bot-of-dead', creatorId: 'dead' },     // creator absent from runs → stop
      ],
      isActorAlive: () => true,
    });

    await runAgentOrphanSweep(ports, buildLogger());

    expect(stopBot).toHaveBeenCalledTimes(1);
    expect(stopBot).toHaveBeenCalledWith('bot-of-dead');
  });

  it('re-ensures a running agent whose actor is not alive, and skips live ones', async () => {
    const { ports, reEnsureAgent } = makePorts({
      listRunningAgentRuns: async () => [runRow('alive'), runRow('dead')],
      listRunningAgentBots: async () => [],
      isActorAlive: (actorId) => actorId === 'alive',
    });

    await runAgentOrphanSweep(ports, buildLogger());

    expect(reEnsureAgent).toHaveBeenCalledTimes(1);
    expect(reEnsureAgent).toHaveBeenCalledWith(runRow('dead'));
  });

  it('is best-effort: a failing stopBot does not block re-ensuring dead agents', async () => {
    const logger = buildLogger();
    const stopBot = vi.fn(async () => { throw new Error('stop failed'); });
    const reEnsureAgent = vi.fn(async () => undefined);
    const ports: AgentOrphanSweepPorts = {
      listRunningAgentRuns: async () => [runRow('dead')],
      listRunningAgentBots: async () => [{ id: 'orphan-bot', creatorId: 'gone' }],
      isActorAlive: () => false,
      reEnsureAgent,
      stopBot,
    };

    await runAgentOrphanSweep(ports, logger);

    expect(stopBot).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled(); // the stop failure was logged, not thrown
    expect(reEnsureAgent).toHaveBeenCalledWith(runRow('dead')); // pass 2 still ran
  });
});

/** Manual scheduler — mirrors the prune-loop test harness. */
function makeScheduler() {
  let pending: (() => void) | undefined;
  const setTimeoutFn = (handler: () => void) => {
    pending = handler;
    return { unref: () => undefined };
  };
  const tick = async (): Promise<void> => {
    const next = pending;
    pending = undefined;
    next?.();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { setTimeoutFn, tick, hasPending: () => pending !== undefined };
}

describe('startAgentOrphanSweep', () => {
  it('schedules the first sweep (not immediate), runs it, and reschedules', async () => {
    const { ports } = makePorts();
    const listRunningAgentRuns = vi.spyOn(ports, 'listRunningAgentRuns');
    const scheduler = makeScheduler();

    startAgentOrphanSweep({ ports, sweepIntervalMs: 60_000, logger: buildLogger(), setTimeoutFn: scheduler.setTimeoutFn });

    expect(listRunningAgentRuns).not.toHaveBeenCalled(); // scheduled, not immediate
    await scheduler.tick();
    expect(listRunningAgentRuns).toHaveBeenCalledTimes(1);
    expect(scheduler.hasPending()).toBe(true); // rescheduled after a successful run
  });

  it('reschedules after a sweep whose listing throws', async () => {
    const logger = buildLogger();
    const listRunningAgentRuns = vi
      .fn<[], Promise<AgentRunRecord[]>>()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce([]);
    const { ports } = makePorts({ listRunningAgentRuns });
    const scheduler = makeScheduler();

    startAgentOrphanSweep({ ports, sweepIntervalMs: 60_000, logger, setTimeoutFn: scheduler.setTimeoutFn });

    await scheduler.tick(); // run 1 throws
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(scheduler.hasPending()).toBe(true);

    await scheduler.tick(); // run 2 proceeds — loop survived
    expect(listRunningAgentRuns).toHaveBeenCalledTimes(2);
  });

  it('stops scheduling after stop()', async () => {
    const { ports } = makePorts();
    const listRunningAgentRuns = vi.spyOn(ports, 'listRunningAgentRuns');
    const scheduler = makeScheduler();

    const handle = startAgentOrphanSweep({ ports, sweepIntervalMs: 60_000, logger: buildLogger(), setTimeoutFn: scheduler.setTimeoutFn });
    handle.stop();
    await scheduler.tick();

    expect(listRunningAgentRuns).not.toHaveBeenCalled();
    expect(scheduler.hasPending()).toBe(false);
  });
});
