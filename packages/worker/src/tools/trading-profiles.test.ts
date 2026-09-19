import { describe, expect, it, vi } from 'vitest';

const { applyOperation } = vi.hoisted(() => ({ applyOperation: vi.fn() }));

vi.mock('@traderton/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@traderton/db')>();
  return {
    ...actual,
    AgentTradingProfileRepository: class {
      applyOperation = applyOperation;
    },
  };
});

import { tradingProfileTools } from './trading-profiles.js';

const setProfile = tradingProfileTools.find((tool) => tool.name === 'set_agent_trading_profile')!;

function context(ownerId = 'owner-1', agentId = 'agent-1') {
  return {
    ownerId,
    agentId,
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [{ id: 'venue-1' }] }),
        }),
      }),
    },
  } as never;
}

const params = {
  actorId: 'agent-1',
  venueAccountId: 'venue-1',
  operationId: 'operation-1',
  actionId: 'action-1',
  capital: '100',
  riskPosture: null,
  executionDefaults: { mode: 'paper' as const },
};

describe('set_agent_trading_profile tool identity boundary', () => {
  it('rejects a payload actor that differs from the signed subject before any repository operation', async () => {
    const result = await setProfile.execute({ ...params, actorId: 'agent-2' }, context());

    expect(result).toMatchObject({ success: false, errorCode: 'authorization.denied' });
    expect(applyOperation).not.toHaveBeenCalled();
  });

  it('passes the signed owner and actor to the repository after owner-scoped venue authorization', async () => {
    applyOperation.mockResolvedValue(new Map([['action-1', 1n]]));

    const result = await setProfile.execute(params, context());

    expect(result).toMatchObject({ success: true, data: { operationId: 'operation-1', revision: '1' } });
    expect(applyOperation).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: 'owner-1', actorId: 'agent-1', operationId: 'operation-1',
    }));
  });
});