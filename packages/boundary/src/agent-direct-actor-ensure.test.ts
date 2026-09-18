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
import { buildAgentDirectActorEnsure, type AgentRiskSpec } from './agent-direct-actor-ensure.js';

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

function injectionWith(spec?: AgentRiskSpec) {
  return { ...baseInjection, agentRiskSpec: spec };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('buildAgentDirectActorEnsure', () => {
  it('1. cache hit + actor running → no reconstruct (fast path intact)', async () => {
    const { runtime, construct } = makeRuntime();
    const ensure = buildAgentDirectActorEnsure(runtime);

    await ensure(injectionWith({ capital: '1000' }));
    expect(construct).toHaveBeenCalledTimes(1);

    await ensure(injectionWith({ capital: '1000' }));
    expect(construct).toHaveBeenCalledTimes(1); // fast path — no second construct
  });

  it('2. cache hit + actor deregistered (simulated onCrashed) → reconstructs, subsequent ensure succeeds', async () => {
    const { runtime, construct } = makeRuntime();
    const ensure = buildAgentDirectActorEnsure(runtime);

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
    const ensure = buildAgentDirectActorEnsure(runtime);

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
    const ensure = buildAgentDirectActorEnsure(runtime);

    await ensure(injectionWith({ capital: '1000' }));
    expect(construct).toHaveBeenCalledTimes(1);

    // Change the spec so the next call reconstructs; fire three concurrent
    // invocations (mirrors the live LLM submitting 2–3 decisions per tick).
    const calls = [
      ensure(injectionWith({ capital: '2000' })),
      ensure(injectionWith({ capital: '2000' })),
      ensure(injectionWith({ capital: '2000' })),
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
    const ensure = buildAgentDirectActorEnsure(runtime);

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

  it('regression: reconstruction logs "agent-direct actor constructed + started" exactly once per rebuild', async () => {
    const { runtime, construct } = makeRuntime();
    const ensure = buildAgentDirectActorEnsure(runtime);
    infoSpy.mockClear();

    await ensure(injectionWith({ capital: '1000' }));
    await ensure(injectionWith({ capital: '1000' })); // fast path — no extra log
    await ensure(injectionWith({ capital: '2000' })); // spec change → rebuild

    expect(construct).toHaveBeenCalledTimes(2);
    const messages = infoSpy.mock.calls.map((c) => String(c[c.length - 1]));
    const matches = messages.filter((m) => m === 'agent-direct actor constructed + started').length;
    expect(matches).toBe(2); // exactly once per rebuild (2 rebuilds)
  });
});
