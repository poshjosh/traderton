// AUTHORED test (E2 F2) — the boundary trading runtime is built with the shared
// running-bot loader. Mocks the two @traderton/worker factories so the test
// proves the WIRING (createRunningBotLoader(db) is the instanceLoader handed to
// createTradingRuntime) without booting Postgres/Redis or the runtime itself.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import type { Database } from '@traderton/db';

const createTradingRuntime = vi.fn();
const createRunningBotLoader = vi.fn();

vi.mock('@traderton/worker', () => ({
  createTradingRuntime,
  createRunningBotLoader,
}));

// Imported after the mock is registered so the module binds to the mocked
// factories.
const { buildBoundaryTradingRuntime } = await import('./build-boundary-runtime.js');

beforeEach(() => {
  createTradingRuntime.mockReset();
  createRunningBotLoader.mockReset();
});

describe('buildBoundaryTradingRuntime', () => {
  it('builds the boundary runtime with the running-bot loader', () => {
    const loader = vi.fn();
    createRunningBotLoader.mockReturnValue(loader);
    const runtimeSentinel = { shutdown: vi.fn() };
    createTradingRuntime.mockReturnValue(runtimeSentinel);

    const config = { database: { url: 'postgres://x' } } as unknown as Parameters<
      typeof buildBoundaryTradingRuntime
    >[0]['config'];
    const redis = {} as Redis;
    const db = { select: vi.fn() } as unknown as Database;

    const runtime = buildBoundaryTradingRuntime({ config, redis, db });

    // The loader is built from THIS db handle...
    expect(createRunningBotLoader).toHaveBeenCalledOnce();
    expect(createRunningBotLoader).toHaveBeenCalledWith(db);

    // ...and handed to the runtime as its instanceLoader (the reclaim/rehydrate
    // source), alongside the same config + redis.
    expect(createTradingRuntime).toHaveBeenCalledOnce();
    expect(createTradingRuntime).toHaveBeenCalledWith({
      config,
      redis,
      instanceLoader: loader,
    });

    expect(runtime).toBe(runtimeSentinel);
  });
});
