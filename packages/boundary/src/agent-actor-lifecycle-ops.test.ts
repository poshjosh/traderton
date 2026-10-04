// Unit tests for the shared agent-actor lifecycle ops (Wave E / E1-T T5): the
// stop/cascade/ensure/record glue the consumer-only tools, the boot rehydrate,
// and the orphan sweep all run through. Driven with fakes — no runtime, no db.

import { describe, it, expect, vi } from 'vitest';
import type { AgentActorRunRepository } from '@traderton/db';
import type { TradingRuntime } from '@traderton/worker';
import { buildAgentActorLifecycleOps, type CascadeBotRepo } from './agent-actor-lifecycle-ops.js';
import type { AgentDirectActorEnsure } from './agent-direct-actor-ensure.js';

function buildLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A fake actor registry (Map) + the runtime surface the ops touch. */
function makeRuntime(registry: Map<string, { isRunning: boolean }>) {
  const stopAndDeregisterAgentActor = vi.fn(async (actor: { isRunning: boolean }) => {
    actor.isRunning = false;
    // Mirror the real runtime: deregister removes it from the shared map.
    for (const [id, a] of registry) if (a === actor) registry.delete(id);
  });
  const runtime = {
    actorRegistry: registry as unknown as TradingRuntime['actorRegistry'],
    stopAndDeregisterAgentActor,
  } as unknown as TradingRuntime;
  return { runtime, stopAndDeregisterAgentActor };
}

function makeDeps(opts?: {
  registry?: Map<string, { isRunning: boolean }>;
  bots?: Array<{ id: string; status: string }>;
}) {
  const registry = opts?.registry ?? new Map<string, { isRunning: boolean }>();
  const { runtime, stopAndDeregisterAgentActor } = makeRuntime(registry);

  const ensure = Object.assign(vi.fn(async () => ({ owner: 'local' as const })), { evict: vi.fn() }) as unknown as AgentDirectActorEnsure;

  const runRepo = {
    upsertRunning: vi.fn(async () => undefined),
    markStopped: vi.fn(async () => undefined),
    listRunning: vi.fn(async () => []),
    getByOwnerActor: vi.fn(async () => null),
  } as unknown as AgentActorRunRepository;

  const botRepo: CascadeBotRepo = {
    getBotsByCreator: vi.fn(async () => opts?.bots ?? []),
    markBotStopped: vi.fn(async () => undefined),
  };

  const stopInstanceDirect = vi.fn(async () => undefined);
  const logger = buildLogger();

  const ops = buildAgentActorLifecycleOps({ runtime, ensure, runRepo, botRepo, stopInstanceDirect, logger });
  return { ops, registry, ensure, runRepo, botRepo, stopInstanceDirect, stopAndDeregisterAgentActor, logger };
}

describe('buildAgentActorLifecycleOps.recordRunning', () => {
  it('upserts a running row with the resolved coordinates', async () => {
    const { ops, runRepo } = makeDeps();
    await ops.recordRunning({ ownerId: 'o1', actorId: 'a1', venueAccountId: 'va1', venue: 'hyperliquid', venueType: 'orderbook' });
    expect(runRepo.upsertRunning).toHaveBeenCalledWith({
      ownerId: 'o1', actorId: 'a1', venueAccountId: 'va1', venue: 'hyperliquid', venueType: 'orderbook',
    });
  });
});

describe('buildAgentActorLifecycleOps.isActorAlive', () => {
  it('reflects registry membership + isRunning', () => {
    const registry = new Map<string, { isRunning: boolean }>([['a1', { isRunning: true }], ['a2', { isRunning: false }]]);
    const { ops } = makeDeps({ registry });
    expect(ops.isActorAlive('a1')).toBe(true);
    expect(ops.isActorAlive('a2')).toBe(false);
    expect(ops.isActorAlive('missing')).toBe(false);
  });
});

describe('buildAgentActorLifecycleOps.ensureFromRun', () => {
  it('calls the ensure with the stored coordinates (venueType narrowed)', async () => {
    const { ops, ensure } = makeDeps();
    await ops.ensureFromRun({ ownerId: 'o1', actorId: 'a1', venueAccountId: 'va1', venue: 'jupiter', venueType: 'swap' });
    expect(ensure).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: 'o1', actorId: 'a1', venueAccountId: 'va1', venue: 'jupiter', venueType: 'swap',
    }));
  });
});

describe('buildAgentActorLifecycleOps.stopAgent', () => {
  it('marks stopped, stops + deregisters the actor, evicts the cache, and cascade-stops running bots', async () => {
    const actor = { isRunning: true };
    const registry = new Map<string, { isRunning: boolean }>([['a1', actor]]);
    const { ops, runRepo, ensure, stopAndDeregisterAgentActor, botRepo, stopInstanceDirect } = makeDeps({
      registry,
      bots: [
        { id: 'bot-1', status: 'running' },
        { id: 'bot-2', status: 'stopped' }, // not running → skipped
        { id: 'bot-3', status: 'running' },
      ],
    });

    const { stoppedBots } = await ops.stopAgent('o1', 'a1');

    expect(runRepo.markStopped).toHaveBeenCalledWith('o1', 'a1');
    expect(stopAndDeregisterAgentActor).toHaveBeenCalledTimes(1);
    expect((ensure as unknown as { evict: ReturnType<typeof vi.fn> }).evict).toHaveBeenCalledWith('o1', 'a1');
    // Only the two running bots are stopped.
    expect(botRepo.markBotStopped).toHaveBeenCalledWith('bot-1');
    expect(botRepo.markBotStopped).toHaveBeenCalledWith('bot-3');
    expect(stopInstanceDirect).toHaveBeenCalledWith('bot-1');
    expect(stopInstanceDirect).toHaveBeenCalledWith('bot-3');
    expect(stoppedBots).toEqual(['bot-1', 'bot-3']);
  });

  it('evicts even when no actor is registered (already stopped) and still cascades', async () => {
    const { ops, ensure, stopAndDeregisterAgentActor, stoppedBots } = {
      ...makeDeps({ registry: new Map(), bots: [{ id: 'bot-1', status: 'running' }] }),
      stoppedBots: undefined,
    };
    const result = await ops.stopAgent('o1', 'a1');
    expect(stopAndDeregisterAgentActor).not.toHaveBeenCalled();
    expect((ensure as unknown as { evict: ReturnType<typeof vi.fn> }).evict).toHaveBeenCalledWith('o1', 'a1');
    expect(result.stoppedBots).toEqual(['bot-1']);
    void stoppedBots;
  });

  it('cascade is best-effort: one failing bot does not block the others', async () => {
    const registry = new Map<string, { isRunning: boolean }>([['a1', { isRunning: true }]]);
    const deps = makeDeps({ registry, bots: [{ id: 'bot-1', status: 'running' }, { id: 'bot-2', status: 'running' }] });
    (deps.botRepo.markBotStopped as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error('db blip on bot-1');
    });

    const { stoppedBots } = await deps.ops.stopAgent('o1', 'a1');

    // bot-1 failed and is NOT reported stopped; bot-2 still stopped.
    expect(stoppedBots).toEqual(['bot-2']);
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it('is idempotent: stopping an already-stopped agent with no running bots stops nothing', async () => {
    const { ops, runRepo } = makeDeps({ registry: new Map(), bots: [{ id: 'bot-1', status: 'stopped' }] });
    const { stoppedBots } = await ops.stopAgent('o1', 'a1');
    expect(runRepo.markStopped).toHaveBeenCalledWith('o1', 'a1');
    expect(stoppedBots).toEqual([]);
  });
});
