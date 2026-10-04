// AUTHORED test (E2 F3) — the boundary's graceful shutdown. Proves the sequence
// closes the listener, shuts the runtime down, quits BOTH Redis connections and
// exits 0, and that a repeated signal (double SIGTERM) never runs the sequence
// twice. No process is booted or killed: `exit` is injected.

import { describe, it, expect, vi } from 'vitest';
import { createBoundaryShutdown, type BoundaryShutdownDeps } from './boundary-shutdown.js';

interface TestDeps {
  app: { close: ReturnType<typeof vi.fn> };
  runtime: { shutdown: ReturnType<typeof vi.fn> };
  redis: { quit: ReturnType<typeof vi.fn> };
  botStopSubscriber: { quit: ReturnType<typeof vi.fn> };
  logger: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  exit: ReturnType<typeof vi.fn>;
}

// The spies carry only the surface the shutdown touches (close/shutdown/quit).
// `BoundaryShutdownDeps` already narrows `redis`/`botStopSubscriber` to
// `Pick<Redis, 'quit'>` and `runtime` to the real `TradingRuntime`; the fakes
// are structurally wider than needed, so the single assertion keeps the test
// honest without a chain of per-field casts.
function buildDeps(): TestDeps {
  return {
    app: { close: vi.fn().mockResolvedValue(undefined) },
    runtime: { shutdown: vi.fn().mockResolvedValue(undefined) },
    redis: { quit: vi.fn().mockResolvedValue('OK') },
    botStopSubscriber: { quit: vi.fn().mockResolvedValue('OK') },
    logger: { info: vi.fn(), error: vi.fn() },
    exit: vi.fn(),
  };
}

function asShutdownDeps(deps: TestDeps): BoundaryShutdownDeps {
  return deps as unknown as BoundaryShutdownDeps;
}

describe('createBoundaryShutdown', () => {
  it('closes the listener, stops the runtime and quits Redis once, even on repeated signals', async () => {
    const deps = buildDeps();
    const shutdown = createBoundaryShutdown(asShutdownDeps(deps));

    // Two signals (e.g. a deploy's SIGTERM then an operator's Ctrl-C) must run
    // the teardown exactly once.
    await shutdown();
    await shutdown();

    expect(deps.app.close).toHaveBeenCalledTimes(1);
    expect(deps.runtime.shutdown).toHaveBeenCalledTimes(1);
    expect(deps.redis.quit).toHaveBeenCalledTimes(1);
    expect(deps.botStopSubscriber.quit).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('runs the steps in order: close listener, then runtime, then redis, then exit', async () => {
    const deps = buildDeps();
    const order: string[] = [];
    deps.app.close.mockImplementation(async () => { order.push('close'); });
    deps.runtime.shutdown.mockImplementation(async () => { order.push('runtime'); });
    deps.redis.quit.mockImplementation(async () => { order.push('redis'); return 'OK'; });
    deps.botStopSubscriber.quit.mockImplementation(async () => { order.push('subscriber'); return 'OK'; });
    deps.exit.mockImplementation(() => { order.push('exit'); });

    await createBoundaryShutdown(asShutdownDeps(deps))();

    expect(order).toEqual(['close', 'runtime', 'redis', 'subscriber', 'exit']);
  });

  it('attempts every cleanup step and still exits when a step throws (best effort)', async () => {
    const deps = buildDeps();
    deps.runtime.shutdown.mockRejectedValue(new Error('runtime stuck'));

    await createBoundaryShutdown(asShutdownDeps(deps))();

    // A failed runtime shutdown must not strand the Redis connections or block
    // the exit.
    expect(deps.app.close).toHaveBeenCalledTimes(1);
    expect(deps.redis.quit).toHaveBeenCalledTimes(1);
    expect(deps.botStopSubscriber.quit).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(0);
    expect(deps.logger.error).toHaveBeenCalled();
  });
});
