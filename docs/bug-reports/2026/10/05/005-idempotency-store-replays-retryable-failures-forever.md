# Bug Report 005 — The boundary idempotency store caches *retryable* failures as terminal and replays them for the whole retention window; a retried side-effecting tool (e.g. `deprovision_venue_account`) is poisoned for up to a week

- **Status:** OPEN (analysed, not yet fixed)
- **Severity:** Medium. A side-effecting tool invocation whose *first* attempt fails **transiently** (DB blip, context/readiness failure, upstream throttle) stores that failure as the invocation's terminal outcome. Every subsequent retry under the **same idempotency key** — which is exactly how a well-behaved client retries a retryable failure without risking a double side effect — gets the stale failure replayed back, with `retryable: true`, **without the tool ever running again**. The side effect never happened, yet the key is dead until `expires_at` (default 168h). The caller sees a permanent "transient, please retry" that never clears. No data corruption and no duplicate side effect, so not High — but it defeats the retry contract the boundary advertises.
- **Date:** 2026-10-05
- **Environment:** All — defect is in `@traderton/boundary` dispatcher + `@traderton/db` idempotency repo. Runtime-agnostic; reproduces wherever the REST idempotency store is wired (M2+).
- **Reviewer:** The fix will be reviewed against the acceptance criteria in this document. Please satisfy every item in [Acceptance criteria](#acceptance-criteria) and every scenario in [Required tests](#required-tests).

---

## 1. Summary

The side-effecting idempotency wrap persists **whatever** terminal result the tool produced — success *or* failure — and replays it verbatim on any later call that reuses the same idempotency key with the same request fingerprint.

The store makes no distinction between:
- a **terminal, authoritative** outcome (success; or a non-retryable content failure like "venue account not found" / "in use") — correct to cache and replay; and
- a **transient / retryable** failure (`upstream.transient`, `rate_limit.exceeded`, a retryable `precondition.not_ready`) where the side effect **did not happen** and the client is explicitly told to retry.

For the second class, caching is wrong. The contract tells the client "retryable: true", the client retries (reusing the key, as idempotency requires), and `beginOrResolve` returns `replay` of the frozen failure — forever, until `expires_at` (derived from `boundary.idempotencyRetentionHours`, default **168h**). The one execution the wrap allows was a failure that resolved nothing, and the key is now permanently poisoned for that logical request.

`deprovision_venue_account` is the concrete case flagged: it is `write-database` (side-effecting), so it goes through the wrap, and its own failure modes include transient faults (`provision.persist_failed` from a caught DB error, `provision.db_unavailable`, plus context-factory `precondition.not_ready`). A deprovision whose first attempt hit a DB blip can never be retried under the same key — the owner is stuck unable to offboard their venue account via that request until the retention window lapses.

This is a bug, not a feature: the boundary emits `retryable: true` and then makes the retry a no-op that returns the same failure.

---

## 2. Background a fixer needs

### 2.1 The side-effecting idempotency wrap

`ToolInvocationDispatcher.dispatchSideEffecting` (`packages/boundary/src/dispatcher.ts`, ~L413):

```
fingerprint → invocationStore.beginOrResolve(...)
  conflict     → validation.invalid_payload
  in_progress  → inProgressStatus(identity)        // no second side effect
  replay       → return begin.terminalResponse     // do NOT re-run the tool
  started      → mapped = executeAndMap(...);       // the single execution
                 invocationStore.complete({ terminalResponse: mapped });  // store ANY mapped result
                 return mapped;
```

The doc-comment on the method states the intent explicitly: *"a caught execute error STILL completes the row terminally (never leaves it stuck `in_progress`)."* That hygiene goal is right — a thrown tool must not strand the row `in_progress`. But the implementation over-reaches: it persists **every** `mapped`, including failures that are explicitly retryable, so `complete()` turns a transient failure into a terminal replay.

### 2.2 How a failure becomes `retryable: true`

`mapToolResult` (`dispatcher.ts`, ~L167) maps a tool `ToolResult` onto the closed failure union:
- `errorCode === 'rate_limit'` → `rate_limit.exceeded`, **retryable `true`**.
- `errorCode === 'precondition.not_ready'` → `precondition.not_ready`, retryable = `result.retryable === true`.
- `result.retryable === true` → `upstream.transient`, **retryable `true`**.
- `result.fault === false` → `validation.invalid_payload`, retryable `false` (non-retryable content failure).
- otherwise → `internal.non_retryable`, retryable `false`.

And the context-factory failure path in `executeAndMap` (~L503) returns `precondition.not_ready` with **retryable `true`** when the trading context cannot be assembled (subject-resolution/db hiccup).

So three distinct terminal shapes carry `retryable: true`. All three are currently cached-and-replayed by the wrap.

### 2.3 The store has no concept of "don't cache this"

`BoundaryInvocationRepository.complete` (`packages/db/src/boundary-invocation-repository.ts`, ~L205) unconditionally sets `state='terminal'` + `terminalResponse=<mapped>` (guarded only so it transitions from `in_progress` once). `beginOrResolve` (~L138) returns `replay` for any row whose `state === 'terminal'`, regardless of whether the stored response is a success or a retryable failure. The schema (`packages/db/src/schema/boundary-invocations.ts`) stores `terminalResponse` as opaque jsonb with `state ∈ {in_progress, terminal}` — there is no "failed-retryable" state and no path that clears such a row before `expires_at`.

### 2.4 The retention window

`expires_at = now + retentionMs`, where `retentionMs = idempotencyRetentionHours * 3_600_000` and `idempotencyRetentionHours` defaults to `DEFAULT_IDEMPOTENCY_RETENTION_HOURS = 168` (`packages/boundary/src/config.ts`). So a poisoned key stays poisoned for a week by default.

---

## 3. Why this is wrong (reasoning)

Idempotency keys exist so a client **can** safely retry a side-effecting call: reuse the key, and the server guarantees at-most-one side effect. The correct client behaviour on a `retryable: true` answer is therefore to **retry with the same key** (a fresh key would defeat the dedupe and risk a double side effect on the attempt that actually succeeds server-side).

The wrap breaks that contract in the one case it matters:
- First attempt: tool runs, hits a transient fault, **no side effect**, maps to `upstream.transient` / `rate_limit.exceeded` / retryable `precondition.not_ready`.
- `complete()` stores it terminal.
- Retry (same key): `beginOrResolve → replay` returns the frozen failure. Tool never re-runs. The transient condition may have cleared seconds ago; the client can never find out under this key.

The result is a self-inflicted permanent failure for a request that was supposed to be retryable, lasting up to the full retention window.

Contrast the cases that are **correct** to cache: a success (replay avoids a duplicate delete/insert), and a non-retryable content failure (`not_found.resource`, `provision.in_use`, `validation.invalid_payload`) — these are authoritative answers about the request itself and will not change on retry, so replaying them is right and even desirable.

---

## 4. Root cause

`dispatchSideEffecting` persists the mapped result for **all** terminal outcomes, and the store has no notion of a non-authoritative (retryable, no-side-effect-happened) failure. A retryable failure is neither a durable outcome nor a committed side effect, so it must not occupy the idempotency slot as a replayable terminal. The row should instead be released (or marked retryable-failed and ignored by `beginOrResolve`) so the next same-key attempt re-executes.

A secondary, latent issue: the `catch` around `complete()` comments that on a persistence-only failure "the row stays `in_progress` and reconciles later via retention/retry" — but a row left `in_progress` makes every same-key retry return `in_progress` (the "still running" path) until `expires_at`, which is a *different* flavour of the same poisoning. The fix should make retry behaviour coherent across both the mapped-failure and the complete-failure paths.

---

## 5. Required behaviour after the fix

These are the **what**; implementation is the fixer's call, each checked in review.

### R1. A retryable failure must not be stored as a replayable terminal
- When the single execution yields a failure with **`retryable: true`** (today: `upstream.transient`, `rate_limit.exceeded`, and `precondition.not_ready` when retryable), the idempotency row must **not** be left in a state that causes a later same-key call to `replay` the failure. Either delete the row, or transition it to a distinct non-replayable state that `beginOrResolve` treats as "no prior terminal → start fresh".
- The side effect provably did not commit for these outcomes (the tool returned a transient fault before/without committing, or the context never assembled); re-execution on retry is safe and is the intended behaviour.

### R2. Authoritative outcomes must still be cached and replayed exactly as today
- A **success** must still be persisted terminal and replayed on same-key retry (no duplicate side effect). This is the whole point of the store — do not regress it.
- A **non-retryable** failure (`retryable: false`: `validation.invalid_payload`, `internal.non_retryable`, `not_found.resource`, `provision.in_use`, etc.) must still be persisted terminal and replayed. These are authoritative answers about the request; replay is correct.

### R3. No invocation may be stranded such that same-key retries are permanently blocked before `expires_at`
- Neither a mapped retryable failure (R1) nor a post-side-effect `complete()` persistence failure may leave a row that makes every same-key retry return `in_progress`/`replay` until retention lapses. The retry path must either re-execute (retryable failure, no side effect) or safely replay the committed result (side effect happened). Define and implement the behaviour for the "side effect ran but `complete()` failed" case explicitly (see R5).

### R4. The single-side-effect guarantee is preserved
- The fix must not open a window for a **double side effect**. In particular, do not naively "re-run on any stored failure": a stored *non-retryable* failure or a *success* must never re-execute. Only outcomes where the side effect provably did not commit (the retryable class) may clear the slot for re-execution. Concurrency (the per-key `pg_advisory_xact_lock` in `beginOrResolve`) must still serialize racing retries so exactly one execution is in flight per key.

### R5. The post-execution `complete()` failure path must be coherent
- Today a `complete()` DB failure after a **successful side effect** swallows the error and leaves the row `in_progress`, so same-key retries get `in_progress` forever (until retention). Decide and implement a correct behaviour: e.g. the status endpoint / a reconciliation sweep can resolve it, or `complete()` is made resilient (retry the persist), or the row carries enough to detect "side effect done, persist pending". Whatever is chosen, a client retrying the same key after a committed side effect must **not** be told `in_progress` indefinitely and must **not** cause a second side effect. Document the chosen semantics.

### R6. Values stay operator-config-driven; no new magic numbers
- If the fix introduces any new timing (e.g. a short "retryable-failed" grace/TTL distinct from the 168h terminal retention, or a sweep interval), it must come from `BoundaryConfig` (Zod schema in `packages/boundary/src/config.ts`, env-plumbed in `bin.ts` as the existing `idempotencyRetentionHours` is), never hard-coded (005 rule). If an env var is added, update the matching `.env*.example` twin in the same change (per `AGENTS.md`).

---

## 6. Must not regress

1. **Success replay / single side effect.** A retried successful `deprovision_venue_account` / `provision_venue_account` / `create_bot` / `submit_decision` under the same key still returns the stored success and runs the side effect exactly once.
2. **Non-retryable failure replay.** `not_found.resource`, `provision.in_use`, `validation.invalid_payload`, `internal.non_retryable` under the same key still replay the stored failure (no re-execution).
3. **Conflict path.** Same key, *different* request fingerprint → still `validation.invalid_payload` ("idempotency key reused with a different request").
4. **In-progress path.** A genuine concurrent retry while the first execution is still running → still `in_progress`, no second side effect. The per-key advisory lock still serializes.
5. **Read-only tools bypass the store.** `isSideEffecting(tool) === false` tools still execute directly and never touch the idempotency store.
6. **Row hygiene.** No execution path leaves a row stuck `in_progress` *because of* the fix; `complete`'s `state='in_progress'` guard (idempotent complete) is preserved or improved, not removed.
7. **Dependency direction.** `@traderton/db` must not gain a dependency on `@traderton/boundary`; `terminalResponse` stays `Record<string, unknown>` (the boundary interprets retryability, or the repo is told via a typed flag/param — do not import boundary types into db).
8. **Status endpoint.** `findByRequestId` / the F2b status lookup still works and never executes a tool. If R1 deletes/retires rows, decide what status returns for a since-cleared retryable failure (likely `not_found.resource`, consistent with "no record") and state it.
9. **Strict TS.** No `any`, `@ts-ignore`, `as unknown as`. `pnpm lint` passes.

---

## 7. Acceptance criteria

- [ ] R1–R6 implemented.
- [ ] Every item in §6 holds.
- [ ] A retried side-effecting tool whose first attempt returned a retryable failure (transient fault / throttle / retryable precondition) **re-executes** on the same-key retry and can succeed — demonstrated by a test.
- [ ] A retried side-effecting tool whose first attempt succeeded, or returned a non-retryable failure, still **replays** (no re-execution) — demonstrated by tests.
- [ ] Any new config value is in `BoundaryConfig` + Zod + `bin.ts` env plumbing (and `.env*.example` if an env var was added). No hard-coded durations.
- [ ] Any schema/state change has a Drizzle migration under `@traderton/db` and a matching schema update.
- [ ] Every test in §8 added and passing. `pnpm lint`, `pnpm build`, and `pnpm test` for `packages/boundary` and `packages/db` all pass (plus the DB integration suite if the repo changed).
- [ ] This report updated: Status → FIXED, with a **Fix** section (files changed, chosen semantics for R1/R5), a **Verification** section (commands + outputs), and any deviations with reasons.

---

## 8. Required tests

Test names describe behaviour, not implementation (repo rule).

**Dispatcher wrap (R1, R2, R4)** — `packages/boundary/src/dispatcher.test.ts` (or nearest existing dispatcher test)
1. "re-executes a side-effecting tool on same-key retry when the first attempt returned a retryable upstream.transient failure".
2. "re-executes on same-key retry when the first attempt returned rate_limit.exceeded".
3. "re-executes on same-key retry when the first attempt returned a retryable precondition.not_ready (context factory unavailable)".
4. "replays the stored success on same-key retry and does not run the side effect twice".
5. "replays a stored non-retryable failure (validation.invalid_payload / not_found.resource / provision.in_use) on same-key retry without re-executing".
6. "returns in_progress (no second side effect) while the first execution is still running".
7. "returns conflict for the same key with a different request fingerprint".

**Idempotency repo (R1, R3, R5)** — `packages/db/src/boundary-invocations.integration.test.ts`
8. "a retryable-failed invocation does not resolve as a replayable terminal on the next beginOrResolve for the same key" (row deleted or in the non-replayable state → next call returns `started`).
9. "complete still transitions only an in_progress row to terminal and is idempotent on a double-complete".
10. If a new state/column is added: "beginOrResolve treats a <retryable-failed> row as no prior terminal and starts fresh".
11. R5 behaviour: "a side effect that committed but whose complete() persist failed does not block a same-key retry indefinitely and does not cause a second side effect" (model the chosen resolution: resilient complete, sweep, or status-driven).

**deprovision end-to-end (regression, the flagged case)** — tool/boundary integration
12. "a deprovision_venue_account that first failed with provision.persist_failed (transient) can be retried under the same idempotency key and then succeeds".
13. "a deprovision_venue_account that first failed with provision.in_use replays in_use on same-key retry (authoritative, not re-executed)".

If the replay-vs-reexecute decision is awkward to drive through the full dispatcher, extract a small pure predicate (input: the mapped terminal result / its retryability; output: `cacheAsTerminal | releaseForRetry`) and unit-test it directly, keeping the wrap thin.

---

## 9. Out of scope (note in the Fix section if relevant)

- Changing the default retention window (`idempotencyRetentionHours = 168`). The bug is caching the *wrong class* of outcome, not the window length.
- Client-side retry policy / backoff in `@herobids` (the external-backend client). This report is about the server not poisoning the key; how the consumer schedules retries is separate.
- Reworking the fingerprint algorithm or the four-tuple key.
- The `check_regime` rate-limit telemetry mapping (004 decision-log item) — already handled; referenced here only because `rate_limit.exceeded` is one of the retryable codes that must stop being cached.

---

## 10. Related code

- `packages/boundary/src/dispatcher.ts` — `dispatchSideEffecting` (~L413: `beginOrResolve` branch + unconditional `complete` of `mapped`), `mapToolResult` (~L167: which codes carry `retryable:true`), `executeAndMap` (~L489: context-factory `precondition.not_ready` retryable:true; thrown tool → `internal.non_retryable`).
- `packages/db/src/boundary-invocation-repository.ts` — `beginOrResolve` (~L138: `state==='terminal'` → `replay`), `complete` (~L205: stores any `terminalResponse`), advisory lock.
- `packages/db/src/schema/boundary-invocations.ts` — `state ∈ {in_progress, terminal}`, `terminalResponse` jsonb, `expires_at`, unique key index.
- `packages/boundary/src/config.ts` — `idempotencyRetentionHours` / `DEFAULT_IDEMPOTENCY_RETENTION_HOURS = 168`.
- `packages/boundary/src/bin.ts` — store wiring, `retentionMs` derivation, `BOUNDARY_IDEMPOTENCY_RETENTION_HOURS` env.
- `packages/worker/src/tools/provisioning.ts` — `deprovision_venue_account` failure codes (`provision.persist_failed` fault:true, `provision.db_unavailable`, `provision.in_use` fault:false, `not_found.resource`).
- `packages/boundary/src/result.ts` — `successResult` / `failureResult` / `inProgressStatus` shapes.
