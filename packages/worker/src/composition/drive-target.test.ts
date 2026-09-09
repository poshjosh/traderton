/**
 * AUTHORED test (Phase 9b item D) — NOT a copied parity oracle.
 *
 * The in-process drive target + bot-lifecycle handler are AUTHORED seam/wiring
 * (the cross-process herobids Redis-stream hop made in-process), so there is no
 * herobids test to copy. This test asserts the seam's routing + the handler's
 * trading-core wiring DETERMINISTICALLY: no real Redis, DB, network, or runtime.
 *
 * It stubs the runtime (`enqueueLifecycle`), item C's `submitDecision`, the bot
 * repository, redis (a fake list for the decision-reply write), and the item-E
 * `botLimit` seam. It does NOT stub the handler's own dispatch/validation — the
 * real `createDriveTarget` routes by type, the real `BotConfigSchema` +
 * `checkModeEscalation` gate config, and the real reply JSON is written to the
 * fake redis and read back the way `tools/trading.ts`'s `blpop` would.
 *
 * Traces the handler to herobids `handleManageBot` trading core
 * (agent-message-broker.ts:552–988) + `processInbound` routing (:277 / :321);
 * the agent/session/connection-grant/LLM shell is DROPPED (013 §6 / 021 §5).
 */
import { describe, it, expect, vi } from 'vitest';
import { AGENT_MESSAGE_TYPES } from '@traderton/domain';

import {
  createDriveTarget,
  type DriveTargetDeps,
  type DriveBotRecord,
  type BotLimitSeam,
} from './drive-target.js';
import type { DecisionSubmitInput, DecisionSubmitResult } from './decision-intake.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const OWNER_ID = 'owner-1';
const ACTOR_ID = 'agent-1';

function validBotConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: 'BTC',
    strategy: { type: 'momentum', decisionMode: 'mechanical' },
    execution: { mode: 'paper' },
    ...overrides,
  };
}

function makeBotRecord(overrides: Partial<DriveBotRecord> = {}): DriveBotRecord {
  return {
    id: 'bot-1',
    status: 'stopped',
    config: validBotConfig({ venue: 'hyperliquid', venueType: 'orderbook' }),
    creatorType: 'agent',
    creatorId: ACTOR_ID,
    ownerId: OWNER_ID,
    startedAt: null,
    stoppedAt: null,
    ...overrides,
  };
}

/** A fake redis LIST backing the decision-reply key (lpush + expire + blpop read-back). */
function makeFakeRedis() {
  const lists = new Map<string, string[]>();
  const expiries = new Map<string, number>();
  return {
    lpush: vi.fn(async (key: string, value: string) => {
      const arr = lists.get(key) ?? [];
      arr.unshift(value);
      lists.set(key, arr);
      return arr.length;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      expiries.set(key, seconds);
      return 1;
    }),
    /** Read-back the way tools/trading.ts's blpop(replyKey, 30) would. */
    blpopSync: (key: string): [string, string] | null => {
      const arr = lists.get(key);
      if (!arr || arr.length === 0) return null;
      return [key, arr.shift()!];
    },
    _lists: lists,
    _expiries: expiries,
  };
}

interface Stubs {
  enqueueLifecycle: ReturnType<typeof vi.fn>;
  submitDecision: ReturnType<typeof vi.fn>;
  botRepo: {
    getBotById: ReturnType<typeof vi.fn>;
    updateBotConfig: ReturnType<typeof vi.fn>;
    restoreBotConfig: ReturnType<typeof vi.fn>;
    markBotStopped: ReturnType<typeof vi.fn>;
    markBotRunning: ReturnType<typeof vi.fn>;
    restoreBotRuntimeState: ReturnType<typeof vi.fn>;
  };
  redis: ReturnType<typeof makeFakeRedis>;
  botLimit: {
    tryCreateBotWithLimit: ReturnType<typeof vi.fn>;
    tryMarkBotRunningWithLimit: ReturnType<typeof vi.fn>;
  };
}

