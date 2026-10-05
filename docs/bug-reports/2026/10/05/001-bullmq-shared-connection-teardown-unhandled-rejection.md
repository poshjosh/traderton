# Bug Report: BullMQ `Queue`/`Worker` on a shared ioredis connection emit unhandled `Connection is closed` rejections on fast teardown

- **Status:** FIXED (2026-10-05) — see "Fix (applied)" below.
- **Severity:** Medium. Makes the integration tier fail CI even when every test passes. Production impact is low (see "Impact").
- **Date:** 2026-10-05
- **Component:** `packages/worker/src/composition/create-trading-runtime.ts` (connection wiring), `packages/worker/src/runtime.ts` (`WorkerRuntime` constructor / `shutdown`)
- **Surfaced by:** `packages/worker/src/restart-round-trip.integration.test.ts`
- **Related:** [002 — `InstanceLease` renew callback has no rejection handling](./002-instance-lease-renew-unguarded-rejection.md). That defect is separate and is **not** the cause of this report. An earlier draft of this report wrongly blamed it.

## Summary

`createTradingRuntime` passes the **same ioredis instance** to BullMQ's `Queue`, BullMQ's `Worker`, the `InstanceLease` and other consumers. BullMQ treats an instance it is given as *shared*. It does not own that connection, so its `close()` does not quit it. If a `Queue`/`Worker` is closed within a few milliseconds of being constructed, BullMQ's connection-setup commands are still pending on the shared client. When the caller then runs `redis.quit()`, ioredis rejects those commands with `Error: Connection is closed.` Nothing awaits them, so they surface as unhandled rejections, and Vitest turns that into a non-zero exit.

## Symptom (as observed)

`phase3-logs/reverify2-tt-tt-all.log` (lines ~1625–1715):

```
{"msg":"Worker runtime started", "time":...888692}
{"msg":"Shutting down worker runtime...", "time":...888694}
{"msg":"Worker runtime shut down", "time":...888694}
stderr | packages/worker/src/restart-round-trip.integration.test.ts > bot restart round-trip (integration)
Error: Connection is closed.
    at close (.../ioredis@5.11.1/.../redis/event_handler.js:214:25)
    at Socket.<anonymous> (.../ioredis@5.11.1/.../redis/event_handler.js:181:20)
 ✓ packages/worker/src/restart-round-trip.integration.test.ts (2 tests) 136ms
⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯
Error: Connection is closed.
 ❯ close .../ioredis/built/redis/event_handler.js:214:25
 ❯ Socket.<anonymous> .../ioredis/built/redis/event_handler.js:181:20
 ... (×3)
     Errors  3 errors
[tests] Test run failed (exit 1).
```

