// Unit tests for the boundary's agent-direct actor ensure (extracted from
// bin.ts). Covers the A1 (crash → permanent failure) and A2 (concurrent
// reconstruction race) stability fixes, plan
// 001-trading-extraction-completion/A1-ensure-cache-crash-recovery.
//
// The runtime is a hand-rolled fake over the surfaces the ensure touches:
// actorRegistry (get), constructAndRegisterAgentActor, stopAndDeregisterAgentActor.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TradingRuntime, AgentActorSpec } from '@traderton/worker';

// Partial-mock the worker module so the boundary logger's `info` calls can be
// spied (pino does not route through console.log). The spy lives in a hoisted
// holder because vi.mock factories execute before module body assignments.
const { infoSpy } = vi.hoisted(() => ({ infoSpy: vi.fn() }));
vi.mock('@traderton/worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@traderton/worker')>();
  return {
    ...actual,
    createLogger: () => ({ info: infoSpy, warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  };
});
import { buildAgentDirectActorEnsure, type StoredTradingProfile } from './agent-direct-actor-ensure.js';

interface FakeActor {
  isRunning: boolean;
  start: ReturnType<typeof vi.fn>;
  agentId: string;
}

function makeRuntime(opts: { startShouldFail?: boolean } = {}) {
  const registry = new Map<string, FakeActor>();
  const construct = vi.fn((spec: AgentActorSpec): FakeActor => {
    const actor: FakeActor = {
      isRunning: false,
      agentId: spec.agentId,
      start: vi.fn(async () => {
        if (opts.startShouldFail) throw new Error('start failed (simulated)');
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
  const runtime = {
    actorRegistry: registry,
    constructAndRegisterAgentActor: construct,
    stopAndDeregisterAgentActor: stopAndDeregister,
  } as unknown as TradingRuntime;
  return { runtime, registry, construct, stopAndDeregister };
}

const baseInjection = {
  ownerId: 'owner-1',
  actorId: 'agent-1',
  ownerMode: 'paper' as const,
  venue: 'hyperliquid',
  venueType: 'orderbook' as const,
  venueAccountId: 'va-1',
};

let profile: StoredTradingProfile;

function injectionWith() {
  return baseInjection;
}

function profileReader(): (ownerId: string, actorId: string, venueAccountId: string) => Promise<StoredTradingProfile | null> {
  return async () => profile;
}

function buildEnsure(runtime: TradingRuntime) {
  return buildAgentDirectActorEnsure(runtime, profileReader());
}

beforeEach(() => {
  vi.restoreAllMocks();
  profile = {
    capital: '1000',
    riskPosture: null,
    riskOverrides: {},
    executionDefaults: { mode: 'paper' },
    revision: 1n,
  };
});

describe('buildAgentDirectActorEnsure', () => {
  it('1. cache hit + actor running → no reconstruct (fast path intact)', async () => {
    const { runtime, construct } = makeRuntime();
    const ensure = buildEnsure(runtime);

    await ensure(injectionWith({ capital: '1000' }));
    expect(construct).toHaveBeenCalledTimes(1);

    await ensure(injectionWith({ capital: '1000' }));
    expect(construct).toHaveBeenCalledTimes(1); // fast path — no second construct
  });

  it('2. cache hit + actor deregistered (simulated onCrashed) → reconstructs, subsequent ensure succeeds', async () => {
    const { runtime, construct } = makeRuntime();
    const ensure = buildEnsure(runtime);

    await ensure(injectionWith({ capital: '1000' }));
    expect(construct).toHaveBeenCalledTimes(1);

    // Simulate the onCrashed hook (decision-intake.ts): deregister without
    // touching the ensure cache.
    runtime.actorRegistry.get('agent-1'); // exists pre-crash
    (runtime.actorRegistry as Map<string, FakeActor>).delete('agent-1');

    // Previously this returned via the fast path and every submit_decision
    // afterwards failed instance_not_running; now it must reconstruct.
    await ensure(injectionWith({ capital: '1000' }));
    expect(construct).toHaveBeenCalledTimes(2);
    expect(runtime.actorRegistry.get('agent-1')?.isRunning).toBe(true);
  });

  it('3. cache hit + actor stopped-not-crashed (registered, isRunning=false) → reconstructs', async () => {
    const { runtime, construct } = makeRuntime();
    const ensure = buildEnsure(runtime);

    await ensure(injectionWith({ capital: '1000' }));
    expect(construct).toHaveBeenCalledTimes(1);

    const actor = runtime.actorRegistry.get('agent-1');
    if (actor) actor.isRunning = false; // stopped by some other path, still registered

    await ensure(injectionWith({ capital: '1000' }));
    expect(construct).toHaveBeenCalledTimes(2);
    expect(runtime.actorRegistry.get('agent-1')?.isRunning).toBe(true);
  });

  it('4. concurrent invocation during reconstruction → exactly ONE construct+start sequence', async () => {
    const { runtime, construct, stopAndDeregister } = makeRuntime();
    const ensure = buildEnsure(runtime);

    await ensure(injectionWith({ capital: '1000' }));
    expect(construct).toHaveBeenCalledTimes(1);

    // Change the selected profile revision so the next call reconstructs; fire
    // three concurrent invocations (mirrors multiple decisions in one tick).
    profile = { ...profile, capital: '2000', revision: 2n };
    const calls = [
      ensure(injectionWith()),
      ensure(injectionWith()),
      ensure(injectionWith()),
    ];
    await Promise.all(calls);

    // One teardown + one construct despite three concurrent callers (A2
    // single-flight via cache-entry ordering).
    expect(construct).toHaveBeenCalledTimes(2);
    expect(stopAndDeregister).toHaveBeenCalledTimes(1);
    expect(runtime.actorRegistry.get('agent-1')?.isRunning).toBe(true);
  });

  it('5. reconstruction failure → cache evicted → next invocation retries', async () => {
    let startShouldFail = true;
    const { runtime, construct } = makeRuntime();
    // Make start() fail until the flag is flipped (simulates a credential
    // being provisioned between attempts).
    construct.mockImplementation((spec: AgentActorSpec): FakeActor => {
      const actor: FakeActor = {
        isRunning: false,
        agentId: spec.agentId,
        start: vi.fn(async () => {
          if (startShouldFail) throw new Error('start failed (simulated)');
          actor.isRunning = true;
          runtime.actorRegistry.set(actor.agentId, actor as never);
        }),
      };
      runtime.actorRegistry.set(actor.agentId, actor as never);
      return actor;
    });
    const ensure = buildEnsure(runtime);

    await expect(ensure(injectionWith({ capital: '1000' }))).rejects.toThrow('start failed');
    expect(construct).toHaveBeenCalledTimes(1);

    // The failed entry was evicted: the next attempt constructs AGAIN (not a
    // cached rejection), and once start succeeds the entry stays cached.
    startShouldFail = false;
    await ensure(injectionWith({ capital: '1000' }));
    expect(construct).toHaveBeenCalledTimes(2);
    await ensure(injectionWith({ capital: '1000' }));
    expect(construct).toHaveBeenCalledTimes(2); // cached — no extra construct
  });

  it('retry recovery is scoped to the failed actor identity', async () => {
    const { runtime, construct } = makeRuntime();
    let failAgentOne = true;
    construct.mockImplementation((spec: AgentActorSpec): FakeActor => {
      const actor: FakeActor = {
        agentId: spec.agentId,
        isRunning: false,
        start: vi.fn(async () => {
          if (spec.agentId === 'agent-1' && failAgentOne) throw new Error('agent-1 binding unavailable');
          actor.isRunning = true;
          runtime.actorRegistry.set(actor.agentId, actor as never);
        }),
      };
      runtime.actorRegistry.set(actor.agentId, actor as never);
      return actor;
    });
    const profiles = new Map<string, StoredTradingProfile>([
      ['agent-1', profile],
      ['agent-2', profile],
    ]);
    const ensure = buildAgentDirectActorEnsure(runtime, async (_ownerId, actorId) => profiles.get(actorId) ?? null);

    await expect(ensure(baseInjection)).rejects.toThrow('agent-1 binding unavailable');
    await ensure({ ...baseInjection, actorId: 'agent-2' });
    failAgentOne = false;
    await ensure(baseInjection);

    expect(runtime.actorRegistry.get('agent-1')?.isRunning).toBe(true);
    expect(runtime.actorRegistry.get('agent-2')?.isRunning).toBe(true);
    expect(construct).toHaveBeenCalledTimes(3);
  });

  it('6. selected profile mode change → reconstructs', async () => {
    const { runtime, construct } = makeRuntime();
    const ensure = buildEnsure(runtime);

    await ensure(injectionWith());
    expect(construct).toHaveBeenCalledTimes(1);

    // The selected profile is the sole mode authority and a revision change must
    // rebuild the actor because execution mode is construct-time state.
    profile = { ...profile, executionDefaults: { mode: 'live' }, revision: 2n };
    await ensure(injectionWith());
    expect(construct).toHaveBeenCalledTimes(2);
  });

  it('7. same ownerMode (no other change) → fast path preserved', async () => {
    const { runtime, construct } = makeRuntime();
    const ensure = buildEnsure(runtime);

    await ensure({ ...injectionWith({ capital: '1000' }), ownerMode: 'shadow' });
    expect(construct).toHaveBeenCalledTimes(1);

    await ensure({ ...injectionWith({ capital: '1000' }), ownerMode: 'shadow' });
    expect(construct).toHaveBeenCalledTimes(1); // no change → fast path
  });

  it('keeps two agent actors on the same venue account isolated by actor identity', async () => {
    const { runtime, construct } = makeRuntime();
    const profiles = new Map<string, StoredTradingProfile>([
      ['agent-1', profile],
      ['agent-2', { ...profile, revision: 2n }],
    ]);
    const ensure = buildAgentDirectActorEnsure(runtime, async (_ownerId, actorId) => profiles.get(actorId) ?? null);

    await ensure(baseInjection);
    await ensure({ ...baseInjection, actorId: 'agent-2' });
    await ensure(baseInjection);

    expect(construct).toHaveBeenCalledTimes(2);
    expect(runtime.actorRegistry.get('agent-1')?.isRunning).toBe(true);
    expect(runtime.actorRegistry.get('agent-2')?.isRunning).toBe(true);
  });

  it('stops the previous actor before starting when the selected venue binding changes', async () => {
    const events: string[] = [];
    const { runtime, construct, stopAndDeregister } = makeRuntime();
    stopAndDeregister.mockImplementation(async (actor: FakeActor) => {
      events.push(`stop:${actor.agentId}`);
      actor.isRunning = false;
      runtime.actorRegistry.delete(actor.agentId);
    });
    construct.mockImplementation((spec: AgentActorSpec): FakeActor => {
      const actor: FakeActor = {
        agentId: spec.agentId,
        isRunning: false,
        start: vi.fn(async () => {
          events.push(`start:${spec.venueAccountId}`);
          actor.isRunning = true;
          runtime.actorRegistry.set(actor.agentId, actor as never);
        }),
      };
      runtime.actorRegistry.set(actor.agentId, actor as never);
      return actor;
    });
    const ensure = buildEnsure(runtime);

    await ensure(baseInjection);
    profile = { ...profile, revision: 2n };
    await ensure({ ...baseInjection, venueAccountId: 'va-2' });

    expect(events).toEqual(['start:va-1', 'stop:agent-1', 'start:va-2']);
    expect(construct).toHaveBeenCalledTimes(2);
  });

  it('regression: reconstruction logs "agent-direct actor constructed + started" exactly once per rebuild', async () => {
    const { runtime, construct } = makeRuntime();
    const ensure = buildEnsure(runtime);
    infoSpy.mockClear();

    await ensure(injectionWith());
    await ensure(injectionWith()); // fast path — no extra log
    profile = { ...profile, capital: '2000', revision: 2n };
    await ensure(injectionWith()); // profile change → rebuild

    expect(construct).toHaveBeenCalledTimes(2);
    const messages = infoSpy.mock.calls.map((c) => String(c[c.length - 1]));
    const matches = messages.filter((m) => m === 'agent-direct actor constructed + started').length;
    expect(matches).toBe(2); // exactly once per rebuild (2 rebuilds)
  });
});