function makeDeps(overrides: Partial<DriveTargetDeps> = {}, stubOverrides: Partial<Stubs> = {}): { deps: DriveTargetDeps; stubs: Stubs } {
  const stubs: Stubs = {
    enqueueLifecycle: vi.fn(async () => undefined),
    submitDecision: vi.fn(async (): Promise<DecisionSubmitResult> => ({ status: 'accepted', planId: 'plan-1' })),
    botRepo: {
      getBotById: vi.fn(async () => makeBotRecord()),
      updateBotConfig: vi.fn(async () => undefined),
      restoreBotConfig: vi.fn(async () => undefined),
      markBotStopped: vi.fn(async () => undefined),
      markBotRunning: vi.fn(async () => undefined),
      restoreBotRuntimeState: vi.fn(async () => undefined),
    },
    redis: makeFakeRedis(),
    botLimit: {
      tryCreateBotWithLimit: vi.fn(async () => ({ created: true, botId: 'bot-new' })),
      tryMarkBotRunningWithLimit: vi.fn(async () => true),
    },
    ...stubOverrides,
  };

  const deps: DriveTargetDeps = {
    runtime: { enqueueLifecycle: stubs.enqueueLifecycle } as unknown as DriveTargetDeps['runtime'],
    submitDecision: stubs.submitDecision as unknown as DriveTargetDeps['submitDecision'],
    botRepo: stubs.botRepo as unknown as DriveTargetDeps['botRepo'],
    redis: stubs.redis as unknown as DriveTargetDeps['redis'],
    botLimit: stubs.botLimit as unknown as BotLimitSeam,
    ownerId: OWNER_ID,
    actorId: ACTOR_ID,
    ownerMode: 'paper',
    venue: 'hyperliquid',
    venueType: 'orderbook',
    venueAccountId: 'va-1',
    ...overrides,
  };

  return { deps, stubs };
}

// ── MANAGE_BOT: create_and_start ─────────────────────────────────────────────

