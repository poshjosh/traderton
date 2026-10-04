// 001 S4 — the headline multi-replica safety guarantee for the boot rehydrate:
// two runtimes (two "containers") that SHARE a single in-memory lease holder map
// both rehydrate the SAME running agent, and exactly ONE constructs the actor.
// The other's ensure loses the `agent:{agentId}` acquire race and resolves as a
// `remote` no-op success, so no duplicate scan loop / tracker is created.
//
// This wires the REAL S2 ensure (`buildAgentDirectActorEnsure`) and the REAL
// rehydrate (`rehydrateAgentActors`) over two fake runtimes sharing one lease
// map (mirrors `makeFakeLease` from agent-direct-actor-ensure.test.ts), so the
// single-actor guarantee is asserted end-to-end through the exact code boot runs.

import { describe, it, expect, vi } from 'vitest';
import type { TradingRuntime, AgentActorSpec } from '@traderton/worker';

// Partial-mock the worker module so the ensure's boundary logger does not emit
// real pino output during the test (same idiom as agent-direct-actor-ensure.test.ts).
vi.mock('@traderton/worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@traderton/worker')>();
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  };
});

import { buildAgentDirectActorEnsure, type StoredTradingProfile } from './agent-direct-actor-ensure.js';
import { rehydrateAgentActors, type RehydrateAgentRun } from './agent-actor-rehydrate.js';

interface FakeActor {
  isRunning: boolean;
  start: ReturnType<typeof vi.fn>;
  agentId: string;
}

/**
 * A fake `InstanceLease` over a SHARED in-memory key→holder map. Two of these
 * (one per worker) pointing at the same `holders` map model two containers on
 * one Redis: `acquire` is SET NX (first worker wins), `release` is own-only,
 * `holder` reads the current owner.
 */
function makeFakeLease(workerId: string, holders: Map<string, string>) {
  const acquire = vi.fn(async (id: string): Promise<boolean> => {
    if (holders.has(id)) return false;
    holders.set(id, workerId);
    return true;
  });
  const release = vi.fn(async (id: string): Promise<boolean> => {
    if (holders.get(id) === workerId) {
      holders.delete(id);
      return true;
    }
    return false;
  });
  const holder = vi.fn(async (id: string): Promise<string | null> => holders.get(id) ?? null);
  return { workerId, lease: { acquire, release, holder } };
}

/** One fake runtime (= one container) wired to the SHARED lease map. */
function makeRuntime(workerId: string, holders: Map<string, string>) {
  const registry = new Map<string, FakeActor>();
  const construct = vi.fn((spec: AgentActorSpec): FakeActor => {
    const actor: FakeActor = {
      isRunning: false,
      agentId: spec.agentId,
      start: vi.fn(async () => {
        actor.isRunning = true;
        registry.set(actor.agentId, actor);
      }),
    };
    registry.set(actor.agentId, actor);
    return actor;
  });
  const stopAndDeregister = vi.fn(async (actor: FakeActor) => {
    actor.isRunning = false;
    registry.delete(actor.agentId);
  });
  const { lease } = makeFakeLease(workerId, holders);
  const runtime = {
    actorRegistry: registry,
    constructAndRegisterAgentActor: construct,
    stopAndDeregisterAgentActor: stopAndDeregister,
    workerId,
    agentLease: lease,
  } as unknown as TradingRuntime;
  return { runtime, registry, construct };
}

const profile: StoredTradingProfile = {
  capital: '1000',
  riskPosture: null,
  riskOverrides: {},
  executionDefaults: { mode: 'paper' },
  scanMode: null,
  activeStrategy: null,
  revision: 1n,
};

const runningRow: RehydrateAgentRun = {
  ownerId: 'owner-1',
  actorId: 'agent-1',
  venueAccountId: 'va-1',
  venue: 'hyperliquid',
  venueType: 'orderbook',
};

function buildLogger() {
  return { info: vi.fn(), error: vi.fn() };
}

