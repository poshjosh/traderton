# Bug Report: `InstanceLease` renew callback has no rejection handling and no in-flight guard

- **Status:** OPEN (latent; not observed; not fixed)
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

## Scope / Non-goals

- Documentation only. No code was changed.
- Not the cause of the CI flake in 001.
- Lease fencing and notifying the owner on lease loss are out of scope.

## References

- `packages/worker/src/instance-lease.ts` (`startRenewal`, `renew`, `shutdown`).
- `packages/worker/src/runtime.ts` `WorkerRuntime.shutdown()` (`this.lease.shutdown()` before `worker.close()`).
- `packages/worker/src/bin/worker.ts` L20 and `packages/boundary/src/bin.ts` L103–104 (`maxRetriesPerRequest: null`).
- herobids `apps/worker/src/instance-lease.ts` (identical source).
