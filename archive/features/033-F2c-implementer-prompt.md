# 033 — F2c Implementer Prompt (M2 REST boundary — the runnable stack, the dev signing helper, and the 7 required-verification tests)

**Status:** ready to hand to an implementer. On branch `f-m2-rest`.
**Task:** the F acceptance slice — a fresh minimal compose stack (boundary + Postgres + Redis), a committed
dev HMAC signing helper, a trading-only `config/default.yaml`, and the **7 required-verification tests**
(005 §"Required Verification") wired against the real stack. This is the F acceptance gate (013 §8.1.1 D5,
030 §6). **F is complete after F2c.**
**Authoritative brief:** [005 §Required Verification + §Deployment And Health](../../docs/005-consumer-boundary-contract.md)
+ [013 §8.1.1](./013-9b-authoring-plan.md) (D5) + [030 §6](./030-F2-m2-rest-proposal.md).
**Depends on:** F1 (shell), F2a (`@traderton/db` store, live-PG proven), F2b (dispatcher integration) — all
DONE on this branch.

---

## 0. Orient first

You are in **Traderton** (`/Users/chinomso.ikwuagwu/dev_ai/traderton`), branch `f-m2-rest`. The boundary
(`packages/boundary`, `@traderton/boundary`) is complete through F2b: HMAC auth, envelope/version validation,
the `tools:invoke` dispatcher with deadline + idempotency + the opened side-effecting gate + the status
endpoint + a real `TradingToolContext` factory (`bin.ts` → `createTradingRuntime` + `createDriveTarget`). All
F1/F2a/F2b tests use FAKES. **F2c makes it real:** stand the stack up and prove the 7 verification tests
against live Postgres + Redis.

**The law (AGENTS.md):** copy-never-author. `../herobids` is READ-ONLY. F2c authors **test + ops scaffolding**
(compose, a signing helper, tests) — no trading behaviour. The ONE piece of copied-not-authored config is the
trading `config/default.yaml` (§3, flagged).

## 1. What F2c delivers

1. A trading-only **`config/default.yaml`** so the boundary process can `loadConfig()` (§3).
2. A fresh minimal **docker compose** stack: the boundary + Postgres + Redis (§4, D5).
3. A committed **dev HMAC signing helper** (§5) — signs `tools:invoke` + status requests per 005's canonical
   string, so the verification tests (and manual use) can make real signed calls.
4. The **7 required-verification tests** (§6) as `DATABASE_URL`/`REDIS_URL`-gated integration tests, plus a
   **runner** that applies migrations then runs them (§7).

## 2. Preflight — a real gap you MUST resolve first

**Traderton has NO `config/default.yaml`.** `config/` holds only `strategy-presets/`. The boundary's
`bin.ts` calls `loadConfig()` (no arg) → resolves the monorepo `config/` dir → `default.yaml`, which does not
exist, so the boundary **cannot boot today**. (The worker config tests pass a temp dir; nothing provides the
real file.) F2c must add it — see §3. Verify this yourself (`ls config/`, read
`packages/worker/src/config.ts` `loadConfig`) before starting.

## 3. `config/default.yaml` — COPY-ADAPT from herobids (do NOT author fresh)

herobids has `../herobids/config/default.yaml` (READ-ONLY). Traderton's `AppConfigSchema` is the **trimmed
trading-only** schema (Phase 1 deleted the platform keys — billing/auth/llm/alerts/etc.). So:

- **Copy** `herobids/config/default.yaml` and **trim it to the keys Traderton's `AppConfigSchema` accepts**
  (the same fused-file line-trim Phase 1 applied to the schema + the config loader — see the config rows in
  [003](../../docs/003-anomalies-and-deviations.md)). Delete the platform blocks; keep the trading blocks
  (`database`, `redis`, `reconciliation`, `streams`, `venues`, `marking`, `backtesting`, `liveRollout`,
  `marketData`, `agentRiskDefaults`, `execution`, `simulation`, `marketDataRecording`, etc. — whatever
  `AppConfigSchema.parse` requires). The proof it is correctly trimmed: `loadConfig()` parses it without a
  Zod error, and the boundary boots.
- This is operator **config (VALUES)**, not trading behaviour — trimming platform keys is a mechanical
  divergence (Phase-1 technique), not authoring. Keep it 1:1 with the source's trading keys (diff = platform
  blocks removed). If a required trading key is genuinely absent from the source default, STOP and surface it
  rather than inventing a value.
- `database.url`/`redis.url` come from `DATABASE_URL`/`REDIS_URL` env overrides (the loader already maps
  them), so `default.yaml` can carry safe local defaults the compose overrides.

