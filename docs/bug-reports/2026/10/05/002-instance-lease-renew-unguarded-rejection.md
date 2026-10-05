# Bug Report: `InstanceLease` renew callback has no rejection handling and no in-flight guard

- **Status:** FIXED (2026-10-05) — see "Fix (applied)" below.
- **Severity:** Low–Medium. Defence in depth. No observed failure.
- **Date:** 2026-10-05
- **Component:** `packages/worker/src/instance-lease.ts` (`InstanceLease.startRenewal`)
- **Affects:** every `InstanceLease` user: bot leases, the agent-actor lease (002 feature) and the journal-maintenance lease (003 feature)
- **Related:** [001 — BullMQ shared-connection teardown rejection](./001-bullmq-shared-connection-teardown-unhandled-rejection.md). This defect was first suspected as the cause of 001 and has been **ruled out**. It is filed here on its own merits.

## Summary

The renewal `setInterval` callback is `async` and awaits `this.renew()` with no `catch`. Nothing awaits the promise it returns. If `renew()` rejects, the result is an unhandled promise rejection. Node 22's default `--unhandled-rejections=throw` makes that fatal, and neither Traderton entry point installs an `unhandledRejection` handler. The callback also has no in-flight guard, so a slow renew does not stop the next tick from starting another one.

```ts
private startRenewal(instanceId: string): void {
  this.stopRenewal(instanceId);
  const interval = Math.floor(this.ttlSeconds * 1000 / 2);
  const timer = setInterval(async () => {
    const renewed = await this.renew(instanceId);   // a rejection is unhandled
    if (!renewed) this.stopRenewal(instanceId);      // only the resolved-false case is handled
  }, interval);
  this.renewTimers.set(instanceId, timer);
}
```

The file is byte-identical to herobids `apps/worker/src/instance-lease.ts` (`diff -q` → identical). It was last changed in Traderton in `578180f` (Phase 8). The defect was inherited, not introduced by Traderton.

## When `renew()` can reject (current wiring)

Both production entry points create the shared client with `maxRetriesPerRequest: null`: `packages/worker/src/bin/worker.ts` L20 and `packages/boundary/src/bin.ts` L103–104. With that setting, ioredis **does not reject** commands during a disconnect, failover or reconnect. It keeps them in the offline queue and replays them once reconnected. So a transient Redis blip does **not** reject a renew today.

A renew rejects only when:

- the client is closed manually (`disconnect()`, or a command issued after `QUIT` was sent) while a renew is pending or being dispatched; or
- a future change sets `maxRetriesPerRequest` to a number (`MaxRetriesPerRequestError`), or adds a `retryStrategy` that gives up; or
- Redis returns a script error (for example `NOSCRIPT`/`BUSY`, or an ACL denial on `EVAL`).

The graceful shutdown path clears every timer (`lease.shutdown()` in `WorkerRuntime.shutdown()`) before the bins call `redis.quit()`. `quit()` lets replies to commands sent before `QUIT` arrive normally. So the shutdown window is narrow, but it is not guarded.

## The more realistic production risk: stalled, overlapping renews

Because commands queue indefinitely during an outage, the likely failure is not a crash. Instead:

1. A renew stalls in the offline queue while Redis is unreachable.
2. `setInterval` keeps firing every 15 s and stacks more pending renews.
3. If the outage lasts longer than the TTL (30 s), the lease key expires on the server. Another worker can acquire it while this worker's actor keeps running, which gives two owners until a renew finally resolves to `false`.

Point 3 is a property of the lease design (no fencing; the actor is not stopped when renewal stalls), not of this callback alone. It is noted here because a fix to the callback should not make it worse, and is out of scope otherwise.

## Candidate Fix (not applied)

Treat a rejected renew like a lost lease, and skip a tick while a renew is still pending:

```ts
private startRenewal(instanceId: string): void {
  this.stopRenewal(instanceId);
  const interval = Math.floor(this.ttlSeconds * 1000 / 2);
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;                        // don't stack renews behind a stalled one
    inFlight = true;
    this.renew(instanceId)
      .then((renewed) => { if (!renewed) this.stopRenewal(instanceId); })
      .catch(() => { this.stopRenewal(instanceId); })   // never an unhandled rejection
      .finally(() => { inFlight = false; });
  }, interval);
  this.renewTimers.set(instanceId, timer);
}
```

Open questions for review:

- **Stop or retry on reject?** Stopping matches the existing "can't renew → lost the lease" semantics. However, nothing tells the lease owner (the actor or runtime) that renewal has stopped, so the actor keeps running unleased in both the existing `false` path and the proposed reject path. Adding a callback such as `onLeaseLost` would be a behaviour change and should be specified separately.
- **Log before stopping?** The class takes no logger today. Adding one is a constructor-signature change.
- **Parity:** `instance-lease.ts` is a copied file kept 1:1 with herobids. Either raise a source-fix request in herobids (the defect exists there too) and re-copy, or record a Traderton divergence in `docs/features/initial/003-anomalies-and-deviations.md`.

## Verification plan

Add unit tests with a fake Redis whose `eval` (a) rejects, and (b) never resolves:

- (a) Assert no unhandled rejection, and that the timer is removed from `renewTimers`.
- (b) Advance fake timers past several intervals and assert that only one `eval` is in flight.

## Fix (applied 2026-10-05)

Implemented the candidate fix above in `packages/worker/src/instance-lease.ts` `startRenewal`.
Recorded as an Intentional Divergence in `docs/features/initial/003-anomalies-and-deviations.md`
(the file was byte-identical to herobids; a herobids source-fix request + re-copy remains the
parity-correct long-term path, and the defect exists there too).

- The timer callback is no longer `async`: it dispatches `this.renew()` and attaches
  `.then/.catch/.finally`, so a **rejected** renew can never become an unhandled rejection.
- A rejected renew is **logged (`warn`) and retried on the next tick**; the timer is kept. Only
  `renewed === false` (another worker owns the key) stops renewal.
- An `inFlight` flag skips a tick while a prior renew is still pending, so a stalled renew (ioredis
  offline-queueing during an outage) no longer stacks.
- A late `false` from a timer that was already replaced (release → re-acquire while a renew was in
  flight) no longer stops the newer timer: `stopRenewal` runs only if the timer is still current.
  Covered by its own test, which fails without the guard.
- **Resolved open questions:**
  - _Stop vs retry_ → **retry**. This reverses the candidate fix above. A rejection (e.g. a one-off
    `BUSY`/ACL error) does not mean the lease was lost; we most likely still own it. Stopping would
    let the key expire under a still-running actor, and in a multi-worker deployment a peer's 15s
    reclaim sweep would then start a second actor for the same bot (dual ownership). Before the
    fix, the same rejection crashed the process, which at least took the actor down with it.
    Retrying keeps the lease alive through transient errors. A permanently closed connection just
    rejects (cheaply, handled) each tick until `shutdown()`/`release()` clears the timer.
  - _Log_ → **added**, via a module-level `createLogger('instance-lease')` (the pattern used by
    `runtime.ts`), so no constructor-signature change.
  - _Parity_ → recorded as a Traderton divergence (per the option in the open question).
- **Still out of scope (unchanged):** no `onLeaseLost` owner-notification, no lease fencing — the
  actor still keeps running unleased after a `false` renew, exactly as before the fix.

**Verification (implemented in `packages/worker/src/instance-lease.test.ts`):** `pnpm lint` and the
`@traderton/worker` build are clean; 6 tests pass:
(a) a rejecting `eval` leaks no `unhandledRejection` (asserted via a `process.on('unhandledRejection')`
listener) and is retried every tick; (a2) a single transient rejection is followed by normal
renewing; (a3) `shutdown()` stops the retries; (b) a never-resolving `eval` dispatches exactly once
across many intervals (in-flight guard); plus happy-path (keeps renewing) and lost-lease
(`renewed === false` → stops) regressions. Against the pre-fix `startRenewal`, the
unhandled-rejection assertion fails (4 captured `Connection is closed` errors), so the test pins the
defect. The `packages/worker` + `packages/boundary` unit suites pass (82 files, 1560 tests).

## Scope / Non-goals

- Not the cause of the CI flake in 001.
- Lease fencing and notifying the owner on lease loss are out of scope.

## References

- `packages/worker/src/instance-lease.ts` (`startRenewal`, `renew`, `shutdown`).
- `packages/worker/src/runtime.ts` `WorkerRuntime.shutdown()` (`this.lease.shutdown()` before `worker.close()`).
- `packages/worker/src/bin/worker.ts` L20 and `packages/boundary/src/bin.ts` L103–104 (`maxRetriesPerRequest: null`).
- herobids `apps/worker/src/instance-lease.ts` (was identical before this fix; the same defect
  remains there — a source-fix request + re-copy is the parity-correct long-term path).
- `packages/worker/src/instance-lease.test.ts` (the fix's regression tests, added 2026-10-05).
