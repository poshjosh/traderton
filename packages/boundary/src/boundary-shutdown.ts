// Extracted from bin.ts so the boundary's graceful-shutdown sequence (E2 F3) is
// unit-testable without booting the process or actually killing it (mirrors the
// agent-direct-actor-ensure.ts / build-boundary-runtime.ts extractions). The M1
// worker entry (packages/worker/src/bin/worker.ts) already shuts down on
// SIGINT/SIGTERM; the shipped boundary process had NO handler, so on a deploy
// `runtime.shutdown()` never ran — actors died mid-cycle and their Redis leases
// only expired after 30s.

import type { Redis } from 'ioredis';
import type { TradingRuntime } from '@traderton/worker';

/** Minimal Fastify surface the shutdown needs — just the listener close. */
interface ClosableApp {
  close(): Promise<void>;
}

/** Minimal logger surface (matches `createLogger` output used in the boundary). */
interface ShutdownLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface BoundaryShutdownDeps {
  app: ClosableApp;
  runtime: TradingRuntime;
  /** The main Redis client (tool context, drive target). */
  redis: Pick<Redis, 'quit'>;
  /** The dedicated bot-stop subscriber connection (cannot share the main client). */
  botStopSubscriber: Pick<Redis, 'quit'>;
  logger: ShutdownLogger;
  /** Injected so tests can assert the exit code without killing the process. */
  exit: (code: number) => void;
}

/**
 * Build the boundary's graceful-shutdown function.
 *
 * Ordering matters and is deliberate:
 *   1. `app.close()`      — stop accepting new HTTP work FIRST, so no fresh
 *                           invocation starts against a runtime we're tearing down.
 *   2. `runtime.shutdown()` — stop actors + release their Redis leases. Bot rows
 *                           stay `running` (resume ruling, overview 000) — this is
 *                           why E2 steps 2+3 leave running rows alone.
 *   3. quit BOTH Redis connections — the main client and the dedicated bot-stop
 *                           subscriber (a subscriber-mode connection cannot be
 *                           reused for other commands, so it is its own client).
 *   4. `exit(0)`          — clean exit.
 *
 * Best-effort: each step is attempted even if an earlier one throws (a stuck
 * listener must not strand actor leases, etc.). Failures are logged, never
 * swallowed, and the process still exits 0 so a deploy's SIGTERM→SIGKILL grace
 * window isn't wasted waiting on a half-failed teardown.
 *
 * Double-signal guard: a second SIGTERM/SIGINT during an in-flight shutdown must
 * not run the sequence twice. The first call latches `shuttingDown` and the
 * subsequent calls return immediately (mirrors the worker's single shutdown).
 */
export function createBoundaryShutdown(deps: BoundaryShutdownDeps): () => Promise<void> {
  let shuttingDown = false;

  return async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    deps.logger.info({}, 'Shutting down boundary...');

    // 1. Stop accepting new requests.
    try {
      await deps.app.close();
    } catch (err) {
      deps.logger.error({ err }, 'boundary shutdown: closing the listener failed');
    }

    // 2. Stop actors + release leases (rows stay `running` — resume ruling).
    try {
      await deps.runtime.shutdown();
    } catch (err) {
      deps.logger.error({ err }, 'boundary shutdown: runtime shutdown failed');
    }

    // 3. Quit both Redis connections (main client + bot-stop subscriber).
    try {
      await deps.redis.quit();
    } catch (err) {
      deps.logger.error({ err }, 'boundary shutdown: quitting the main Redis client failed');
    }
    try {
      await deps.botStopSubscriber.quit();
    } catch (err) {
      deps.logger.error({ err }, 'boundary shutdown: quitting the bot-stop subscriber failed');
    }

    // 4. Clean exit.
    deps.exit(0);
  };
}

/**
 * Build the shutdown function and register it on SIGINT + SIGTERM. Thin wiring
 * seam over `createBoundaryShutdown` so bin.ts stays a one-liner; the once-guard
 * and the sequence live in (and are tested through) the returned function.
 */
export function registerBoundaryShutdown(deps: BoundaryShutdownDeps): () => Promise<void> {
  const shutdown = createBoundaryShutdown(deps);
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  return shutdown;
}
