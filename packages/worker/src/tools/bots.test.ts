import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ToolContext } from '@traderton/domain';
import { AGENT_MESSAGE_TYPES } from '@traderton/domain';
import { FillRepository, PositionRepository, PgJournal } from '@traderton/db';
import { botManagementTools } from './bots.js';

const createBotTool = botManagementTools.find((t) => t.name === 'create_bot')!;
const adjustBotConfigTool = botManagementTools.find((t) => t.name === 'adjust_bot_config')!;
const listOwnerBotsTool = botManagementTools.find((t) => t.name === 'list_owner_bots')!;
const getOwnerBotStatusTool = botManagementTools.find((t) => t.name === 'get_owner_bot_status')!;
const getOwnerBotCostsTool = botManagementTools.find((t) => t.name === 'get_owner_bot_costs')!;
const getOwnerBotSessionsTool = botManagementTools.find((t) => t.name === 'get_owner_bot_sessions')!;
const getOwnerBotJournalSummaryTool = botManagementTools.find((t) => t.name === 'get_owner_bot_journal_summary')!;
const getOwnerBotJournalTool = botManagementTools.find((t) => t.name === 'get_owner_bot_journal')!;
const deleteBotTool = botManagementTools.find((t) => t.name === 'delete_bot')!;
const getAgentFillsTool = botManagementTools.find((t) => t.name === 'get_agent_fills')!;
const getAgentJournalEventsTool = botManagementTools.find((t) => t.name === 'get_agent_journal_events')!;
const getAgentPositionsTool = botManagementTools.find((t) => t.name === 'get_agent_positions')!;

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

// ── Owner-scoped bot read-wave (Wave A2) ────────────────────────────────────
//
// The 4 read tools UN-QUARANTINE + adapt the herobids aggregation into
// owner-scoped tools. These mirror the owner-tool test pattern: owner-scoped
// not-found via getBotByIdForOwner, payload shape, and (for the journal tool)
// that type/limit/offset pass through. The aggregation tools drive a stubbed
// Drizzle `ctx.db` returning fixture fills/events and assert the grouped/paired
// output.

/**
 * Build a stub Drizzle `db` whose `select().from()...<terminal>` chain resolves
 * to each queued result in call order (one result per `select()` call). Every
 * chain method returns a thenable so any terminal (`where`, `groupBy`, `limit`,
 * `offset`, `orderBy`) resolves to that select's result — matching the copied
 * aggregation queries and PgJournal's internal query chain.
 */
function makeReadDb(results: unknown[]): ToolContext['db'] {
  let call = 0;
  const makeChain = (result: unknown) => {
    const chain: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };
    for (const method of ['from', 'where', 'groupBy', 'orderBy', 'limit', 'offset', 'innerJoin', 'leftJoin']) {
      chain[method] = () => chain;
    }
    return chain;
  };
  return {
    select: vi.fn(() => makeChain(results[call++] ?? [])),
  } as unknown as ToolContext['db'];
}