- Every assertion passes. Only the exit code fails.
- The failure is intermittent. 0 occurrences in `final-verify-tt-integration.log`, `wave-e-tt-all.log`, `reverify2-tt-tt-integration.log` (the same run's integration tier) and an isolated `scripts/shell/tests/run-integration.sh` run.
- The rejections follow CASE B's runtime, which runs from `start()` to `shutdown()` in **~2 ms** (timestamps `…888692` → `…888694`).
- The stack holds only ioredis frames. `event_handler.js:181` is the `manuallyClosing` branch of the close handler, and `:214` is `close()` → `flushQueue(new Error("Connection is closed."))`. In other words, a manual `quit()`/`disconnect()` is rejecting commands that are still queued on the client.
- The `stderr | … Error: Connection is closed.` block is BullMQ's `Worker` printing its own `error` event (it has no listener attached). That block is consistent with this cause.

## Root Cause

### 1. A single ioredis instance is shared with BullMQ

`create-trading-runtime.ts`:

```ts
const lease = new InstanceLease(redis, workerId, 30);          // L311
...
const runtimeConfig: WorkerRuntimeConfig = { redis, ... };     // L910 — the SAME instance
const runtime = new WorkerRuntime(runtimeConfig, actorFactory, instanceLoader, lease);
```

`runtime.ts` (constructor):

```ts
this.queue  = new Queue(QUEUE_NAME, { connection: config.redis });
this.worker = new Worker(QUEUE_NAME, processor, { connection: config.redis, concurrency });
```

When `connection` is an ioredis instance, BullMQ (5.81.4 installed) wraps it as a **shared** `RedisConnection`. Its `close()` skips `quit()`/`disconnect()` for shared clients (`bullmq/dist/esm/classes/redis-connection.js`, `if (!this.extraOptions.shared)`). Closing the `Queue`/`Worker` therefore does not drain or own the client's lifecycle. Whatever BullMQ setup is still in flight on that client stays pending until the owner, here the test's `afterEach`, calls `redis.quit()`. The pending commands are then flushed with `Connection is closed`.

### 2. The test closes runtimes within the race window

`restart-round-trip.integration.test.ts` drives `runtime.start()` directly and shuts down at once. CASE B starts and stops in ~2 ms. `afterEach` then calls `trading.shutdown()` → `worker.close()` → `queue.close()`, followed by `redis.quit()`, while BullMQ setup on the shared client can still be in flight.

### 3. This diverges from the pre-extraction source

In herobids before extraction (`git show 45271d28^:apps/worker/src/index.ts`), BullMQ received **connection options**, and the lease used a separate client:

```ts
// L110–111: "Redis client for lease management (separate from BullMQ's internal connection)"
const redisClient = new Redis(redisConnection);
const lease = new InstanceLease(redisClient, workerId, 30);   // L211
const runtime = new WorkerRuntime({ redis: redisConnection, ... }, ...);   // L1786–1788 — plain options
```

Given options, BullMQ creates and owns its own connections and closes them itself in `close()`, so this race cannot happen. Traderton's `TradingRuntimePorts.redis: Redis` ("BullMQ lifecycle-job connection + instance lease") merged the two. That merge is an undocumented divergence in Traderton's composition wiring. `runtime.ts` itself is unchanged.

## Confirmation (isolated reproduction, no `InstanceLease`)

I ran a standalone script against a throwaway `redis:7` container. It mirrors the `WorkerRuntime` constructor and `shutdown()` plus the test's `afterEach`, with **no `InstanceLease` and no Traderton code**:

```js
const redis  = new Redis(url, { maxRetriesPerRequest: null });
const queue  = new Queue('p',  { connection: redis });
const worker = new Worker('p', async () => {}, { connection: redis });
await sleep(N);
await worker.close(); await queue.close();
await redis.quit().catch(() => {});
```

Unhandled rejections over 40 iterations:

| N (ms) | Queue only | Worker only |
|---|---|---|
| 1 | 11 | 2 |
| 2 | 2 | 23 |
| 3 | 1 | 1 |
| 5 | 0 | 0 |

- The stack is identical to the CI log (`event_handler.js:214:25` / `:181:20`).
- The Worker variant also prints the `console.error` block seen at log line 1662.
- The failure window (~1–3 ms) matches CASE B's 2 ms lifetime.

Environment: Node v22.22.3, ioredis 5.11.1, bullmq 5.81.4.

### Why `InstanceLease` is ruled out

- Its renew timer fires every `30 * 1000 / 2` = 15 s. The whole test file runs in 136 ms.
- `release()` and `lease.shutdown()` clear the timer before `redis.quit()`.
- CASE B never acquires a lease, because its bot is `stopped`.
- `quit()` does not reject commands sent before `QUIT`; Redis replies to them in order. A renew already awaiting a reply would resolve, not reject.

## Impact

1. **CI reliability.** A fully passing suite can exit non-zero. At the exit-code level this looks the same as a real regression.
2. **Production: low.** `bin/worker.ts` and `boundary/src/bin.ts` call `trading.shutdown()` and then `redis.quit()` only at process shutdown, long after BullMQ setup has finished. An unhandled rejection there would arrive while the process is already exiting. The shared wiring still breaks the documented herobids separation, and it makes BullMQ setup and close behaviour depend on how the caller tears down.

## Reproduction

The CI symptom is timing-dependent:

```
env -u DATABASE_URL -u REDIS_URL -u BOUNDARY_BASE_URL \
  ONLY=tt-all bash phase3-logs/run-five.sh repro
grep -nE "Unhandled Rejection|Connection is closed|Errors |Test run failed" phase3-logs/repro-tt-all.log
```

For a deterministic reproduction, run the snippet under "Confirmation" in a loop with `N` = 1–3 ms against any disposable Redis.

## Candidate Fixes (none applied)

### Option A: give BullMQ its own connection (recommended)

Restore the pre-extraction separation. Pass BullMQ connection options, or a dedicated `redis.duplicate()` that the runtime owns and quits in `shutdown()`, instead of the shared instance. Keep the shared instance for `InstanceLease` and the other consumers.

- Pros: removes the race at its source. Restores herobids parity for the composition wiring. Leaves the copied `runtime.ts` untouched.
- Cons: one extra connection set per runtime (BullMQ opens its own). `TradingRuntimePorts` needs either a URL/options field or an internal `duplicate()`. If `duplicate()` is chosen, `shutdown()` must quit it.
- Record in `docs/features/initial/003-anomalies-and-deviations.md` as a parity restoration.

### Option B: await BullMQ readiness before closing

In `WorkerRuntime.start()` (or before `close()` in `shutdown()`), `await this.queue.waitUntilReady()` and `await this.worker.waitUntilReady()`. Then `close()` can never overlap setup.

- Pros: small change.
- Cons: `runtime.ts` is a copied file, so this needs a source-fix request or a recorded divergence. Herobids no longer contains `WorkerRuntime` (deleted in `45271d28`). Does not undo the shared-connection divergence.

### Option C: test-only mitigation

Await `trading.runtime` readiness (or settle BullMQ setup) in `restart-round-trip.integration.test.ts` before teardown.

- Pros: touches no production code.
- Cons: hides the issue for one suite. Any other suite that builds and tears down a runtime quickly can hit it. A single `setImmediate` tick is **not** enough, because the reproduction still fails at 2–3 ms.

Not recommended: an `unhandledRejection` filter that ignores `Connection is closed`. It hides real signals too.

## Recommendation

Option A. Validate it by rerunning the isolated reproduction at `N` = 1–3 ms (expect 0 unhandled rejections) and then the full `tt-all` gate several times.

## Fix (applied 2026-10-05)

**Option A (BullMQ gets its own connection) + a targeted readiness wait.** Recorded in
`docs/features/initial/003-anomalies-and-deviations.md`.

1. **`create-trading-runtime.ts` — BullMQ gets connection OPTIONS, not the shared instance.**
   `WorkerRuntimeConfig.redis` is now `{ url: config.redis.url, maxRetriesPerRequest: null }`
   (BullMQ's own `url` option, parsed by its `new IORedis(url, rest)` exactly as the bins build
   the shared client — no hand-rolled parser, so query params / IPv6 can't diverge). BullMQ
   creates, owns, and closes its own Queue/Worker connections; the shared `redis` instance stays
   the lease/provider/drive-target connection.
2. **`runtime.ts` — `WorkerRuntime.start()` awaits `queue.waitUntilReady()` + `worker.waitUntilReady()`**
   before the runtime is considered started, so a runtime that starts and stops within
   milliseconds can never reach `close()` while BullMQ setup is still in flight. (This closes the
   residual overlap that remained from BullMQ's own blocking Worker connection even after change 1.)
   An earlier draft of the fix also added an unbounded readiness wait in `shutdown()`; it was
   **removed on review** — unneeded (every runtime calls `start()` first), its comment was wrong,
   and it both blocked BullMQ's own close-while-connecting suppression and was a future hang trap.
3. **`boundary/src/bin.ts` follow-up:** every Redis connection there now comes from
   `appConfig.redis.url` (not `process.env.REDIS_URL ?? 'redis://localhost:6379'`), so the
   boundary's shared/subscriber connections and the BullMQ lifecycle connection cannot point at
   different servers.
4. **Dependency floor:** `bullmq` raised `^5.34.0` → `^5.81.0` (the resolved minor) to guarantee
   the `url` connection option is available (lockfile already pins 5.81.4).

**Verification:** `pnpm lint` + `pnpm build` clean; the two BullMQ-mocking unit suites (22/22);
the integration tier (incl. `restart-round-trip.integration.test.ts`) ran clean across repeated
loops with zero `Connection is closed` / unhandled rejections and `exit=0`. A regression unit test
asserts `WorkerRuntime` receives connection settings, not the shared instance (see below).

## Scope / Non-goals

- Not a regression from the 002/003 work, and not a data-correctness issue.
- The unguarded `InstanceLease` renew callback is tracked separately in [002](./002-instance-lease-renew-unguarded-rejection.md) and is NOT addressed here.

## Evidence / References

- Failing run: `phase3-logs/reverify2-tt-tt-all.log` lines ~1625–1715.
- Clean runs: `phase3-logs/final-verify-tt-integration.log`, `phase3-logs/wave-e-tt-all.log`, `phase3-logs/reverify2-tt-tt-integration.log`.
- Wiring: `packages/worker/src/composition/create-trading-runtime.ts` L311 (lease) and L910 (`runtimeConfig.redis`).
- BullMQ consumers: `packages/worker/src/runtime.ts` constructor (`new Queue` / `new Worker`) and `shutdown()`.
- Teardown: `packages/worker/src/restart-round-trip.integration.test.ts` `afterEach`.
- Pre-extraction wiring: herobids `git show 45271d28^:apps/worker/src/index.ts` L101–111, L211, L1786–1788.
- ioredis close path: `node_modules/.pnpm/ioredis@5.11.1/node_modules/ioredis/built/redis/event_handler.js` L178–216.