describe('rehydrate respects the shared agent lease (001 S4)', () => {
  it('two runtimes rehydrating the same agent start exactly one actor', async () => {
    // One shared lease map = one Redis across both "containers".
    const holders = new Map<string, string>();
    const a = makeRuntime('worker-aaaa', holders);
    const b = makeRuntime('worker-bbbb', holders);

    const ensureA = buildAgentDirectActorEnsure(a.runtime, async () => profile);
    const ensureB = buildAgentDirectActorEnsure(b.runtime, async () => profile);

    // Both containers boot and rehydrate the SAME running agent, concurrently.
    const [constructedA, constructedB] = await Promise.all([
      rehydrateAgentActors({
        listRunning: async () => [runningRow],
        ensureAgent: (run) => ensureA(injectionFor(run)),
        logger: buildLogger(),
      }),
      rehydrateAgentActors({
        listRunning: async () => [runningRow],
        ensureAgent: (run) => ensureB(injectionFor(run)),
        logger: buildLogger(),
      }),
    ]);

    // Exactly one worker constructed+started the actor; the other no-op'd.
    const totalConstructs = a.construct.mock.calls.length + b.construct.mock.calls.length;
    expect(totalConstructs).toBe(1);

    // The counts reported by rehydrate agree: one local construction total.
    expect(constructedA + constructedB).toBe(1);

    // Exactly one registry holds a running actor; the other is empty.
    const aliveA = a.registry.get('agent-1')?.isRunning === true;
    const aliveB = b.registry.get('agent-1')?.isRunning === true;
    expect(aliveA !== aliveB).toBe(true); // exactly one is alive (XOR)

    // The lease is held by exactly the worker that constructed.
    const owner = holders.get('agent:agent-1');
    expect(owner === 'worker-aaaa' || owner === 'worker-bbbb').toBe(true);
    const ownerConstructed = owner === 'worker-aaaa' ? a : b;
    expect(ownerConstructed.construct).toHaveBeenCalledTimes(1);
  });

  it('a late-booting second runtime no-ops when the first already owns the agent', async () => {
    // Sequential boot: A rehydrates first and takes the lease; B boots after and
    // must find the agent remotely owned → construct nothing.
    const holders = new Map<string, string>();
    const a = makeRuntime('worker-aaaa', holders);
    const b = makeRuntime('worker-bbbb', holders);
    const ensureA = buildAgentDirectActorEnsure(a.runtime, async () => profile);
    const ensureB = buildAgentDirectActorEnsure(b.runtime, async () => profile);

    const constructedA = await rehydrateAgentActors({
      listRunning: async () => [runningRow],
      ensureAgent: (run) => ensureA(injectionFor(run)),
      logger: buildLogger(),
    });
    const constructedB = await rehydrateAgentActors({
      listRunning: async () => [runningRow],
      ensureAgent: (run) => ensureB(injectionFor(run)),
      logger: buildLogger(),
    });

    expect(constructedA).toBe(1); // A constructed locally
    expect(constructedB).toBe(0); // B saw a remote owner and skipped
    expect(a.construct).toHaveBeenCalledTimes(1);
    expect(b.construct).not.toHaveBeenCalled();
    expect(holders.get('agent:agent-1')).toBe('worker-aaaa');
  });
});

/**
 * Map a durable run row to the ensure's injection (mirrors ensureFromRun's
 * `injectionFor`). The run's `venueType` is a free `string`; all rows in this
 * test are `orderbook`, so narrow to the union with the same safe default the
 * production path uses.
 */
function injectionFor(run: RehydrateAgentRun) {
  return {
    ownerId: run.ownerId,
    actorId: run.actorId,
    ownerMode: 'paper' as const,
    venue: run.venue,
    venueType: run.venueType === 'swap' ? ('swap' as const) : ('orderbook' as const),
    venueAccountId: run.venueAccountId,
  };
}