describe('get_owner_bot_costs — owner-scoped fee grouping', () => {
  it('groups fills.fee by feeCurrency for the owned bot', async () => {
    const getBotByIdForOwner = vi.fn(async () => makeBotRecord({ id: 'bot-1', ownerId: 'owner-1' }));
    const ctx = makeCtx({
      ownerId: 'owner-1',
      botRepo: { getBotByIdForOwner } as unknown as ToolContext['botRepo'],
      db: makeReadDb([[
        { feeCurrency: 'USDC', total: '1.50' },
        { feeCurrency: 'SOL', total: '0.02' },
      ]]),
    });

    const result = await getOwnerBotCostsTool.execute({ botId: 'bot-1' }, ctx);

    expect(result.success).toBe(true);
    expect(getBotByIdForOwner).toHaveBeenCalledWith('bot-1', 'owner-1');
    expect(result.data).toEqual({
      ok: true,
      botId: 'bot-1',
      feesByCurrency: { USDC: '1.50', SOL: '0.02' },
    });
  });

  it('maps a null feeCurrency to "unknown" and a null total to "0"', async () => {
    const ctx = makeCtx({
      ownerId: 'owner-1',
      botRepo: { getBotByIdForOwner: vi.fn(async () => makeBotRecord({ ownerId: 'owner-1' })) } as unknown as ToolContext['botRepo'],
      db: makeReadDb([[{ feeCurrency: null, total: null }]]),
    });

    const result = await getOwnerBotCostsTool.execute({ botId: 'bot-1' }, ctx);

    expect(result.success).toBe(true);
    expect((result.data as { feesByCurrency: Record<string, string> }).feesByCurrency).toEqual({ unknown: '0' });
  });

  it('returns not_found.resource for an absent/unowned bot (never queries fills)', async () => {
    const getBotByIdForOwner = vi.fn(async () => null);
    const selectSpy = vi.fn();
    const ctx = makeCtx({
      ownerId: 'owner-1',
      botRepo: { getBotByIdForOwner } as unknown as ToolContext['botRepo'],
      db: { select: selectSpy } as unknown as ToolContext['db'],
    });

    const result = await getOwnerBotCostsTool.execute({ botId: 'bot-x' }, ctx);

    expect(result.success).toBe(false);
    expect(result.fault).toBe(false);
    expect(result.errorCode).toBe('not_found.resource');
    expect(result.error).toContain('not found or not owned');
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it('fails when the owner scope is unavailable', async () => {
    const ctx = makeCtx({
      botRepo: { getBotByIdForOwner: vi.fn() } as unknown as ToolContext['botRepo'],
      db: makeReadDb([[]]),
    });

    const result = await getOwnerBotCostsTool.execute({ botId: 'bot-1' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('owner scope');
  });

  it('fails when direct db access is unavailable', async () => {
    const ctx = makeCtx({ ownerId: 'owner-1' });

    const result = await getOwnerBotCostsTool.execute({ botId: 'bot-1' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('direct db access');
  });
});

describe('get_owner_bot_sessions — owner-scoped session pairing', () => {
  it('pairs instance.started / instance.stopped events into sessions (newest first)', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t1 = new Date('2026-01-01T01:00:00Z'); // +1h
    const t2 = new Date('2026-01-01T02:00:00Z');
    const ctx = makeCtx({
      ownerId: 'owner-1',
      botRepo: { getBotByIdForOwner: vi.fn(async () => makeBotRecord({ ownerId: 'owner-1' })) } as unknown as ToolContext['botRepo'],
      // Ascending order: a closed session (t0→t1) then a still-running one (t2).
      db: makeReadDb([[
        { id: 'ev-1', type: 'instance.started', createdAt: t0 },
        { id: 'ev-2', type: 'instance.stopped', createdAt: t1 },
        { id: 'ev-3', type: 'instance.started', createdAt: t2 },
      ]]),
    });

    const result = await getOwnerBotSessionsTool.execute({ botId: 'bot-1' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as { ok: boolean; botId: string; sessions: Array<Record<string, unknown>>; limit: number; offset: number };
    expect(data.ok).toBe(true);
    expect(data.limit).toBe(20);
    expect(data.offset).toBe(0);
    expect(data.sessions).toHaveLength(2);
    // Newest first: the currently-running session (started t2, no end).
    expect(data.sessions[0]).toEqual({
      startedAt: t2,
      endedAt: null,
      durationMs: null,
      startEventId: 'ev-3',
      endEventId: null,
    });
    // The closed session, with a computed duration of 1h.
    expect(data.sessions[1]).toEqual({
      startedAt: t0,
      endedAt: t1,
      durationMs: 60 * 60 * 1000,
      startEventId: 'ev-1',
      endEventId: 'ev-2',
    });
  });

  it('clamps limit to 100 and passes offset through', async () => {
    const ctx = makeCtx({
      ownerId: 'owner-1',
      botRepo: { getBotByIdForOwner: vi.fn(async () => makeBotRecord({ ownerId: 'owner-1' })) } as unknown as ToolContext['botRepo'],
      db: makeReadDb([[]]),
    });

    const result = await getOwnerBotSessionsTool.execute({ botId: 'bot-1', limit: 500, offset: 5 }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as { limit: number; offset: number };
    expect(data.limit).toBe(100);
    expect(data.offset).toBe(5);
  });

  it('returns not_found.resource for an absent/unowned bot', async () => {
    const ctx = makeCtx({
      ownerId: 'owner-1',
      botRepo: { getBotByIdForOwner: vi.fn(async () => null) } as unknown as ToolContext['botRepo'],
      db: makeReadDb([[]]),
    });

    const result = await getOwnerBotSessionsTool.execute({ botId: 'bot-x' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('not_found.resource');
  });
});

describe('get_owner_bot_journal_summary — owner-scoped trade summary', () => {
  it('returns the trade count and fees grouped by currency', async () => {
    const ctx = makeCtx({
      ownerId: 'owner-1',
      botRepo: { getBotByIdForOwner: vi.fn(async () => makeBotRecord({ ownerId: 'owner-1' })) } as unknown as ToolContext['botRepo'],
      // First select() → count row; second select() → fee-group rows.
      db: makeReadDb([
        [{ tradeCount: 7 }],
        [{ feeCurrency: 'USDC', total: '3.25' }],
      ]),
    });

    const result = await getOwnerBotJournalSummaryTool.execute({ botId: 'bot-1' }, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      ok: true,
      botId: 'bot-1',
      tradeCount: 7,
      feesByCurrency: { USDC: '3.25' },
    });
  });

  it('defaults tradeCount to 0 when the count row is absent', async () => {
    const ctx = makeCtx({
      ownerId: 'owner-1',
      botRepo: { getBotByIdForOwner: vi.fn(async () => makeBotRecord({ ownerId: 'owner-1' })) } as unknown as ToolContext['botRepo'],
      db: makeReadDb([[], []]),
    });

    const result = await getOwnerBotJournalSummaryTool.execute({ botId: 'bot-1' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as { tradeCount: number; feesByCurrency: Record<string, string> };
    expect(data.tradeCount).toBe(0);
    expect(data.feesByCurrency).toEqual({});
  });

  it('returns not_found.resource for an absent/unowned bot', async () => {
    const ctx = makeCtx({
      ownerId: 'owner-1',
      botRepo: { getBotByIdForOwner: vi.fn(async () => null) } as unknown as ToolContext['botRepo'],
      db: makeReadDb([[], []]),
    });

    const result = await getOwnerBotJournalSummaryTool.execute({ botId: 'bot-x' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('not_found.resource');
  });
});

describe('get_owner_bot_journal — owner-scoped journal query (serves /events + /journal)', () => {
  it('passes actorId + type/limit/offset through to the journal query', async () => {
    const events = [{ id: 'ev-1', type: 'decision.made', actorId: 'bot-1', createdAt: new Date() }];
    // Capture the args the PgJournal chain is invoked with. PgJournal builds
    // select().from().where().orderBy().limit(N).offset(M); we assert on the
    // clamped/threaded limit + offset via the terminal calls.
    const limitSpy = vi.fn();
    const offsetSpy = vi.fn();
    const chain: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(events).then(resolve),
    };
    chain.from = () => chain;
    chain.where = () => chain;
    chain.orderBy = () => chain;
    chain.limit = (n: number) => { limitSpy(n); return chain; };
    chain.offset = (n: number) => { offsetSpy(n); return chain; };
    const db = { select: vi.fn(() => chain) } as unknown as ToolContext['db'];

    const ctx = makeCtx({
      ownerId: 'owner-1',
      botRepo: { getBotByIdForOwner: vi.fn(async () => makeBotRecord({ id: 'bot-1', ownerId: 'owner-1' })) } as unknown as ToolContext['botRepo'],
      db,
    });

    const result = await getOwnerBotJournalTool.execute({ botId: 'bot-1', type: 'decision.made', limit: 25, offset: 10 }, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ ok: true, events });
    // PgJournal.query threads limit/offset straight to the query.
    expect(limitSpy).toHaveBeenCalledWith(25);
    expect(offsetSpy).toHaveBeenCalledWith(10);
  });

  it('works with only a limit (the /events call shape)', async () => {
    const events: unknown[] = [];
    const chain: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(events).then(resolve),
    };
    for (const m of ['from', 'where', 'orderBy', 'limit', 'offset']) chain[m] = () => chain;
    const db = { select: vi.fn(() => chain) } as unknown as ToolContext['db'];

    const ctx = makeCtx({
      ownerId: 'owner-1',
      botRepo: { getBotByIdForOwner: vi.fn(async () => makeBotRecord({ id: 'bot-1', ownerId: 'owner-1' })) } as unknown as ToolContext['botRepo'],
      db,
    });

    const result = await getOwnerBotJournalTool.execute({ botId: 'bot-1', limit: 50 }, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ ok: true, events: [] });
  });

  it('returns not_found.resource for an absent/unowned bot (never queries the journal)', async () => {
    const selectSpy = vi.fn();
    const ctx = makeCtx({
      ownerId: 'owner-1',
      botRepo: { getBotByIdForOwner: vi.fn(async () => null) } as unknown as ToolContext['botRepo'],
      db: { select: selectSpy } as unknown as ToolContext['db'],
    });

    const result = await getOwnerBotJournalTool.execute({ botId: 'bot-x' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('not_found.resource');
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it('fails when the owner scope is unavailable', async () => {
    const ctx = makeCtx({
      botRepo: { getBotByIdForOwner: vi.fn() } as unknown as ToolContext['botRepo'],
      db: makeReadDb([[]]),
    });

    const result = await getOwnerBotJournalTool.execute({ botId: 'bot-1' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('owner scope');
  });
});

// ── Agent-scoped evidence reads (D1-c1 Sub-step 2) ──────────────────────────
//
// Unlike the get_owner_bot_* family, these are AGENT-scoped: no botId param, no
// ownerId/getBotByIdForOwner. They delegate to the Sub-step 1 loaders
// (FillRepository.loadAgentFills / PositionRepository.loadAgentPositions /
// PgJournal.loadAgentJournalEvents) over ctx.db, scoped by ctx.agentId. The
// tests spy on the loader prototype methods to assert (a) delegation with the
// agent id, (b) ISO date params are parsed to Date and threaded into opts, and
// use a stubbed ctx.db so the constructed repo/journal is real but never hits a
// DB. Guards mirror get_owner_bot_costs: !ctx.db and !ctx.agentId → fault:false.

// A stubbed Drizzle `db` sufficient to construct the repos/journal. The loader
// methods are spied at the prototype level, so this handle is never queried.
const stubDb = { select: vi.fn() } as unknown as ToolContext['db'];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('get_agent_fills — agent-scoped fills read', () => {
  it('is registered read-database', () => {
    expect(getAgentFillsTool).toBeDefined();
    expect(getAgentFillsTool.category).toBe('read-database');
  });

  it('delegates to FillRepository.loadAgentFills with ctx.agentId and returns { fills }', async () => {
    const fillRows = [{ id: 'f-1' }, { id: 'f-2' }];
    const spy = vi.spyOn(FillRepository.prototype, 'loadAgentFills').mockResolvedValue(fillRows as never);
    const ctx = makeCtx({ agentId: 'agent-1', db: stubDb });

    const result = await getAgentFillsTool.execute({}, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ ok: true, fills: fillRows });
    expect(spy).toHaveBeenCalledTimes(1);
    const [agentIdArg, optsArg] = spy.mock.calls[0];
    expect(agentIdArg).toBe('agent-1');
    // No from/to provided → both undefined.
    expect(optsArg).toEqual({ from: undefined, to: undefined });
    // Scope invariant: the tool must NEVER thread botIds (that would let a caller
    // widen scope beyond the context agent).
    expect(optsArg).not.toHaveProperty('botIds');
  });

  it('parses ISO from/to into Date and passes them to the loader', async () => {
    const spy = vi.spyOn(FillRepository.prototype, 'loadAgentFills').mockResolvedValue([] as never);
    const ctx = makeCtx({ agentId: 'agent-1', db: stubDb });

    await getAgentFillsTool.execute(
      { from: '2024-01-01T00:00:00.000Z', to: '2024-02-01T00:00:00.000Z' },
      ctx,
    );

    const [, optsArg] = spy.mock.calls[0];
    const opts = optsArg as { from?: Date; to?: Date };
    expect(opts.from).toBeInstanceOf(Date);
    expect(opts.to).toBeInstanceOf(Date);
    expect(opts.from?.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(opts.to?.toISOString()).toBe('2024-02-01T00:00:00.000Z');
  });

  it('fails fault:false when direct db access is unavailable', async () => {
    const ctx = makeCtx({ agentId: 'agent-1' });

    const result = await getAgentFillsTool.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.fault).toBe(false);
    expect(result.error).toContain('direct db access');
  });

  it('fails fault:false when the agent scope is unavailable', async () => {
    const ctx = makeCtx({ db: stubDb });
    // agentId is required by ToolContext; clear it to exercise the guard.
    (ctx as { agentId?: string }).agentId = undefined;

    const result = await getAgentFillsTool.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.fault).toBe(false);
    expect(result.error).toContain('agent scope');
  });
});

describe('get_agent_journal_events — agent-scoped journal read', () => {
  it('is registered read-database', () => {
    expect(getAgentJournalEventsTool).toBeDefined();
    expect(getAgentJournalEventsTool.category).toBe('read-database');
  });

  it('delegates to PgJournal.loadAgentJournalEvents with ctx.agentId and returns { events }', async () => {
    const eventRows = [{ id: 'ev-1' }];
    const spy = vi.spyOn(PgJournal.prototype, 'loadAgentJournalEvents').mockResolvedValue(eventRows as never);
    const ctx = makeCtx({ agentId: 'agent-1', db: stubDb });

    const result = await getAgentJournalEventsTool.execute({}, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ ok: true, events: eventRows });
    expect(spy).toHaveBeenCalledTimes(1);
    const [agentIdArg, optsArg] = spy.mock.calls[0];
    expect(agentIdArg).toBe('agent-1');
    expect(optsArg).toEqual({ from: undefined, to: undefined });
    expect(optsArg).not.toHaveProperty('botIds');
  });

  it('parses ISO from/to into Date and passes them to the loader', async () => {
    const spy = vi.spyOn(PgJournal.prototype, 'loadAgentJournalEvents').mockResolvedValue([] as never);
    const ctx = makeCtx({ agentId: 'agent-1', db: stubDb });

    await getAgentJournalEventsTool.execute(
      { from: '2024-03-01T00:00:00.000Z', to: '2024-04-01T00:00:00.000Z' },
      ctx,
    );

    const [, optsArg] = spy.mock.calls[0];
    const opts = optsArg as { from?: Date; to?: Date };
    expect(opts.from?.toISOString()).toBe('2024-03-01T00:00:00.000Z');
    expect(opts.to?.toISOString()).toBe('2024-04-01T00:00:00.000Z');
  });

  it('fails fault:false when direct db access is unavailable', async () => {
    const ctx = makeCtx({ agentId: 'agent-1' });

    const result = await getAgentJournalEventsTool.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.fault).toBe(false);
    expect(result.error).toContain('direct db access');
  });

  it('fails fault:false when the agent scope is unavailable', async () => {
    const ctx = makeCtx({ db: stubDb });
    (ctx as { agentId?: string }).agentId = undefined;

    const result = await getAgentJournalEventsTool.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.fault).toBe(false);
    expect(result.error).toContain('agent scope');
  });
});

describe('get_agent_positions — agent-scoped positions read', () => {
  it('is registered read-database', () => {
    expect(getAgentPositionsTool).toBeDefined();
    expect(getAgentPositionsTool.category).toBe('read-database');
  });

  it('delegates to PositionRepository.loadAgentPositions with ctx.agentId and returns { positions }', async () => {
    const positionRows = [{ id: 'p-1' }];
    const spy = vi.spyOn(PositionRepository.prototype, 'loadAgentPositions').mockResolvedValue(positionRows as never);
    const ctx = makeCtx({ agentId: 'agent-1', db: stubDb });

    const result = await getAgentPositionsTool.execute({}, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ ok: true, positions: positionRows });
    expect(spy).toHaveBeenCalledTimes(1);
    const [agentIdArg, optsArg] = spy.mock.calls[0];
    expect(agentIdArg).toBe('agent-1');
    expect(optsArg).toEqual({ from: undefined, to: undefined, at: undefined });
    expect(optsArg).not.toHaveProperty('botIds');
  });

  it('parses ISO from/to/at into Date and passes them to the loader', async () => {
    const spy = vi.spyOn(PositionRepository.prototype, 'loadAgentPositions').mockResolvedValue([] as never);
    const ctx = makeCtx({ agentId: 'agent-1', db: stubDb });

    await getAgentPositionsTool.execute(
      {
        from: '2024-05-01T00:00:00.000Z',
        to: '2024-06-01T00:00:00.000Z',
        at: '2024-05-15T00:00:00.000Z',
      },
      ctx,
    );

    const [, optsArg] = spy.mock.calls[0];
    const opts = optsArg as { from?: Date; to?: Date; at?: Date };
    expect(opts.from?.toISOString()).toBe('2024-05-01T00:00:00.000Z');
    expect(opts.to?.toISOString()).toBe('2024-06-01T00:00:00.000Z');
    expect(opts.at?.toISOString()).toBe('2024-05-15T00:00:00.000Z');
  });

  it('fails fault:false when direct db access is unavailable', async () => {
    const ctx = makeCtx({ agentId: 'agent-1' });

    const result = await getAgentPositionsTool.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.fault).toBe(false);
    expect(result.error).toContain('direct db access');
  });

  it('fails fault:false when the agent scope is unavailable', async () => {
    const ctx = makeCtx({ db: stubDb });
    (ctx as { agentId?: string }).agentId = undefined;

    const result = await getAgentPositionsTool.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.fault).toBe(false);
    expect(result.error).toContain('agent scope');
  });
});
