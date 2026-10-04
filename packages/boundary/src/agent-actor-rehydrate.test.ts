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
    const ensureAgent = vi.fn(async () => ({ owner: 'local' as const }));
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
      .mockResolvedValueOnce({ owner: 'local' as const });

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
    const ensureAgent = vi.fn(async () => ({ owner: 'local' as const }));
    const ensured = await rehydrateAgentActors({ listRunning: async () => [], ensureAgent, logger: buildLogger() });
    expect(ensureAgent).not.toHaveBeenCalled();
    expect(ensured).toBe(0);
  });

  it('counts a remotely-owned agent as a no-op success, not a local construction', async () => {
    const logger = buildLogger();
    // The agent's lease is held by another worker: the ensure reports `remote`
    // and constructs nothing here. 001 S4: this is a success, not a failure.
    const ensureAgent = vi.fn(async () => ({ owner: 'remote' as const, workerId: 'worker-remote1' }));

    const ensured = await rehydrateAgentActors({
      listRunning: async () => [run('owned-elsewhere')],
      ensureAgent,
      logger,
    });

    expect(ensureAgent).toHaveBeenCalledTimes(1);
    expect(ensured).toBe(0); // nothing constructed locally
    expect(logger.error).not.toHaveBeenCalled(); // remote is NOT an error
    expect(logger.info).toHaveBeenCalled(); // the skip was logged for observability
  });
});