If trimming surfaces a key `AppConfigSchema` requires but that is hard to source, log it in
[003](../../docs/003-anomalies-and-deviations.md) and flag it — do not guess a trading value.

## 4. The compose stack (D5 — author fresh, minimal)

Author `docker-compose.yml` (or `compose.yaml`) at the repo root (or `packages/boundary/`):

- **postgres** (`postgres:16`, matching the F2a live-proof image) — user/pass/db as env; a healthcheck
  (`pg_isready`).
- **redis** (`redis:7` or similar) — a healthcheck (`redis-cli ping`).
- **boundary** — builds/runs the boundary process (`node packages/boundary/dist/bin.js`); env:
  `DATABASE_URL`, `REDIS_URL` (pointing at the compose services), `BOUNDARY_CONSUMER_ID`/`BOUNDARY_KEY_ID`/
  `BOUNDARY_SIGNING_SECRET`, `BOUNDARY_PORT`; `depends_on` the two with `condition: service_healthy`; expose
  the port. **The boundary needs the DB migrated before it serves writes** — the runner (§7) applies
  `db:migrate` before the boundary handles verification traffic (or an init step does).
- Keep it minimal and fresh — do NOT rebase the `l1-integration-harness` branch's compose (kept off main as
  YAGNI, per D5). This compose is the durable F artifact.
