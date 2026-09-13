import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '@traderton/domain';
import { botManagementTools } from './bots.js';

const adjustBotConfigTool = botManagementTools.find((t) => t.name === 'adjust_bot_config')!;
const listOwnerBotsTool = botManagementTools.find((t) => t.name === 'list_owner_bots')!;
const getOwnerBotStatusTool = botManagementTools.find((t) => t.name === 'get_owner_bot_status')!;

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'scout',
    executionMode: 'paper',
    redis: {
      hset: vi.fn(async () => 1),
      hget: vi.fn(async () => null),
      hgetall: vi.fn(async () => null),
      hdel: vi.fn(async () => 0),
      publish: vi.fn(async () => 0),
    },
    publishToInbound: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeBotRecord(overrides: Partial<{
  id: string;
  status: string;
  config: Record<string, unknown>;
  creatorType: string;
  creatorId: string;
  ownerId: string;
  startedAt: Date | null;
  stoppedAt: Date | null;
  createdAt: Date;
}> = {}) {
  return {
    id: 'bot-1',
    status: 'running',
    config: { execution: { mode: 'paper' }, symbol: 'SOL/USDC' },
    creatorType: 'agent',
    creatorId: 'agent-1',
    ownerId: 'owner-1',
    startedAt: null,
    stoppedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('adjust_bot_config — mode-rank enforcement', () => {
  // ── Mode escalation rejections ─────────────────────────────────────────

  it('rejects paper agent adjusting bot to shadow mode', async () => {
    const ctx = makeCtx({
      executionMode: 'paper',
      botRepo: {
        getBotById: vi.fn(async () => makeBotRecord()),
        updateBotConfig: vi.fn(async () => undefined),
      } as unknown as ToolContext['botRepo'],
    });

    const result = await adjustBotConfigTool.execute(
      { botId: 'bot-1', config: { execution: { mode: 'shadow' } } },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('shadow');
    expect(result.error).toContain('paper');
  });

  it('rejects paper agent adjusting bot to live mode', async () => {
    const ctx = makeCtx({
      executionMode: 'paper',
      botRepo: {
        getBotById: vi.fn(async () => makeBotRecord()),
        updateBotConfig: vi.fn(async () => undefined),
      } as unknown as ToolContext['botRepo'],
    });

    const result = await adjustBotConfigTool.execute(
      { botId: 'bot-1', config: { execution: { mode: 'live' } } },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('live');
    expect(result.error).toContain('paper');
  });

  it('rejects shadow agent adjusting bot to live mode', async () => {
    const ctx = makeCtx({
      executionMode: 'shadow',
      botRepo: {
        getBotById: vi.fn(async () => makeBotRecord()),
        updateBotConfig: vi.fn(async () => undefined),
      } as unknown as ToolContext['botRepo'],
    });

    const result = await adjustBotConfigTool.execute(
      { botId: 'bot-1', config: { execution: { mode: 'live' } } },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('live');
    expect(result.error).toContain('paper');
    expect(result.error).toContain('shadow');
  });

  // ── Allowed adjustments ────────────────────────────────────────────────

  it('allows paper agent adjusting bot to paper mode', async () => {
    const updateBotConfig = vi.fn(async () => undefined);
    const ctx = makeCtx({
      executionMode: 'paper',
      botRepo: {
        getBotById: vi.fn(async () => makeBotRecord()),
        updateBotConfig,
      } as unknown as ToolContext['botRepo'],
    });

    const result = await adjustBotConfigTool.execute(
      { botId: 'bot-1', config: { execution: { mode: 'paper' } } },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(updateBotConfig).toHaveBeenCalledTimes(1);
  });

  it('allows shadow agent adjusting bot to shadow mode', async () => {
    const updateBotConfig = vi.fn(async () => undefined);
    const ctx = makeCtx({
      executionMode: 'shadow',
      botRepo: {
        getBotById: vi.fn(async () => makeBotRecord({ config: { execution: { mode: 'shadow' }, symbol: 'SOL/USDC' } })),
        updateBotConfig,
      } as unknown as ToolContext['botRepo'],
    });

    const result = await adjustBotConfigTool.execute(
      { botId: 'bot-1', config: { execution: { mode: 'shadow' } } },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(updateBotConfig).toHaveBeenCalledTimes(1);
  });

  it('allows shadow agent to downgrade bot to paper mode', async () => {
    const updateBotConfig = vi.fn(async () => undefined);
    const ctx = makeCtx({
      executionMode: 'shadow',
      botRepo: {
        getBotById: vi.fn(async () => makeBotRecord()),
        updateBotConfig,
      } as unknown as ToolContext['botRepo'],
    });

    const result = await adjustBotConfigTool.execute(
      { botId: 'bot-1', config: { execution: { mode: 'paper' } } },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(updateBotConfig).toHaveBeenCalledTimes(1);
  });

  it('allows live agent adjusting bot to any mode', async () => {
    const updateBotConfig = vi.fn(async () => undefined);
    const ctx = makeCtx({
      executionMode: 'live',
      botRepo: {
        getBotById: vi.fn(async () => makeBotRecord()),
        updateBotConfig,
      } as unknown as ToolContext['botRepo'],
    });

    const result = await adjustBotConfigTool.execute(
      { botId: 'bot-1', config: { execution: { mode: 'live' } } },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(updateBotConfig).toHaveBeenCalledTimes(1);
  });

  // ── No execution.mode in adjustment ─────────────────────────────────────

  it('no-op when execution.mode is absent from the adjustment', async () => {
    const updateBotConfig = vi.fn(async () => undefined);
    const ctx = makeCtx({
      executionMode: 'paper',
      botRepo: {
        getBotById: vi.fn(async () => makeBotRecord()),
        updateBotConfig,
      } as unknown as ToolContext['botRepo'],
    });

    const result = await adjustBotConfigTool.execute(
      { botId: 'bot-1', config: { symbol: 'BTC/USDC' } },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(updateBotConfig).toHaveBeenCalledTimes(1);
  });

  // ── Ownership check (existing behaviour, unchanged) ────────────────────

  it('rejects when bot is not owned by the agent', async () => {
    const ctx = makeCtx({
      executionMode: 'paper',
      botRepo: {
        getBotById: vi.fn(async () => makeBotRecord({ creatorId: 'other-agent' })),
        updateBotConfig: vi.fn(async () => undefined),
      } as unknown as ToolContext['botRepo'],
    });

    const result = await adjustBotConfigTool.execute(
      { botId: 'bot-1', config: { execution: { mode: 'paper' } } },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not owned');
  });
});

// ── Owner-scoped reads (list_owner_bots / get_owner_bot_status) ─────────────
//
// These scope on ctx.ownerId (the tenancy boundary), NOT ('agent', ctx.agentId).
// They return the SAME payload shapes as list_bots / get_bot_status.

describe('list_owner_bots — owner-scoped list', () => {
  it('scopes on ctx.ownerId and returns the list_bots parity payload', async () => {
    const getBotsByOwner = vi.fn(async () => [
      makeBotRecord({ id: 'bot-a', ownerId: 'owner-1', creatorType: 'agent' }),
      // A bot created by a different actor type still belongs to the owner —
      // owner-scoping does NOT filter by creatorType.
      makeBotRecord({ id: 'bot-b', ownerId: 'owner-1', creatorType: 'user', config: { symbol: 'BTC/USDC' } }),
    ]);
    const ctx = makeCtx({
      ownerId: 'owner-1',
      botRepo: {
        getBotsByOwner,
        getBotsByCreator: vi.fn(),
      } as unknown as ToolContext['botRepo'],
    });

    const result = await listOwnerBotsTool.execute({}, ctx);

    expect(result.success).toBe(true);
    expect(getBotsByOwner).toHaveBeenCalledWith('owner-1', undefined);
    const data = result.data as { ok: boolean; bots: Array<Record<string, unknown>> };
    expect(data.ok).toBe(true);
    expect(data.bots).toHaveLength(2);
    // Parity shape: id, status, strategyPreset, symbol, createdAt — nothing else.
    expect(Object.keys(data.bots[0]).sort()).toEqual(
      ['createdAt', 'id', 'status', 'strategyPreset', 'symbol'].sort(),
    );
    expect(data.bots[0].id).toBe('bot-a');
    expect(data.bots[1].id).toBe('bot-b');
    expect(data.bots[1].symbol).toBe('BTC/USDC');
  });

  it('passes a since date derived from days', async () => {
    const getBotsByOwner = vi.fn(async () => []);
    const ctx = makeCtx({
      ownerId: 'owner-1',
      botRepo: { getBotsByOwner } as unknown as ToolContext['botRepo'],
    });

    await listOwnerBotsTool.execute({ days: 7 }, ctx);

    expect(getBotsByOwner).toHaveBeenCalledTimes(1);
    const [ownerArg, sinceArg] = getBotsByOwner.mock.calls[0];
    expect(ownerArg).toBe('owner-1');
    expect(sinceArg).toBeInstanceOf(Date);
  });

  it('fails when the owner scope is unavailable', async () => {
    const ctx = makeCtx({
      botRepo: { getBotsByOwner: vi.fn() } as unknown as ToolContext['botRepo'],
    });

    const result = await listOwnerBotsTool.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('owner scope');
  });

  it('fails when direct db access is unavailable', async () => {
    // ownerId is set so this isolates the botRepo guard (not the ownerId guard).
    const ctx = makeCtx({ ownerId: 'owner-1' });

    const result = await listOwnerBotsTool.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('direct db access');
  });
});

describe('get_owner_bot_status — owner-scoped status', () => {
  it('resolves via getBotByIdForOwner and returns the get_bot_status parity payload', async () => {
    const getBotByIdForOwner = vi.fn(async () => makeBotRecord({ id: 'bot-1', ownerId: 'owner-1' }));
    const ctx = makeCtx({
      ownerId: 'owner-1',
      botRepo: { getBotByIdForOwner } as unknown as ToolContext['botRepo'],
    });

    const result = await getOwnerBotStatusTool.execute({ botId: 'bot-1' }, ctx);

    expect(result.success).toBe(true);
    expect(getBotByIdForOwner).toHaveBeenCalledWith('bot-1', 'owner-1');
    const data = result.data as Record<string, unknown>;
    // Parity shape: ok, id, status, strategyPreset, symbol, config, startedAt, stoppedAt.
    expect(Object.keys(data).sort()).toEqual(
      ['config', 'id', 'ok', 'startedAt', 'status', 'stoppedAt', 'strategyPreset', 'symbol'].sort(),
    );
    expect(data.id).toBe('bot-1');
  });

  it('rejects when the bot does not belong to the owner (repo returns null)', async () => {
    const getBotByIdForOwner = vi.fn(async () => null);
    const ctx = makeCtx({
      ownerId: 'owner-1',
      botRepo: { getBotByIdForOwner } as unknown as ToolContext['botRepo'],
    });

    const result = await getOwnerBotStatusTool.execute({ botId: 'bot-x' }, ctx);

    expect(result.success).toBe(false);
    expect(getBotByIdForOwner).toHaveBeenCalledWith('bot-x', 'owner-1');
    expect(result.error).toContain('not found or not owned');
  });

  it('fails when the owner scope is unavailable', async () => {
    const ctx = makeCtx({
      botRepo: { getBotByIdForOwner: vi.fn() } as unknown as ToolContext['botRepo'],
    });

    const result = await getOwnerBotStatusTool.execute({ botId: 'bot-1' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('owner scope');
  });

  it('fails when direct db access is unavailable', async () => {
    const ctx = makeCtx({ ownerId: 'owner-1' });

    const result = await getOwnerBotStatusTool.execute({ botId: 'bot-1' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('direct db access');
  });
});
