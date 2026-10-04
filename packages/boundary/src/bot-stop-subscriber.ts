// Bot stop-signal consumer (011 Wave E, item E0 — HOTFIX).
//
// The copied `stop_bot` tool (`@traderton/worker` tools/bots.ts) marks the bot
// row `stopped` and then PUBLISHes `bot:stop:{botId}`. In herobids the worker
// process subscribed to that channel and stopped the in-process actor
// (herobids apps/worker/src/index.ts at 45271d28^ ~L2974–2988). That subscriber
// was deleted with the herobids in-process runtime (L3d-5) and never re-homed
// here, so a stopped bot kept trading. This module restores it, copied in
// behaviour: psubscribe `bot:stop:*` → `stopInstanceDirect(botId)`.
//
// See 001 "Actor event + lifecycle callbacks never authored (item C2)" and 003
// (2026-10-04).

/** The subset of an ioredis subscriber connection this consumer needs. */
export interface BotStopSubscriberConnection {
  psubscribe(pattern: string, callback: (err?: Error | null) => void): unknown;
  on(event: 'pmessage', listener: (pattern: string, channel: string, message: string) => void): unknown;
}

export interface BotStopSubscriberLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export const BOT_STOP_CHANNEL_PREFIX = 'bot:stop:';
export const BOT_STOP_CHANNEL_PATTERN = `${BOT_STOP_CHANNEL_PREFIX}*`;

/**
 * Subscribe to `bot:stop:*` and stop the named bot on this process.
 *
 * `stopInstance` is `WorkerRuntime.stopInstanceDirect`, which is a logged no-op
 * when this process does not own the bot, so broadcasting to every boundary
 * process is safe.
 */
export function subscribeBotStopSignals(
  subscriber: BotStopSubscriberConnection,
  stopInstance: (botId: string) => Promise<void>,
  logger: BotStopSubscriberLogger,
): void {
  subscriber.psubscribe(BOT_STOP_CHANNEL_PATTERN, (err) => {
    if (err) logger.error({ err }, 'Failed to subscribe to bot:stop:* channels');
  });
  subscriber.on('pmessage', (_pattern, channel) => {
    if (!channel.startsWith(BOT_STOP_CHANNEL_PREFIX)) return;
    const botId = channel.slice(BOT_STOP_CHANNEL_PREFIX.length);
    if (!botId) return;
    logger.info({ botId }, 'Received bot:stop signal — stopping instance directly');
    stopInstance(botId).catch((err: unknown) => {
      logger.error({ err, botId }, 'Failed to stop instance via bot:stop signal');
    });
  });
}