- **005 §Deployment And Health** framing: `/health/ready` should reflect real readiness (config + the store +
  Redis) — F2b's `/ready` currently returns a static `ready`; for the compose stack, wire it to a genuine
  readiness signal if cheap (e.g. a store ping), or document that test #7 asserts the process reaches a
  serving `/health/ready` after `depends_on` health. (Firming `/ready` beyond static is the F1 LOW — do the
  minimum test #7 needs; don't over-build.)

## 5. The dev HMAC signing helper (committed)

Author a small signing helper in `packages/boundary` (e.g. `src/dev/sign.ts` + a bin entry like
`traderton-boundary-sign`, OR a reusable `signRequest()` the tests import). It must produce the 005 canonical
string EXACTLY (see `auth.ts` / F1): `METHOD + "\n" + PATH + "\n" + X-Traderton-Timestamp + "\n" +
SHA256(rawBody)`, the `sha256=<hex>` signature, and all required headers including
`X-Request-Deadline-At` = `body.deadlineAt` and the `caller` object matching the headers. It signs both
`POST /internal/v1/tools:invoke` and `GET /internal/v1/invocations/:requestId` (empty-body GET). The
verification tests import this helper to make real signed calls; committing it also satisfies 030's "dev
signing helper" deliverable (the manual-test tooling F1 deliberately deferred). Keep it a thin, dependency-
light utility — it is ops/test tooling, not trading behaviour.

## 6. The 7 required-verification tests (005 §"Required Verification")

Author these as `DATABASE_URL`+`REDIS_URL`-gated integration tests (skip locally without them, like the item-E
+ F2a pattern), driving the REAL boundary app (via `app.inject` against a real `createBoundaryApp` wired to a
real store + a real-or-realistic context, OR against the running compose boundary over HTTP — your call;
`app.inject` with a real DB/Redis-backed store is lighter and sufficient for 1–6, test #7 needs the compose).
Map 1:1 to 005's seven items:

1. **valid signed calls succeed; invalid/expired/replayed/unauthorized signatures fail BEFORE execution** —
   a valid signed read-only call succeeds; a bad signature / wrong consumer / out-of-skew timestamp / a
   replayed-past-skew capture all fail `authentication.invalid_caller` and the tool never runs.
2. **malformed envelopes and payloads → typed validation failures** — unknown outer key, non-JSON body, bad
   payload → `validation.invalid_payload`; bad contractVersion → `contract.unsupported_version`.
3. **deadline expiry prevents side effects** — a request whose `deadlineAt` is already past → `deadline.expired`
   and the side-effecting tool does NOT run (assert no persisted effect).
4. **retrying a side-effecting call with the same key yields ONE persisted invocation and ONE downstream
   effect** — the KEY test. Use a **paper-mode side-effecting tool whose downstream effect is safe +
   observable** — RECOMMEND `create_bot` in paper mode: its downstream effect is exactly ONE persisted bot
   row (via the item-E `tryCreateBotWithLimit`). Fire the same signed request twice (same requestId +
   idempotencyKey); assert exactly ONE `boundary_invocations` row AND exactly ONE bot row (the second call
   replays the stored terminal result, no second bot). Do NOT drive a live venue — paper mode keeps it safe
   + deterministic. (If `create_bot` is awkward to drive end-to-end, pick another `execute-trade`/
   `write-database` tool whose effect is a single observable DB row; state which and why.)
5. **a different payload with the same key is rejected** — reuse the key with a changed payload →
   `validation.invalid_payload` (the fingerprint conflict), no second effect.
6. **readiness failure blocks new traffic without hidden fallback** — when `/health/ready` is false (e.g.
   the store/Redis dep is down), the consumer treats the service as degraded; assert no silent fallback path
   executes a side effect. (Model this at the boundary level — e.g. a store whose readiness probe fails →
   `/ready` false; assert the contract's "stop new write traffic" posture. Keep it honest: if F2c's `/ready`
   is static, this test asserts the documented behaviour + a store-unavailable → `precondition.not_ready`
   path rather than a fake.)
7. **compose or staging startup reaches a healthy `/health/ready`** — bring the compose stack up (or a
   scripted equivalent), wait for the boundary's `/health/ready` to return ready after Postgres+Redis are
   healthy + migrations applied. This is the one test that needs the actual compose.

Some of 1–2 overlap F1's authored tests — that's fine; the point is the 005 gate is proven against the REAL
store/stack, not fakes. Reuse the signing helper (§5) for all signed calls.

## 7. The runner (migrate → test)

Add an integration-test runner (a script + a package script, e.g. `test:integration`) that: starts (or
assumes) Postgres+Redis, applies `pnpm --filter @traderton/db db:migrate` against `DATABASE_URL`, then runs
the gated tests. Mirror the intent of the F2a live-proof flow (a throwaway `postgres:16` + `db:migrate` +
`vitest run`). Keep the default `pnpm test` UNCHANGED (the gated tests skip without `DATABASE_URL`/`REDIS_URL`
so CI's default run is unaffected — item-E/F2a discipline). Document how to run it (a short README or a
comment in the compose file).

## 8. Guardrails / stop-gates

- **Author no trading behaviour.** F2c is ops/test scaffolding + a copied-trimmed config. If a verification
  test needs a trading assertion, it asserts the ALREADY-BUILT behaviour, not new logic.
- **`config/default.yaml` is COPY-ADAPT** from herobids (trim platform keys) — not authored. Flag any
  required trading key you cannot source.
- **Paper mode for the side-effecting test** — never drive a live venue in a test. Test #4's "one downstream
  effect" is one persisted DB row in paper mode.
- **Do NOT change the default `pnpm test`** — the new tests are gated (skip without `DATABASE_URL`/`REDIS_URL`).
- **Do NOT merge to `main`** — the merge gate (herobids consumes the library; all tests pass; run local +
  staging a while; manual approval) is unmet; F2c landing green on the branch does not change that.
- **Fresh minimal compose (D5)** — do NOT rebase the `l1-integration-harness` compose.

## 9. Verification / done criteria

- `pnpm build` green, `pnpm lint` clean, default `pnpm test` green + UNCHANGED (new tests skip without the
  env gates).
- With `DATABASE_URL`+`REDIS_URL` set (compose up + migrated), the **7 verification tests pass** — report the
  run. If you can bring the compose up in this environment, do so and report; if not, report exactly what is
  needed to run it (the coordinator will execute the end-to-end run).
- Report: files added (config, compose, signing helper, tests, runner), how each of the 7 tests maps to 005,
  the paper-mode tool chosen for test #4 + why, and any seam/gap surfaced (esp. the `config/default.yaml`
  trim). Do NOT commit — the coordinator commits.
- **Then STOP** — F is complete after F2c. Do NOT merge; the coordinator runs the end-to-end stack proof and
  pauses for human review + the merge-gate steps.

## 10. Key file map

- NEW: `config/default.yaml` (copy-trim from `../herobids/config/default.yaml`), `docker-compose.yml`,
  `packages/boundary/src/dev/sign.ts` (+ bin/export), `packages/boundary/src/*.verification.integration.test.ts`
  (the 7), a `test:integration` runner/script.
- Reference (READ): `packages/worker/src/config.ts` (`loadConfig` — what `config/default.yaml` must satisfy),
  `packages/boundary/src/{auth,app,dispatcher,bin}.ts` (the canonical string + the endpoints + how bin wires
  the real runtime), `packages/db/src/bot-limit.integration.test.ts` + `boundary-invocations.integration.test.ts`
  (the gated-integration pattern), `../herobids/config/default.yaml` (COPY source),
  [005](../../docs/005-consumer-boundary-contract.md) (the 7 items + health semantics), [013 §8.1.1](./013-9b-authoring-plan.md),
  [030](./030-F2-m2-rest-proposal.md).