describe('drive target — MANAGE_BOT create_and_start', () => {
  it('validates config, calls the create-limit seam, then enqueues a start job', async () => {
    const { deps, stubs } = makeDeps();
    const publishToInbound = createDriveTarget(deps);

    await publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, {
      action: 'create_and_start',
      config: validBotConfig(),
    });

    // The atomic create+limit seam (item E) was called with the injected owner /
    // venue-account values and the agent creator scope.
    expect(stubs.botLimit.tryCreateBotWithLimit).toHaveBeenCalledTimes(1);
    const createSpec = stubs.botLimit.tryCreateBotWithLimit.mock.calls[0][0];
    expect(createSpec.ownerId).toBe(OWNER_ID);
    expect(createSpec.venueAccountId).toBe('va-1');
    expect(createSpec.creatorType).toBe('agent');
    expect(createSpec.creatorId).toBe(ACTOR_ID);
    // Venue/venueType are stamped from the INJECTED values (agent-provided discarded).
    expect(createSpec.config.venue).toBe('hyperliquid');
    expect(createSpec.config.venueType).toBe('orderbook');

    // Then a start lifecycle job for the newly created bot.
    expect(stubs.enqueueLifecycle).toHaveBeenCalledTimes(1);
    expect(stubs.enqueueLifecycle.mock.calls[0][0]).toBe('start');
    expect(stubs.enqueueLifecycle.mock.calls[0][1]).toBe('bot-new');
  });

  it('rejects an invalid config before touching the create seam or the runtime', async () => {
    const { deps, stubs } = makeDeps();
    const publishToInbound = createDriveTarget(deps);

    await expect(
      publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, {
        action: 'create_and_start',
        config: { symbol: 'BTC' }, // missing strategy
      }),
    ).rejects.toThrow(/Bot config is invalid/);

    expect(stubs.botLimit.tryCreateBotWithLimit).not.toHaveBeenCalled();
    expect(stubs.enqueueLifecycle).not.toHaveBeenCalled();
  });

  it('rejects mode escalation (paper owner creating a live bot) before persisting', async () => {
    const { deps, stubs } = makeDeps({ ownerMode: 'paper' });
    const publishToInbound = createDriveTarget(deps);

    await expect(
      publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, {
        action: 'create_and_start',
        config: validBotConfig({ execution: { mode: 'live' } }),
      }),
    ).rejects.toThrow(/execution mode "live"/);

    expect(stubs.botLimit.tryCreateBotWithLimit).not.toHaveBeenCalled();
    expect(stubs.enqueueLifecycle).not.toHaveBeenCalled();
  });

  it('refuses (no persist) when the item-E limit seam is absent', async () => {
    const { deps, stubs } = makeDeps({ botLimit: undefined });
    const publishToInbound = createDriveTarget(deps);

    await expect(
      publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, {
        action: 'create_and_start',
        config: validBotConfig(),
      }),
    ).rejects.toThrow(/bot_limit_unavailable/);

    expect(stubs.enqueueLifecycle).not.toHaveBeenCalled();
  });

  it('rejects when the create-limit seam reports the limit reached', async () => {
    const { deps, stubs } = makeDeps();
    stubs.botLimit.tryCreateBotWithLimit.mockResolvedValueOnce({ created: false });
    const publishToInbound = createDriveTarget(deps);

    await expect(
      publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, {
        action: 'create_and_start',
        config: validBotConfig(),
      }),
    ).rejects.toThrow(/max concurrent bots/);

    expect(stubs.enqueueLifecycle).not.toHaveBeenCalled();
  });

  // Swap-venue symbol-format guard — copied KEEP behaviour (herobids
  // agent-message-broker.ts:693–714). Gated on the INJECTED venueType === 'swap';
  // rejects at CREATION time before the item-E create-limit seam is touched.
  describe('swap-venue symbol guard', () => {
    // A valid swap config: swapAssets is required and paper mode is forbidden for
    // swap venues (BotConfigSchema refinements), so use shadow mode.
    function validSwapConfig(symbol: string): Record<string, unknown> {
      return validBotConfig({
        symbol,
        execution: { mode: 'shadow' },
        swapAssets: { baseAsset: 'ETH', quoteAsset: 'USDC', baseDecimals: 18, quoteDecimals: 6 },
      });
    }

    it('rejects a raw 0x address symbol before the create-limit seam', async () => {
      const { deps, stubs } = makeDeps({ venue: 'jupiter', venueType: 'swap', ownerMode: 'shadow' });
      const publishToInbound = createDriveTarget(deps);

      await expect(
        publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, {
          action: 'create_and_start',
          config: validSwapConfig('0x1234567890abcdef/USDC'),
        }),
      ).rejects.toThrow(/looks like a raw token address/);

      expect(stubs.botLimit.tryCreateBotWithLimit).not.toHaveBeenCalled();
      expect(stubs.enqueueLifecycle).not.toHaveBeenCalled();
    });

    it('rejects a non-BASE/QUOTE symbol before the create-limit seam', async () => {
      const { deps, stubs } = makeDeps({ venue: 'jupiter', venueType: 'swap', ownerMode: 'shadow' });
      const publishToInbound = createDriveTarget(deps);

      await expect(
        publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, {
          action: 'create_and_start',
          config: validSwapConfig('ETHUSDC'),
        }),
      ).rejects.toThrow(/Invalid symbol format/);

      expect(stubs.botLimit.tryCreateBotWithLimit).not.toHaveBeenCalled();
      expect(stubs.enqueueLifecycle).not.toHaveBeenCalled();
    });

    it('rejects a base58-address side before the create-limit seam', async () => {
      const { deps, stubs } = makeDeps({ venue: 'jupiter', venueType: 'swap', ownerMode: 'shadow' });
      const publishToInbound = createDriveTarget(deps);

      await expect(
        publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, {
          action: 'create_and_start',
          // 44-char base58 mint address on the base side.
          config: validSwapConfig('So11111111111111111111111111111111111111112/USDC'),
        }),
      ).rejects.toThrow(/looks like a raw token address/);

      expect(stubs.botLimit.tryCreateBotWithLimit).not.toHaveBeenCalled();
      expect(stubs.enqueueLifecycle).not.toHaveBeenCalled();
    });

    it('passes a valid BASE/QUOTE swap symbol through the guard to the create seam', async () => {
      const { deps, stubs } = makeDeps({ venue: 'jupiter', venueType: 'swap', ownerMode: 'shadow' });
      const publishToInbound = createDriveTarget(deps);

      await publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, {
        action: 'create_and_start',
        config: validSwapConfig('ETH/USDC'),
      });

      expect(stubs.botLimit.tryCreateBotWithLimit).toHaveBeenCalledTimes(1);
      expect(stubs.enqueueLifecycle).toHaveBeenCalledTimes(1);
      expect(stubs.enqueueLifecycle.mock.calls[0][0]).toBe('start');
    });

    it('does not apply the swap guard for orderbook venues', async () => {
      // An orderbook venue with a bare (non-BASE/QUOTE) symbol is fine — the guard
      // is gated on venueType === 'swap'.
      const { deps, stubs } = makeDeps();
      const publishToInbound = createDriveTarget(deps);

      await publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, {
        action: 'create_and_start',
        config: validBotConfig({ symbol: 'BTC' }),
      });

      expect(stubs.botLimit.tryCreateBotWithLimit).toHaveBeenCalledTimes(1);
      expect(stubs.enqueueLifecycle).toHaveBeenCalledTimes(1);
    });
  });
});

