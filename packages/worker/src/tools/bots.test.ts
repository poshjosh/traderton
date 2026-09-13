import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '@traderton/domain';
import { AGENT_MESSAGE_TYPES } from '@traderton/domain';
import { botManagementTools } from './bots.js';

const createBotTool = botManagementTools.find((t) => t.name === 'create_bot')!;
const adjustBotConfigTool = botManagementTools.find((t) => t.name === 'adjust_bot_config')!;
const listOwnerBotsTool = botManagementTools.find((t) => t.name === 'list_owner_bots')!;
const getOwnerBotStatusTool = botManagementTools.find((t) => t.name === 'get_owner_bot_status')!;
const deleteBotTool = botManagementTools.find((t) => t.name === 'delete_bot')!;

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

// ── create_bot — synchronous botId + capability rejection (A1 / B1) ─────────

describe('create_bot — returns the synchronous botId (A1)', () => {
  const validConfig = {
    symbol: 'BTC-USDC',
    strategy: { type: 'momentum', decisionMode: 'mechanical' },
    execution: { mode: 'paper' },
  };

  it('surfaces data.botId from the publishToInbound create result', async () => {
    const publishToInbound = vi.fn(async () => ({ botId: 'bot-created-1' }));
    const ctx = makeCtx({ publishToInbound });

    const result = await createBotTool.execute({ config: validConfig }, ctx);

    expect(result.success).toBe(true);
    expect(publishToInbound).toHaveBeenCalledTimes(1);
    const [type, payload] = publishToInbound.mock.calls[0];
    expect(type).toBe(AGENT_MESSAGE_TYPES.MANAGE_BOT);
    expect((payload as Record<string, unknown>).action).toBe('create_and_start');
    const data = result.data as { ok: boolean; botId?: string; note: string };
    expect(data.ok).toBe(true);
    expect(data.botId).toBe('bot-created-1');
    // The corrected note reflects that the row + id are synchronous — only the
    // actor start is deferred. It must NOT repeat the old misleading claim that
    // the bot only shows up (with no id) on the next tick.
    expect(data.note).not.toMatch(/see it in the bot list on the next tick/);
    expect(data.note).toMatch(/available now/i);
  });

  it('dryRun previews without creating (unchanged) — no publishToInbound', async () => {
    const publishToInbound = vi.fn(async () => ({ botId: 'should-not-happen' }));
    const ctx = makeCtx({ publishToInbound });

    const result = await createBotTool.execute({ config: validConfig, dryRun: true }, ctx);

    expect(result.success).toBe(true);
    expect(publishToInbound).not.toHaveBeenCalled();
    const data = result.data as { dryRun: boolean };
    expect(data.dryRun).toBe(true);
  });

  // B1: the drive path throws a dedicated `execution_capability.*` error for
  // paper+swap; create_bot surfaces it as a content-level failure (fault:false)
  // carrying the dedicated errorCode, so the boundary maps it to a 400
  // (validation.invalid_payload) with the paper_swap identity in details.errorCode.
  it('maps a paper+swap capability rejection to a fault:false failure with the dedicated code', async () => {
    const capError = new Error('Paper mode is not supported for swap venues — use shadow or live') as Error & { code?: string };
    capError.code = 'execution_capability.paper_swap_not_supported';
    const publishToInbound = vi.fn(async () => { throw capError; });
    const ctx = makeCtx({ publishToInbound });

    const result = await createBotTool.execute({ config: validConfig }, ctx);

    expect(result.success).toBe(false);
    expect(result.fault).toBe(false);
    expect(result.errorCode).toBe('execution_capability.paper_swap_not_supported');
    expect(result.error).toMatch(/paper mode is not supported for swap venues/i);
  });

  it('re-throws a non-capability error unchanged (→ boundary internal.non_retryable)', async () => {
    const publishToInbound = vi.fn(async () => { throw new Error('bot_limit_unavailable: not configured'); });
    const ctx = makeCtx({ publishToInbound });

    await expect(createBotTool.execute({ config: validConfig }, ctx)).rejects.toThrow(/bot_limit_unavailable/);
  });
});

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
    // Owner-scoped shape (C): the list_bots parity fields PLUS the additive
    // creatorType + creatorId (the intentional divergence from agent-scoped
    // list_bots — 004 ruling 4).
    expect(Object.keys(data.bots[0]).sort()).toEqual(
      ['createdAt', 'creatorId', 'creatorType', 'id', 'status', 'strategyPreset', 'symbol'].sort(),
    );
    expect(data.bots[0].id).toBe('bot-a');
    expect(data.bots[0].creatorType).toBe('agent');
    expect(data.bots[1].id).toBe('bot-b');
    expect(data.bots[1].symbol).toBe('BTC/USDC');
    // Owner-scoping does NOT filter by creatorType — a user-created bot surfaces
    // its own creatorType.
    expect(data.bots[1].creatorType).toBe('user');
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
    // Owner-scoped shape (C): the get_bot_status parity fields PLUS the additive
    // creatorType + creatorId (the intentional divergence from agent-scoped
    // get_bot_status — 004 ruling 4).
    expect(Object.keys(data).sort()).toEqual(
      ['config', 'creatorId', 'creatorType', 'id', 'ok', 'startedAt', 'status', 'stoppedAt', 'strategyPreset', 'symbol'].sort(),
    );
    expect(data.id).toBe('bot-1');
    expect(data.creatorType).toBe('agent');
    expect(data.creatorId).toBe('agent-1');
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

