import { describe, expect, it, vi } from 'vitest';
import { botManagementTools } from '@traderton/worker';
import type { AgentTool, TradingToolContext } from '@traderton/domain';
import {
  subscribeBotStopSignals,
  BOT_STOP_CHANNEL_PATTERN,
  type BotStopSubscriberConnection,
} from './bot-stop-subscriber.js';

/** In-memory Redis pub/sub: PUBLISH on one side reaches pattern subscribers. */
function createFakePubSub() {
  const patterns: string[] = [];
  const listeners: Array<(pattern: string, channel: string, message: string) => void> = [];
  const subscriber: BotStopSubscriberConnection = {
    psubscribe: (pattern, callback) => {
      patterns.push(pattern);
      callback(null);
    },
    on: (_event, listener) => {
      listeners.push(listener);
    },
  };
  const publish = async (channel: string, message: string): Promise<number> => {
    let delivered = 0;
    for (const pattern of patterns) {
      const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
      if (channel.startsWith(prefix)) {
        for (const listener of listeners) listener(pattern, channel, message);
        delivered++;
      }
    }
    return delivered;
  };
  return { subscriber, publish, patterns };
}

function createLoggerStub() {
  return { info: vi.fn(), error: vi.fn() };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('subscribeBotStopSignals', () => {
  it('subscribes to the bot:stop:* pattern', () => {
    const { subscriber, patterns } = createFakePubSub();
    subscribeBotStopSignals(subscriber, vi.fn().mockResolvedValue(undefined), createLoggerStub());
    expect(patterns).toEqual([BOT_STOP_CHANNEL_PATTERN]);
  });

  it('stops the bot named in the channel', async () => {
    const { subscriber, publish } = createFakePubSub();
    const stopInstance = vi.fn().mockResolvedValue(undefined);
    subscribeBotStopSignals(subscriber, stopInstance, createLoggerStub());

    await publish('bot:stop:bot-42', '1');

    expect(stopInstance).toHaveBeenCalledTimes(1);
    expect(stopInstance).toHaveBeenCalledWith('bot-42');
  });

  it('ignores a signal with an empty bot id', async () => {
    const { subscriber, publish } = createFakePubSub();
    const stopInstance = vi.fn().mockResolvedValue(undefined);
    subscribeBotStopSignals(subscriber, stopInstance, createLoggerStub());

    await publish('bot:stop:', '1');

    expect(stopInstance).not.toHaveBeenCalled();
  });

  it('logs and survives a failed stop', async () => {
    const { subscriber, publish } = createFakePubSub();
    const logger = createLoggerStub();
    const stopInstance = vi.fn().mockRejectedValue(new Error('boom'));
    subscribeBotStopSignals(subscriber, stopInstance, logger);

    await publish('bot:stop:bot-1', '1');
    await flush();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-1' }),
      'Failed to stop instance via bot:stop signal',
    );
  });

  it('stops the running actor when the stop_bot tool is called (E0 regression)', async () => {
    const { subscriber, publish } = createFakePubSub();
    const stopInstance = vi.fn().mockResolvedValue(undefined);
    subscribeBotStopSignals(subscriber, stopInstance, createLoggerStub());

    const stopBotTool = botManagementTools.find((t) => t.name === 'stop_bot') as
      | AgentTool<TradingToolContext>
      | undefined;
    expect(stopBotTool).toBeDefined();

    const unused = () => Promise.reject(new Error('not used by stop_bot'));
    const botRepo: NonNullable<TradingToolContext['botRepo']> = {
      getBotById: vi.fn().mockResolvedValue({
        id: 'bot-7',
        status: 'running',
        creatorType: 'agent',
        creatorId: 'agent-1',
        startedAt: new Date(),
        stoppedAt: null,
      }),
      markBotStopped: vi.fn().mockResolvedValue(undefined),
      restoreBotRuntimeState: vi.fn().mockResolvedValue(undefined),
      getBotsByCreator: unused,
      getBotsByOwner: unused,
      getBotByIdForOwner: unused,
      deleteBotByIdForOwner: unused,
      insertStoppedBot: unused,
      markBotRunning: unused,
      updateBotConfig: unused,
      getAnalyticsByCreator: unused,
      getOpenPositionsByCreator: unused,
    };
    const ctx = {
      agentId: 'agent-1',
      sessionId: 's:owner-1',
      executionMode: 'paper',
      authorizationMode: 'approval_required',
      publishToInbound: async () => {},
      botRepo,
      redis: { publish } as TradingToolContext['redis'],
    } satisfies TradingToolContext;

    const result = await stopBotTool!.execute({ botId: 'bot-7' }, ctx);

    expect(result.success).toBe(true);
    expect(botRepo.markBotStopped).toHaveBeenCalledWith('bot-7');
    expect(stopInstance).toHaveBeenCalledWith('bot-7');
  });
});