// ── MANAGE_BOT: start / stop — ownership + enqueue ───────────────────────────

describe('drive target — MANAGE_BOT start', () => {
  it('validates ownership + persisted config, claims a slot, then enqueues start (non-reclaim)', async () => {
    const { deps, stubs } = makeDeps();
    const publishToInbound = createDriveTarget(deps);

    await publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, { action: 'start', botId: 'bot-1' });

    expect(stubs.botLimit.tryMarkBotRunningWithLimit).toHaveBeenCalledTimes(1);
    expect(stubs.enqueueLifecycle).toHaveBeenCalledTimes(1);
    expect(stubs.enqueueLifecycle.mock.calls[0][0]).toBe('start');
    expect(stubs.enqueueLifecycle.mock.calls[0][1]).toBe('bot-1');
  });

  it('reclaim (already running) skips the limit seam and re-marks running before enqueue', async () => {
    const { deps, stubs } = makeDeps();
    stubs.botRepo.getBotById.mockResolvedValueOnce(makeBotRecord({ status: 'running' }));
    const publishToInbound = createDriveTarget(deps);

    await publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, { action: 'start', botId: 'bot-1' });

    expect(stubs.botLimit.tryMarkBotRunningWithLimit).not.toHaveBeenCalled();
    expect(stubs.botRepo.markBotRunning).toHaveBeenCalledWith('bot-1');
    expect(stubs.enqueueLifecycle).toHaveBeenCalledTimes(1);
  });

  it('rejects a foreign-owner bot (ownership by injected ownerId)', async () => {
    const { deps, stubs } = makeDeps();
    stubs.botRepo.getBotById.mockResolvedValueOnce(makeBotRecord({ ownerId: 'other-owner' }));
    const publishToInbound = createDriveTarget(deps);

    await expect(
      publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, { action: 'start', botId: 'bot-1' }),
    ).rejects.toThrow(/not found or not owned/);

    expect(stubs.enqueueLifecycle).not.toHaveBeenCalled();
  });
});

describe('drive target — MANAGE_BOT stop', () => {
  it('validates ownership then enqueues a stop job', async () => {
    const { deps, stubs } = makeDeps();
    stubs.botRepo.getBotById.mockResolvedValueOnce(makeBotRecord({ status: 'running' }));
    const publishToInbound = createDriveTarget(deps);

    await publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, { action: 'stop', botId: 'bot-1' });

    expect(stubs.enqueueLifecycle).toHaveBeenCalledTimes(1);
    expect(stubs.enqueueLifecycle.mock.calls[0][0]).toBe('stop');
    expect(stubs.enqueueLifecycle.mock.calls[0][1]).toBe('bot-1');
    // stop enqueues only the command + botId (no config).
    expect(stubs.enqueueLifecycle.mock.calls[0][2]).toBeUndefined();
  });

  it('rejects a foreign-owner bot on stop', async () => {
    const { deps, stubs } = makeDeps();
    stubs.botRepo.getBotById.mockResolvedValueOnce(makeBotRecord({ ownerId: 'other-owner' }));
    const publishToInbound = createDriveTarget(deps);

    await expect(
      publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, { action: 'stop', botId: 'bot-1' }),
    ).rejects.toThrow(/not found or not owned/);
    expect(stubs.enqueueLifecycle).not.toHaveBeenCalled();
  });
});

describe('drive target — MANAGE_BOT adjust_config', () => {
  it('deep-merges the patch, persists, and restarts a running bot', async () => {
    const { deps, stubs } = makeDeps();
    stubs.botRepo.getBotById.mockResolvedValueOnce(makeBotRecord({ status: 'running' }));
    const publishToInbound = createDriveTarget(deps);

    await publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, {
      action: 'adjust_config',
      botId: 'bot-1',
      config: { risk: { maxOpenPositions: 3 } },
    });

    expect(stubs.botRepo.updateBotConfig).toHaveBeenCalledTimes(1);
    const [, mergedConfig] = stubs.botRepo.updateBotConfig.mock.calls[0];
    expect((mergedConfig.risk as Record<string, unknown>).maxOpenPositions).toBe(3);
    // Running bot → restart enqueued.
    expect(stubs.enqueueLifecycle).toHaveBeenCalledTimes(1);
    expect(stubs.enqueueLifecycle.mock.calls[0][0]).toBe('restart');
  });

  it('persists without a restart when the bot is not running', async () => {
    const { deps, stubs } = makeDeps();
    stubs.botRepo.getBotById.mockResolvedValueOnce(makeBotRecord({ status: 'stopped' }));
    const publishToInbound = createDriveTarget(deps);

    await publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, {
      action: 'adjust_config',
      botId: 'bot-1',
      config: { risk: { maxOpenPositions: 2 } },
    });

    expect(stubs.botRepo.updateBotConfig).toHaveBeenCalledTimes(1);
    expect(stubs.enqueueLifecycle).not.toHaveBeenCalled();
  });
});

