# Bug Report: `submit_decision` Zod schema did not declare `venueAccountId` — the boundary dispatcher stripped the consumer's venue hint, so every decision failed subject resolution as "ambiguous"

- **Status:** FIXED
- **Severity:** High (every agent `submit_decision` from the herobids consumer was rejected at the boundary with `precondition.not_ready "trading context unavailable"` — agents could not trade at all; no fills/positions/journal, even in shadow mode)
- **Date:** 2026-09-17
- **Discovered by:** Post-session agent evaluation (tintel agent, herobids@gmail.com owner) — see the herobids companion report `herobids/docs/bug-reports/2026/09/17/001-agent-trading-context-unavailable-decisions-rejected.md`.

## Summary

herobids (the L3c consumer) resolves the concrete venue account off its connection grant and threads `venueAccountId` into the `submit_decision` **payload** (D2: the subject stays `ownerId` + `actor`; the venue account rides as a per-operation payload arg). The traderton `SubmitDecisionParamsSchema` did not declare that field. The boundary dispatcher validates the payload against the tool's Zod schema and forwards the **parsed** result — so Zod **stripped the unknown `venueAccountId` key** before the context factory / subject resolver ever saw it.

The resolver then fell back to per-owner default venue-account resolution. The owner had **two** venue accounts (hyperliquid + 1inch) and `bin.ts` wires no `getDefaultVenueAccountId` port, so resolution returned:

```
{ ok: false, code: 'precondition.not_ready', message: 'no default venue account for owner (ambiguous)' }
```

`bin.ts:262–264` throws on a failed resolution; `dispatcher.ts:495` flattens the throw into the opaque `precondition.not_ready / "trading context unavailable"` (leaking nothing over the boundary — intentional, but previously also **discarding the cause internally**, which made this undiagnosable from artifacts).

## Root cause

`packages/worker/src/tools/trading.ts` — `SubmitDecisionParamsSchema` omitted `venueAccountId` while:

- the L3c consumer contract (`herobids/apps/worker/src/agents/decision-boundary-mapping.ts:45`, `buildSubmitDecisionPayload`) legitimately sends `venueAccountId` as a payload arg;
- the subject resolver (`packages/boundary/src/subject-resolver.ts:79`, `venueAccountIdOf`) is **designed** to read it from the validated payload;
- `create_bot` already declares the identical consumer-supplied hint (`bots.ts:56`), and `instantiate_bot` requires it (`bots.ts:1012`) — the schema convention for resolver-read fields exists and `submit_decision` simply missed it.

The generic Zod-object behaviour (strip unknown keys) turned a schema omission into a silent drop — no validation error, no log; the decision just failed one layer later with a message that looked like an infrastructure problem.

## Fix

