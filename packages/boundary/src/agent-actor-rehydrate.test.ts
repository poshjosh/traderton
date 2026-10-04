// Unit tests for the boot rehydrate (Wave E / E1-T T5): every running agent-run
// row is re-ensured through the single ensure entry point, and a per-agent
// failure is logged + skipped without crashing boot.

import { describe, it, expect, vi } from 'vitest';
import { rehydrateAgentActors, type RehydrateAgentRun } from './agent-actor-rehydrate.js';

function buildLogger() {
  return { info: vi.fn(), error: vi.fn() };
}

const run = (actorId: string): RehydrateAgentRun => ({
  ownerId: 'o1', actorId, venueAccountId: 'va1', venue: 'hyperliquid', venueType: 'orderbook',
});

describe('rehydrateAgentActors', () => {
  it('ensures every running agent actor on boot', async () => {
    const ensureAgent = vi.fn(async () => undefined);
    const ensured = await rehydrateAgentActors({
      listRunning: async () => [run('a1'), run('a2')],
      ensureAgent,
      logger: buildLogger(),
    });

    expect(ensureAgent).toHaveBeenCalledTimes(2);
    expect(ensureAgent).toHaveBeenCalledWith(run('a1'));
    expect(ensureAgent).toHaveBeenCalledWith(run('a2'));
    expect(ensured).toBe(2);
  });

  it('does not crash boot when one agent fails to ensure — logs and continues', async () => {
    const logger = buildLogger();
    const ensureAgent = vi
      .fn()
      .mockRejectedValueOnce(new Error('missing credential'))
      .mockResolvedValueOnce(undefined);

    const ensured = await rehydrateAgentActors({
      listRunning: async () => [run('bad'), run('good')],
      ensureAgent,
      logger,
    });

    expect(ensureAgent).toHaveBeenCalledTimes(2); // the failure did not abort the loop
    expect(ensured).toBe(1); // only the good one succeeded
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('ensures nothing when there are no running rows', async () => {
    const ensureAgent = vi.fn(async () => undefined);
    const ensured = await rehydrateAgentActors({ listRunning: async () => [], ensureAgent, logger: buildLogger() });
    expect(ensureAgent).not.toHaveBeenCalled();
    expect(ensured).toBe(0);
  });
});
