import { describe, it, expect, vi } from 'vitest';
import type { TradingToolContext } from '@traderton/domain';
import { agentLifecycleTools } from './agent-lifecycle.js';

const startAgentActorTool = agentLifecycleTools.find((t) => t.name === 'start_agent_actor')!;
const stopAgentActorTool = agentLifecycleTools.find((t) => t.name === 'stop_agent_actor')!;

/** Minimal TradingToolContext with the agent-actor lifecycle port overridable. */
function makeCtx(overrides: Partial<TradingToolContext> = {}): TradingToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    ownerId: 'owner-1',
    executionMode: 'paper',
    authorizationMode: 'direct',
    redis: {} as unknown as TradingToolContext['redis'],
    publishToInbound: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('start_agent_actor', () => {
  it('records running state and returns the running state', async () => {
    const recordRunning = vi.fn(async () => undefined);
    const stop = vi.fn(async () => ({ stoppedBots: [] }));
    const ctx = makeCtx({ agentActorLifecycle: { recordRunning, stop } });

    const result = await startAgentActorTool.execute({}, ctx);

    expect(recordRunning).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ ok: true, actorId: 'agent-1', desiredState: 'running' });
  });

  it('is categorised as a write so the boundary idempotency-wraps it', () => {
    expect(startAgentActorTool.category).toBe('write-database');
  });

  it('repeated calls just upsert the same running state (idempotent)', async () => {
    const recordRunning = vi.fn(async () => undefined);
    const ctx = makeCtx({ agentActorLifecycle: { recordRunning, stop: vi.fn(async () => ({ stoppedBots: [] })) } });

    await startAgentActorTool.execute({}, ctx);
    await startAgentActorTool.execute({}, ctx);

    expect(recordRunning).toHaveBeenCalledTimes(2); // each call upserts the same running row
  });

  it('fails cleanly (fault:false) when the lifecycle port is absent', async () => {
    const result = await startAgentActorTool.execute({}, makeCtx());
    expect(result.success).toBe(false);
    expect(result.fault).toBe(false);
  });

  it('keeps venueAccountId in the parsed payload', () => {
    // The boundary subject resolver reads venueAccountId from the Zod-parsed
    // payload to pick the actor's venue account for an owner with several
    // accounts; z.object({}) would strip it (precondition.not_ready).
    const parsed = startAgentActorTool.parametersSchema!.parse({ venueAccountId: 'venue-7' });
    expect(parsed).toEqual({ venueAccountId: 'venue-7' });
  });

  it('parses an empty payload (venueAccountId optional)', () => {
    expect(startAgentActorTool.parametersSchema!.parse({})).toEqual({});
  });
});

describe('stop_agent_actor', () => {
  it('stops the actor and reports the bots that were stopped', async () => {
    const stop = vi.fn(async () => ({ stoppedBots: ['bot-1', 'bot-2'] }));
    const ctx = makeCtx({ agentActorLifecycle: { recordRunning: vi.fn(async () => undefined), stop } });

    const result = await stopAgentActorTool.execute({}, ctx);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ ok: true, actorId: 'agent-1', stoppedBots: ['bot-1', 'bot-2'] });
  });

  it('is a venue-free owner-scoped write', () => {
    expect(stopAgentActorTool.category).toBe('write-database');
    expect(stopAgentActorTool.ownerScopedNoVenue).toBe(true);
  });

  it('repeated stops stay safe — a stopped agent reports no new bots', async () => {
    const stop = vi
      .fn()
      .mockResolvedValueOnce({ stoppedBots: ['bot-1'] })
      .mockResolvedValueOnce({ stoppedBots: [] });
    const ctx = makeCtx({ agentActorLifecycle: { recordRunning: vi.fn(async () => undefined), stop } });

    const first = await stopAgentActorTool.execute({}, ctx);
    const second = await stopAgentActorTool.execute({}, ctx);

    expect((first.data as { stoppedBots: string[] }).stoppedBots).toEqual(['bot-1']);
    expect((second.data as { stoppedBots: string[] }).stoppedBots).toEqual([]);
  });

  it('fails cleanly (fault:false) when the lifecycle port is absent', async () => {
    const result = await stopAgentActorTool.execute({}, makeCtx());
    expect(result.success).toBe(false);
    expect(result.fault).toBe(false);
  });
});
