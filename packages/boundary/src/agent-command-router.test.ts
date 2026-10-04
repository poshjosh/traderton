// Unit tests for the boundary's agent-actor owner routing (001 S3). Covers the
// sender (forward a remotely-owned decision), the consumer (owner executes a
// forwarded decision + the lease-lost refusal), and the stop-signal subscriber.
//
// Hand-rolled fakes over the touched surfaces — a fake Redis (rpush/blpop/
// lpush/expire + pub/sub), a fake lease, and a stub drive target — mirroring the
// style in agent-direct-actor-ensure.test.ts and bot-stop-subscriber.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AGENT_MESSAGE_TYPES } from '@traderton/domain';
import type { PublishToInbound } from '@traderton/worker';
import {
  wrapPublishToInbound,
  startAgentCommandConsumer,
  subscribeAgentActorStopSignals,
  agentCmdListKey,
  decisionReplyKey,
  AGENT_ACTOR_STOP_CHANNEL_PATTERN,
  type AgentCommandEnvelope,
  type AgentActorStopSubscriberConnection,
} from './agent-command-router.js';
import type { AgentDirectActorInjection } from './agent-direct-actor-ensure.js';

const injection: AgentDirectActorInjection = {
  ownerId: 'owner-1',
  actorId: 'agent-1',
  ownerMode: 'paper',
  venue: 'hyperliquid',
  venueType: 'orderbook',
  venueAccountId: 'va-1',
};

function createLoggerStub() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/**
 * A fake Redis list + reply store. `rpush`/`lpush` append to in-memory lists;
 * `blpop` resolves the next value from the head (or null after the timeout when
 * empty). `expire` is recorded. Enough to drive the sender + consumer without
 * real Redis.
 */
function createFakeRedis() {
  const lists = new Map<string, string[]>();
  const expires: Array<{ key: string; seconds: number }> = [];
  const push = (key: string, value: string, end: 'head' | 'tail') => {
    const list = lists.get(key) ?? [];
    if (end === 'tail') list.push(value);
    else list.unshift(value);
    lists.set(key, list);
    return list.length;
  };
  const quit = vi.fn(async () => 'OK');
  return {
    lists,
    expires,
    quit,
    rpush: vi.fn(async (key: string, value: string) => push(key, value, 'tail')),
    lpush: vi.fn(async (key: string, value: string) => push(key, value, 'head')),
    expire: vi.fn(async (key: string, seconds: number) => {
      expires.push({ key, seconds });
      return 1;
    }),
    blpop: vi.fn(async (key: string, _timeout: number): Promise<[string, string] | null> => {
      const list = lists.get(key);
      if (list && list.length > 0) {
        const value = list.shift()!;
        return [key, value];
      }
      // Nothing queued — mimic a real BLPOP block by resolving null only after a
      // short delay (the real client blocks for `timeout` seconds). Without the
      // delay the consumer loop would spin tightly on an empty list and starve
      // the test's microtask flush.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return null;
    }),
  };
}