// ── delete_bot — owner-scoped terminal delete (Wave A1, S1/S2/S3) ───────────
//
// Mirrors the owner-tool + deprovision patterns: owner-scoped existence via
// getBotByIdForOwner (→ not_found.resource), STATUS guard refusing a running bot
// (→ bot.running, mapped to 409 at the boundary), hard delete via
// deleteBotByIdForOwner, metadata-only success, and the owner/db guards
// (fault:true).

describe('delete_bot — owner-scoped hard delete', () => {
  it('is registered write-database and ownerScopedNoVenue (side-effecting, no venue)', () => {
    expect(deleteBotTool).toBeDefined();
    expect(deleteBotTool.category).toBe('write-database');
    expect(deleteBotTool.ownerScopedNoVenue).toBe(true);
  });

  it('deletes a stopped owned bot and returns metadata-only success', async () => {
    const getBotByIdForOwner = vi.fn(async () => makeBotRecord({ id: 'bot-1', ownerId: 'owner-1', status: 'stopped' }));
    const deleteBotByIdForOwner = vi.fn(async () => true);
    const ctx = makeCtx({
      ownerId: 'owner-1',
      botRepo: { getBotByIdForOwner, deleteBotByIdForOwner } as unknown as ToolContext['botRepo'],
    });

    const result = await deleteBotTool.execute({ botId: 'bot-1' }, ctx);

    expect(result.success).toBe(true);
    expect(getBotByIdForOwner).toHaveBeenCalledWith('bot-1', 'owner-1');
    expect(deleteBotByIdForOwner).toHaveBeenCalledWith('bot-1', 'owner-1');
    expect(result.data).toEqual({ ok: true, botId: 'bot-1', deleted: true });
  });

  it('returns not_found.resource for an absent/unowned bot (never deletes)', async () => {
    const getBotByIdForOwner = vi.fn(async () => null);
    const deleteBotByIdForOwner = vi.fn(async () => false);
    const ctx = makeCtx({
      ownerId: 'owner-1',
      botRepo: { getBotByIdForOwner, deleteBotByIdForOwner } as unknown as ToolContext['botRepo'],
    });

    const result = await deleteBotTool.execute({ botId: 'bot-x' }, ctx);

    expect(result.success).toBe(false);
    expect(result.fault).toBe(false);
    expect(result.errorCode).toBe('not_found.resource');
    expect(result.error).toContain('not found or not owned');
    expect(deleteBotByIdForOwner).not.toHaveBeenCalled();
  });

  it('refuses to delete a running bot with the dedicated bot.running code (→ 409)', async () => {
    const getBotByIdForOwner = vi.fn(async () => makeBotRecord({ id: 'bot-1', ownerId: 'owner-1', status: 'running' }));
    const deleteBotByIdForOwner = vi.fn(async () => true);
    const ctx = makeCtx({
      ownerId: 'owner-1',
      botRepo: { getBotByIdForOwner, deleteBotByIdForOwner } as unknown as ToolContext['botRepo'],
    });

    const result = await deleteBotTool.execute({ botId: 'bot-1' }, ctx);

    expect(result.success).toBe(false);
    expect(result.fault).toBe(false);
    expect(result.errorCode).toBe('bot.running');
    expect(result.error).toMatch(/stop it first/i);
    // A running bot is never deleted.
    expect(deleteBotByIdForOwner).not.toHaveBeenCalled();
  });

  it('fails closed (fault:true) when the owner scope is unavailable', async () => {
    const ctx = makeCtx({
      botRepo: { getBotByIdForOwner: vi.fn(), deleteBotByIdForOwner: vi.fn() } as unknown as ToolContext['botRepo'],
    });

    const result = await deleteBotTool.execute({ botId: 'bot-1' }, ctx);

    expect(result.success).toBe(false);
    expect(result.fault).toBe(true);
    expect(result.errorCode).toBe('bot.owner_unavailable');
  });

  it('fails closed (fault:true) when direct db access is unavailable', async () => {
    const ctx = makeCtx({ ownerId: 'owner-1' });

    const result = await deleteBotTool.execute({ botId: 'bot-1' }, ctx);

    expect(result.success).toBe(false);
    expect(result.fault).toBe(true);
    expect(result.errorCode).toBe('bot.db_unavailable');
  });
});