// ── DECISION_SUBMIT: route + reply write ─────────────────────────────────────

describe('drive target — DECISION_SUBMIT', () => {
  it('routes to submitDecision and writes the reply the trading tool blpop reads back', async () => {
    const { deps, stubs } = makeDeps();
    stubs.submitDecision.mockResolvedValueOnce({ status: 'accepted', planId: 'plan-42', message: 'ok' });
    const publishToInbound = createDriveTarget(deps);

    const decisionId = 'dec-123';
    await publishToInbound(AGENT_MESSAGE_TYPES.DECISION_SUBMIT, {
      decisionId,
      instrumentId: 'BTC',
      intent: 'go_long',
      targetSize: '1.5',
      rationaleSummary: 'test',
      _expectsReply: true,
    });

    // Routed to item C with the injected actorId + adapted fields.
    expect(stubs.submitDecision).toHaveBeenCalledTimes(1);
    const input = stubs.submitDecision.mock.calls[0][0] as DecisionSubmitInput;
    expect(input.actorId).toBe(ACTOR_ID);
    expect(input.decisionId).toBe(decisionId);
    expect(input.instrumentId).toBe('BTC');
    expect(input.intent).toBe('go_long');
    expect(input.targetSize).toBe('1.5');
    expect(input.actorType).toBe('agent');

    // Reply written to the exact key the copied tool awaits, in the parsed shape.
    const replyKey = `agent:decision:reply:${decisionId}`;
    expect(stubs.redis.expire).toHaveBeenCalledWith(replyKey, 60);
    const readBack = stubs.redis.blpopSync(replyKey);
    expect(readBack).not.toBeNull();
    const parsed = JSON.parse(readBack![1]);
    expect(parsed).toMatchObject({ status: 'accepted', planId: 'plan-42', message: 'ok' });
  });

  it('does not write a reply when _expectsReply is not set', async () => {
    const { deps, stubs } = makeDeps();
    const publishToInbound = createDriveTarget(deps);

    await publishToInbound(AGENT_MESSAGE_TYPES.DECISION_SUBMIT, {
      decisionId: 'dec-x',
      instrumentId: 'BTC',
      intent: 'go_long',
      targetSize: '1',
    });

    expect(stubs.submitDecision).toHaveBeenCalledTimes(1);
    expect(stubs.redis.lpush).not.toHaveBeenCalled();
  });

  it('propagates a rejected result verbatim into the reply JSON', async () => {
    const { deps, stubs } = makeDeps();
    stubs.submitDecision.mockResolvedValueOnce({
      status: 'rejected',
      code: 'risk.exceeded',
      message: 'Daily loss limit reached',
      retryable: false,
    });
    const publishToInbound = createDriveTarget(deps);

    const decisionId = 'dec-rej';
    await publishToInbound(AGENT_MESSAGE_TYPES.DECISION_SUBMIT, {
      decisionId,
      instrumentId: 'BTC',
      intent: 'go_long',
      targetSize: '1',
      _expectsReply: true,
    });

    const readBack = stubs.redis.blpopSync(`agent:decision:reply:${decisionId}`);
    const parsed = JSON.parse(readBack![1]);
    expect(parsed).toMatchObject({ status: 'rejected', code: 'risk.exceeded', retryable: false });
  });
});

// ── BOT_QUERY: not routed (decision) ─────────────────────────────────────────

describe('drive target — no BOT_QUERY route', () => {
  it('ignores BOT_QUERY (neither copied tool emits it; the constant is vocabulary-only)', async () => {
    const { deps, stubs } = makeDeps();
    const publishToInbound = createDriveTarget(deps);

    await expect(
      publishToInbound(AGENT_MESSAGE_TYPES.BOT_QUERY, { some: 'payload' }),
    ).resolves.toBeUndefined();

    expect(stubs.submitDecision).not.toHaveBeenCalled();
    expect(stubs.enqueueLifecycle).not.toHaveBeenCalled();
  });
});