/** A fake lease over an in-memory holder map — only `holder` is read here. */
function createFakeLease(holders: Map<string, string>) {
  return {
    holder: vi.fn(async (id: string): Promise<string | null> => holders.get(id) ?? null),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('wrapPublishToInbound (sender)', () => {
  it('forwards a decision for a remotely owned agent to the owner\'s command list', async () => {
    const redis = createFakeRedis();
    const local = vi.fn<Parameters<PublishToInbound>, ReturnType<PublishToInbound>>(async () => {});
    const send = wrapPublishToInbound({
      local,
      ensureResult: { owner: 'remote', workerId: 'worker-owner1' },
      injection,
      redis,
      logger: createLoggerStub(),
    });

    const payload = { decisionId: 'dec-1', instrumentId: 'BTC', _expectsReply: true };
    await send(AGENT_MESSAGE_TYPES.DECISION_SUBMIT, payload);

    // RPUSH onto the OWNER's command list with the full envelope — and the local
    // drive target is NOT invoked (the owner runs it).
    const listKey = agentCmdListKey('worker-owner1');
    expect(redis.rpush).toHaveBeenCalledTimes(1);
    expect(redis.rpush).toHaveBeenCalledWith(listKey, expect.any(String));
    const envelope = JSON.parse(redis.lists.get(listKey)![0]!) as AgentCommandEnvelope;
    expect(envelope).toEqual({ type: AGENT_MESSAGE_TYPES.DECISION_SUBMIT, payload, injection });
    expect(local).not.toHaveBeenCalled();
  });

  it('runs a decision locally when the agent is owned here', async () => {
    const redis = createFakeRedis();
    const local = vi.fn<Parameters<PublishToInbound>, ReturnType<PublishToInbound>>(async () => {});
    const send = wrapPublishToInbound({
      local,
      ensureResult: { owner: 'local' },
      injection,
      redis,
      logger: createLoggerStub(),
    });

    await send(AGENT_MESSAGE_TYPES.DECISION_SUBMIT, { decisionId: 'dec-2', _expectsReply: true });

    expect(local).toHaveBeenCalledTimes(1);
    expect(redis.rpush).not.toHaveBeenCalled();
  });

  it('runs a non-decision type locally even for a remotely owned agent', async () => {
    const redis = createFakeRedis();
    const local = vi.fn<Parameters<PublishToInbound>, ReturnType<PublishToInbound>>(async () => {});
    const send = wrapPublishToInbound({
      local,
      ensureResult: { owner: 'remote', workerId: 'worker-owner1' },
      injection,
      redis,
      logger: createLoggerStub(),
    });

    await send(AGENT_MESSAGE_TYPES.MANAGE_BOT, { action: 'stop', botId: 'bot-1' });

    // MANAGE_BOT acts through run-state + bot rows, so it stays local.
    expect(local).toHaveBeenCalledTimes(1);
    expect(redis.rpush).not.toHaveBeenCalled();
  });

  it('writes a precondition.not_ready reply instead of forwarding when the owner is unknown', async () => {
    const redis = createFakeRedis();
    const local = vi.fn<Parameters<PublishToInbound>, ReturnType<PublishToInbound>>(async () => {});
    const send = wrapPublishToInbound({
      local,
      ensureResult: { owner: 'remote', workerId: '' }, // holder-unknown sentinel
      injection,
      redis,
      logger: createLoggerStub(),
    });

    await send(AGENT_MESSAGE_TYPES.DECISION_SUBMIT, { decisionId: 'dec-3', _expectsReply: true });

    // No RPUSH to an empty key; a precondition.not_ready reply is written to the
    // tool's BLPOP key instead so the tool fails fast (the tool ignores the
    // reply's `retryable` flag — re-submission is the agent's next decision).
    expect(redis.rpush).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();
    const reply = JSON.parse(redis.lists.get(decisionReplyKey('dec-3'))![0]!) as {
      status: string;
      code: string;
      retryable: boolean;
    };
    expect(reply).toMatchObject({ status: 'rejected', code: 'precondition.not_ready', retryable: true });
    expect(redis.expires).toContainEqual({ key: decisionReplyKey('dec-3'), seconds: 60 });
  });
});

describe('startAgentCommandConsumer (owner execution)', () => {
  it('owner executes a forwarded decision and replies on the tool\'s reply key', async () => {
    const redis = createFakeRedis();
    const workerId = 'worker-owner1';
    // We hold the agent lease.
    const lease = createFakeLease(new Map([[`agent:${injection.actorId}`, workerId]]));

    // The local drive target the owner rebuilds — stub it and write the reply the
    // real drive target would (so the test asserts the reply reaches the key).
    const driveTarget = vi.fn<Parameters<PublishToInbound>, ReturnType<PublishToInbound>>(
      async (_type, payload) => {
        if (payload['_expectsReply'] === true) {
          const key = decisionReplyKey(String(payload['decisionId']));
          await redis.lpush(key, JSON.stringify({ status: 'accepted', planId: 'plan-9' }));
          await redis.expire(key, 60);
        }
      },
    );

    // Pre-seed the owner's command list with a forwarded envelope.
    const envelope: AgentCommandEnvelope = {
      type: AGENT_MESSAGE_TYPES.DECISION_SUBMIT,
      payload: { decisionId: 'dec-10', instrumentId: 'BTC', _expectsReply: true },
      injection,
    };
    await redis.rpush(agentCmdListKey(workerId), JSON.stringify(envelope));

    const consumer = startAgentCommandConsumer({
      redis,
      workerId,
      lease,
      createDriveTarget: () => driveTarget,
      logger: createLoggerStub(),
      blockSeconds: 1,
    });
    await wait(10);
    consumer.stop();

    // Lease was checked, the local drive target ran, and the reply landed on the
    // tool's key.
    expect(lease.holder).toHaveBeenCalledWith(`agent:${injection.actorId}`);
    expect(driveTarget).toHaveBeenCalledTimes(1);
    expect(driveTarget).toHaveBeenCalledWith(envelope.type, envelope.payload);
    const reply = JSON.parse(redis.lists.get(decisionReplyKey('dec-10'))![0]!) as { status: string };
    expect(reply.status).toBe('accepted');
  });

  it('refuses a forwarded decision after losing the lease', async () => {
    const redis = createFakeRedis();
    const workerId = 'worker-owner1';
    // A DIFFERENT worker now holds the lease (we lost it after the sender forwarded).
    const lease = createFakeLease(new Map([[`agent:${injection.actorId}`, 'worker-other']]));
    const driveTarget = vi.fn<Parameters<PublishToInbound>, ReturnType<PublishToInbound>>(async () => {});

    const envelope: AgentCommandEnvelope = {
      type: AGENT_MESSAGE_TYPES.DECISION_SUBMIT,
      payload: { decisionId: 'dec-11', instrumentId: 'BTC', _expectsReply: true },
      injection,
    };
    await redis.rpush(agentCmdListKey(workerId), JSON.stringify(envelope));

    const consumer = startAgentCommandConsumer({
      redis,
      workerId,
      lease,
      createDriveTarget: () => driveTarget,
      logger: createLoggerStub(),
      blockSeconds: 1,
    });
    await wait(10);
    consumer.stop();

    // The decision is NOT executed; a precondition.not_ready reply is written so
    // the sender's tool fails fast; re-submission is the agent's next decision
    // (whose re-ensure resolves the new owner after takeover).
    expect(driveTarget).not.toHaveBeenCalled();
    const reply = JSON.parse(redis.lists.get(decisionReplyKey('dec-11'))![0]!) as {
      status: string;
      code: string;
      retryable: boolean;
    };
    expect(reply).toMatchObject({ status: 'rejected', code: 'precondition.not_ready', retryable: true });
  });
});

describe('subscribeAgentActorStopSignals', () => {
  /** In-memory pattern pub/sub (mirrors the bot-stop subscriber test). */
  function createFakePubSub() {
    const patterns: string[] = [];
    const listeners: Array<(pattern: string, channel: string, message: string) => void> = [];
    const subscriber: AgentActorStopSubscriberConnection = {
      psubscribe: (pattern, callback) => {
        patterns.push(pattern);
        callback(null);
      },
      on: (_event, listener) => {
        listeners.push(listener);
      },
    };
    const publish = (channel: string, message: string) => {
      for (const pattern of patterns) {
        const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
        if (channel.startsWith(prefix)) {
          for (const listener of listeners) listener(pattern, channel, message);
        }
      }
    };
    return { subscriber, publish, patterns };
  }

  it('subscribes to the agent-actor:stop:* pattern', () => {
    const { subscriber, patterns } = createFakePubSub();
    subscribeAgentActorStopSignals(subscriber, vi.fn().mockResolvedValue(undefined), createLoggerStub());
    expect(patterns).toEqual([AGENT_ACTOR_STOP_CHANNEL_PATTERN]);
  });

  it('stops a remotely owned agent actor on the stop signal', async () => {
    const { subscriber, publish } = createFakePubSub();
    const stopAgentActor = vi.fn().mockResolvedValue(undefined);
    subscribeAgentActorStopSignals(subscriber, stopAgentActor, createLoggerStub());

    publish('agent-actor:stop:agent-42', '1');
    await flush();

    expect(stopAgentActor).toHaveBeenCalledTimes(1);
    expect(stopAgentActor).toHaveBeenCalledWith('agent-42');
  });

  it('ignores a stop signal with an empty agent id', async () => {
    const { subscriber, publish } = createFakePubSub();
    const stopAgentActor = vi.fn().mockResolvedValue(undefined);
    subscribeAgentActorStopSignals(subscriber, stopAgentActor, createLoggerStub());

    publish('agent-actor:stop:', '1');
    await flush();

    expect(stopAgentActor).not.toHaveBeenCalled();
  });

  it('logs and survives a failed stop', async () => {
    const { subscriber, publish } = createFakePubSub();
    const logger = createLoggerStub();
    const stopAgentActor = vi.fn().mockRejectedValue(new Error('boom'));
    subscribeAgentActorStopSignals(subscriber, stopAgentActor, logger);

    publish('agent-actor:stop:agent-1', '1');
    await flush();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1' }),
      'Failed to stop agent actor via agent-actor:stop signal',
    );
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});
