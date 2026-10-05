// Unit tests for InstanceLease's renewal timer (bug 2026-10-05/002).
//
// The renew `setInterval` callback used to `await this.renew()` with no catch and
// no in-flight guard. A rejected renew (connection closed during teardown, a
// MaxRetriesPerRequestError, a script/ACL error) became an UNHANDLED rejection —
// process-fatal under Node's default `--unhandled-rejections=throw` — and a
// stalled renew stacked another on every tick. These tests pin the fix:
//   (a) a rejecting renew does NOT surface an unhandled rejection and is retried
//       on the next tick (a rejection is not a lost lease; only `false` stops);
//   (b) a never-resolving renew does NOT stack: only one `eval` is ever in flight
//       across many intervals.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { InstanceLease } from './instance-lease.js';

const TTL_SECONDS = 10; // renew interval = TTL/2 = 5000ms

/**
 * A fake ioredis whose `set` (acquire) returns OK and whose `eval` (renew/release)
 * behaviour is supplied per-test. Only the methods InstanceLease touches exist.
 */
function fakeRedis(evalImpl: () => Promise<unknown>): {
  redis: Redis;
  setCalls: () => number;
  evalCalls: () => number;
} {
  let setCount = 0;
  let evalCount = 0;
  const redis = {
    set: vi.fn(async () => {
      setCount++;
      return 'OK';
    }),
    eval: vi.fn(() => {
      evalCount++;
      return evalImpl();
    }),
  } as unknown as Redis;
  return { redis, setCalls: () => setCount, evalCalls: () => evalCount };
}

describe('InstanceLease renewal timer (bug 2026-10-05/002)', () => {
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not leak an unhandled rejection when a renew rejects, and retries on the next tick', async () => {
    const { redis, evalCalls } = fakeRedis(() => Promise.reject(new Error('Connection is closed.')));
    const lease = new InstanceLease(redis, 'worker-x', TTL_SECONDS);

    expect(await lease.acquire('bot-1')).toBe(true);
    expect(evalCalls()).toBe(0); // no renew yet

    // First renew tick → eval rejects. The callback must catch it.
    await vi.advanceTimersByTimeAsync(5000);
    expect(evalCalls()).toBe(1);

    // A rejection is NOT a lost lease: the loop keeps going and retries each tick
    // (stopping would let the key expire under a still-running actor).
    await vi.advanceTimersByTimeAsync(5000 * 3);
    expect(evalCalls()).toBe(4);

    // Every rejection was handled: nothing reached the process-level listener.
    expect(unhandled).toEqual([]);
  });

  it('recovers after a transient renew rejection', async () => {
    let call = 0;
    const { redis, evalCalls } = fakeRedis(() =>
      ++call === 1 ? Promise.reject(new Error('BUSY')) : Promise.resolve(1),
    );
    const lease = new InstanceLease(redis, 'worker-v', TTL_SECONDS);
    expect(await lease.acquire('bot-5')).toBe(true);

    await vi.advanceTimersByTimeAsync(5000); // rejects
    await vi.advanceTimersByTimeAsync(5000); // succeeds
    await vi.advanceTimersByTimeAsync(5000); // still renewing
    expect(evalCalls()).toBe(3);
    expect(unhandled).toEqual([]);
  });

  it('stops retrying once the lease is shut down', async () => {
    const { redis, evalCalls } = fakeRedis(() => Promise.reject(new Error('Connection is closed.')));
    const lease = new InstanceLease(redis, 'worker-u', TTL_SECONDS);
    expect(await lease.acquire('bot-6')).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);
    lease.shutdown();
    await vi.advanceTimersByTimeAsync(5000 * 3);
    expect(evalCalls()).toBe(1);
    expect(unhandled).toEqual([]);
  });

  it('does not stack renews while one is still in flight (stalled renew)', async () => {
    // A renew that never resolves (mirrors ioredis holding the command in its
    // offline queue during a Redis outage). The in-flight guard must prevent a
    // second renew from starting on later ticks.
    const { redis, evalCalls } = fakeRedis(() => new Promise<never>(() => { /* never settles */ }));
    const lease = new InstanceLease(redis, 'worker-y', TTL_SECONDS);

    expect(await lease.acquire('bot-2')).toBe(true);

    // Advance well past several renew intervals; only the first tick dispatches.
    await vi.advanceTimersByTimeAsync(5000 * 5);

    expect(evalCalls()).toBe(1);
    expect(unhandled).toEqual([]);
  });

  it('keeps renewing on successful renews (happy path unchanged)', async () => {
    // eval returns 1 (lease still ours). Each interval renews again.
    const { redis, evalCalls } = fakeRedis(() => Promise.resolve(1));
    const lease = new InstanceLease(redis, 'worker-z', TTL_SECONDS);

    expect(await lease.acquire('bot-3')).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);

    expect(evalCalls()).toBe(2); // one renew per interval
    expect(unhandled).toEqual([]);
  });

  it('stops renewing when a renew reports the lease was lost (renewed === false)', async () => {
    // eval returns 0 (someone else owns the key now) → stop renewing.
    const { redis, evalCalls } = fakeRedis(() => Promise.resolve(0));
    const lease = new InstanceLease(redis, 'worker-w', TTL_SECONDS);

    expect(await lease.acquire('bot-4')).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000 * 3);

    expect(evalCalls()).toBe(1); // stopped after the first false
    expect(unhandled).toEqual([]);
  });

  it('a late lost-lease result from a replaced timer does not stop the newer timer', async () => {
    // Call 1: the first renew, held open. Call 2: release (succeeds). After the
    // re-acquire, every further renew succeeds.
    let resolveStaleRenew: (value: number) => void = () => {};
    let call = 0;
    const { redis, evalCalls } = fakeRedis(() => {
      call++;
      if (call === 1) return new Promise<number>((resolve) => { resolveStaleRenew = resolve; });
      return Promise.resolve(1);
    });
    const lease = new InstanceLease(redis, 'worker-t', TTL_SECONDS);

    expect(await lease.acquire('bot-7')).toBe(true);
    await vi.advanceTimersByTimeAsync(5000); // stale renew now in flight
    expect(await lease.release('bot-7')).toBe(true);
    expect(await lease.acquire('bot-7')).toBe(true); // new timer

    // The stale renew settles with `false` AFTER the timer was replaced.
    resolveStaleRenew(0);
    await vi.advanceTimersByTimeAsync(0);

    // The new timer must still be renewing.
    const before = evalCalls();
    await vi.advanceTimersByTimeAsync(5000 * 2);
    expect(evalCalls()).toBe(before + 2);
    expect(unhandled).toEqual([]);
  });
});