1. **`packages/worker/src/tools/trading.ts`** — add to `SubmitDecisionParamsSchema`:
   `venueAccountId: z.string().optional().transform(v => v === '' ? undefined : v).describe(...)` (same shape as `create_bot`'s). The tool's `execute` never consumes it (the resolver already ran by then); the declaration exists purely so the value survives the dispatcher's `payloadParse` into the context-factory request.
2. **`packages/boundary/src/dispatcher.ts`** — the `executeAndMap` catch now logs the context-factory failure **internally** (`logger.error` with toolName/ownerId/actorId/requestId/correlationId) before returning the unchanged opaque `precondition.not_ready "trading context unavailable"` over the wire. The boundary-leak posture is preserved; internal diagnosability is restored.
3. **`packages/worker/src/index.ts`** — re-export `createLogger` from the worker barrel so the boundary (which already depends on `@traderton/worker`) can use the shared pino factory without a new dependency.

## Files changed

- `packages/worker/src/tools/trading.ts` — schema fix
- `packages/boundary/src/dispatcher.ts` — internal logging of the swallowed cause
- `packages/worker/src/index.ts` — `createLogger` re-export
- `packages/worker/src/tools/trading.test.ts` — 4 regression tests (hint preserved; empty string → undefined; optional; non-string rejected)
- `packages/boundary/src/subject-resolver.test.ts` — regression test: supplied `venueAccountId` wins with 2 accounts + no operator default
- `packages/boundary/src/app.test.ts` — dispatcher-level regression tests: undeclared key stripped before the factory (bug shape); declared key survives

## Verification

- `pnpm lint` clean (`tsc --noEmit`).
- Full traderton unit suite: **2660 passed | 45 skipped** (10 skipped files are DB-integration) — no regressions.
- The new resolver test pins the exact bug scenario: owner with `[va-1, va-2]` + no `getDefaultVenueAccountId` + payload `{ venueAccountId: 'va-1' }` → `ok: true, injection.venueAccountId: 'va-1'` (previously: `precondition.not_ready`).
- The new dispatcher tests pin both shapes: `write_thing` (`z.object({})`) strips the hint; a schema that declares the key forwards it intact.

## Phases 2 & 3 — further gaps uncovered by the live verification (same day, same report)

The schema fix was verified live on a clean-slate cross-stack run (`herobids/scripts/shell/run/reset-and-run-xstack.sh`, which reproduces the original ambiguous setup: one owner with hyperliquid + 1inch venue accounts). Two further gaps surfaced, each one layer deeper. Both are fixed in the same working tree.

### Phase 2 — the agent-direct actor was never registered (`instance_not_running`)

With the hint flowing, live `submit_decision` passed subject resolution and failed at `submitDecision`'s FIRST guard (`decision-intake.ts:104-111`): `instance_not_running` / "No execution context — ensure the actor is active and running". Item C's `constructAndRegisterAgentActor` had **NO production caller** — its own doc comment defers the lifecycle to "item D / the M1 consumer", but that consumer (herobids' in-process `AgentSessionManager`) was deleted by herobids L3d-5, and the M2 boundary (`bin.ts`) never registered an agent actor (`instanceLoader` rehydrates bots only; the verification integration test stubs `submitDecision`, so the gap survived L3 verification).

**Fix (`packages/boundary/src/bin.ts`):** `buildAgentDirectActorEnsure(runtime)` — on the first venue-resolving agent invocation per `(ownerId, actorId, venueAccountId)`, the boundary constructs + registers + **STARTS** the `AgentTradingActor` (start required: the second intake guard at `:121` is only reachable post-start). In-flight promise cached per tuple; failed starts evict + tear down the half-started actor (`stopAndDeregisterAgentActor`) so the next attempt reconstructs.

### Phase 3 — platform capital was never injected (`risk.daily_max_loss_exceeded`, $0.00 limit)

With the actor running, live `submit_decision` reached the engine risk gate — the decision **persisted in `decisions`** — and was rejected: `Daily loss limit reached: $0.00 realized (limit: $0.00)`. `risk-gate.ts:118-122`: `dailyLossLimit = equity × dailyMaxLossPct/100`; `equity = capital + P&L` (`EquityTracker`). The actor was constructed with `capital: null` → equity 0 → limit 0 → every decision rejected. `AgentActorSpec.capital/riskPosture/riskOverrides` are documented INJECTED consumer values (`decision-intake.ts:333`), but no channel carried them — and the boundary process cannot read the consumer's `agents` table (locked: "NEVER an `agents` row", 017 §4 / 019 §1).

**Fix (both repos — the injection lives at the call site per 005's M2-adapter contract):**

- `packages/worker/src/tools/trading.ts`: schema declares consumer-injected `capital` / `riskPosture` (domain `RiskPostureSchema`) / `riskOverrides`. Post-LLM platform values — the LLM never sees or supplies them; they cross inside the HMAC-signed payload (trust anchored in the consumer identity, same class as `maxBotsOverride`).
- `packages/boundary/src/subject-resolver.ts`: `agentRiskSpecOf(payload)` (defensive extraction — non-numeric override values dropped) → `ResolvedInjection.agentRiskSpec` on both no-bot paths.
- `packages/boundary/src/bin.ts`: the ensure consumes the spec. Cache policy: keyed by `(ownerId, actorId, venueAccountId)`, never by the values. `capital`/`riskPosture` CHANGED → stop + deregister the old actor FIRST, then reconstruct fresh — these anchor the `EquityTracker` peak at construct time (`agent-trading-actor.ts:2953`); the `DailyLossTracker` rehydrates from traderton's own fills so loss history survives (matches M1: a capital change ≈ a new session).
- herobids: `buildSubmitDecisionPayload` gains `AgentRiskInjection`; the decision handler injects `agent.capital/risk/riskOverrides` from the already-loaded row (zero extra queries); the approval path injects the agent's **CURRENT** values via a new `agentRiskResolver` dep (environment state, not a snapshot — the risk gate protects the account as it exists at execution time).

### Live result (clean slate)

Boundary log: `agent-direct actor constructed + started … mode:paper, capital:"1000.00000000"`. traderton state after one tick: `decisions=3, fills=3 (shadow: HYPE 2.5 @ 82.39, SOL 3 @ 101.50, ZEC 0.35 @ 1482.69), positions=3 open longs, journal_events=15`. Previously: all 0.

## Verification (phase 2–3)

- Per-package `tsc -p packages/boundary` + `-p packages/worker`: clean. (Root `pnpm lint` has a build-cache blind spot — it passed while Docker's `tsc --build` failed on an earlier edit; always verify per-package before shipping.)
- Full traderton suite: 2660 passed | 45 skipped, including the new risk-spec regression tests (resolver extraction ×4, schema survival ×5).


## Side effects / notes

- The now-declared `venueAccountId` appears in the LLM-facing JSON Schema produced by `convertZodToJsonSchema`. That is **desirable** (it matches the resolver's contract and documents the per-operation venue hint), and mirrors `create_bot`'s exposure of the same field. If an operator prefers hiding it from LLMs, that is a tool-spec presentation concern, not a resolver one — the resolver must keep seeing it either way.
- The idempotency `requestFingerprint` now hashes payloads that include `venueAccountId` — correct (the hint is part of the request semantics); a replay with a different account is (rightly) a `conflict`.
- herobids required **no change** — its side was already correct end-to-end.

## Follow-ups (not blocking; recorded for L3-Rx / backlog)

1. **`ownerMode` defaults to `paper` for agent subjects** — `resolveNoBotOwnerMode` reads `ports.getDefaultOwnerMode?.(ownerId) ?? 'paper'` and `bin.ts` wires no `getDefaultOwnerMode`, so `ctx.executionMode` at the boundary is always `paper` for agent-subject invocations. Symptom observed in the session: `get_account_summary` reported `executionMode: "paper"` while the agent is configured `shadow`. `ownerMode` is only the mode-escalation ceiling (it does not drive execution), but it should reflect the operator/consumer-configured mode. Track under the existing L3-Rx per-tool venue/mode-signal plan.
2. **Boundary `get_account_summary` platform-ops gap** — the traderton copy of the tool reports `risk_contract_unavailable / agent_config_unavailable / agent_repo_unavailable` because the boundary context factory supplies `botRepo` but not `riskContractOps`/`executionConfig`/`agentRepo` (herobids-owned values that intentionally do not cross the boundary). The tool degrades gracefully (`riskLimits: 'unavailable'`, guidance text), but the agent-visible answer is degraded by design. Either (a) enrich the boundary context with traderton-owned equivalents (risk contract for the injected owner; execution mode from `injection.ownerMode`), or (b) accept + document the degradation. Owner: traderton composition (`bin.ts`) + `packages/worker/src/tools/account.ts`.
3. **Consider logging subject-resolution failures before the throw** — `bin.ts` wraps `resolveSubjectInjection` failures in a plain `Error`; with the dispatcher now logging the caught cause, the resolver's typed `code`/`message` (e.g. "no default venue account for owner (ambiguous)") appear in boundary logs. A debug-level log of the resolver outcome (supplied hint present/absent, account count) would make this class of failure trivially self-diagnosing.

## References

- `packages/worker/src/tools/trading.ts` — `SubmitDecisionParamsSchema` (fixed)
- `packages/boundary/src/dispatcher.ts` — `executeAndMap` (`payloadParse` at :346–356 forwards `payloadParse.data`; the catch that previously discarded the cause)
- `packages/boundary/src/subject-resolver.ts` — `venueAccountIdOf` (:79), supplied-hint branch (:266–290), ambiguity fallback (:297–307)
- `packages/boundary/src/bin.ts` — context factory + `resolverPorts` (no `getDefaultVenueAccountId` wired)
- `packages/worker/src/tools/bots.ts` — `create_bot`'s `venueAccountId` declaration (:56) and `instantiate_bot`'s required one (:1012)
- herobids companion: `herobids/docs/bug-reports/2026/09/17/001-agent-trading-context-unavailable-decisions-rejected.md`
