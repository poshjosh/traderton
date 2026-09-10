# Improvement Backlog

**Status:** living
**Created:** 2026-09-08

## Purpose

A list of **deliberate, non-blocking future improvements** — the "later" branch of a fork we took the safe
or simple path on now. Each entry records what it is, why we deferred it, what it would take, and a grade,
so a future agent (or human) can triage without reconstructing the original conversation.

This exists because that class of decision had no home: it is neither a forced deviation nor a parity gap
nor a bug.

## What belongs here (and what does NOT)

**Belongs here** — an optional improvement where skipping it *forever* is acceptable, just not ideal. Usually
created when we chose "safe/simple now" over "better later" and want to remember the better path.

**Does NOT belong here:**
- **Cutover obligations** (must-do before cutover) → [001-parity-ledger.md](./001-parity-ledger.md) +
  [003-anomalies-and-deviations.md](./003-anomalies-and-deviations.md) as `Deferred (required for cutover)`.
  Rule of thumb: if skipping it forever would **degrade parity or block cutover**, it is NOT a backlog item.
- **Bugs / real defects** → fixed, or filed as a bug report. A defect is not an "improvement."
- **In-progress deferrals within an active phase** (e.g. an F1 item deferred to F2) → the phase plan / 003.
  Backlog items outlive any single phase.

## Grading

Each item carries two independent axes plus a risk flag:

- **Value** (High / Med / Low) — what we gain by doing it.
- **Effort** (High / Med / Low) — what it costs to do.
- **Risk-if-deferred** (High / Med / Low) — the danger of never doing it. For a true backlog item this is
  normally **Low** (if it were High it would be a 003 cutover obligation, not a backlog item). A Med/High
  here is a signal to re-home the item.

Triage heuristic: **High value / Low effort** floats to the top; **Low value / High effort** rarely gets done
(and that verdict is itself worth recording so nobody re-opens it).

## Backlog

| # | Item | What it is / why deferred | What it would take | Value | Effort | Risk-if-deferred |
|---|------|---------------------------|--------------------|-------|--------|------------------|
| B1 | **F2 idempotency: author-fresh replacement for the copy-adapted flow** | F2 D1 chose to **copy-adapt** herobids' fingerprint hasher + advisory-lock/dedupe flow (`blueprint-idempotency.ts` + the blueprints route), re-keyed to the 005 4-tuple. Copy-adapt is the safe, parity-honouring, law-abiding path. An author-fresh implementation purpose-built for the 005 4-tuple + `in_progress`/retention semantics *might* read cleaner if the copied shape becomes awkward under those deltas. | Replace the copied hasher + control flow with a purpose-built one; re-verify against the same F2 tests (behaviour must not change). | Low | Med | Low |
| B2 | **F2 deadline: literal per-side-effect re-check** | F2 D3 chose the **pragmatic** deadline check (reject pre-validation + one re-check immediately before `tool.execute`). 005's wording is "re-check before *every* downstream side effect." The literal reading would thread `deadlineAt` down into `create-trading-runtime`/`drive-target` — i.e. into copied-tool territory — for a per-side-effect check. Deferred because it enlarges surface and edges toward authoring in the core, for a benefit that only matters if a single invocation performs multiple sequential side effects past the deadline. | Plumb `deadlineAt` (a VALUE) through the drive path as a port; re-check before each enqueue/venue call; keep it a value, never trading logic. Revisit if a real multi-side-effect-per-invocation tool appears. | Low | Med | Low |
| B3 | **F2 authz: tighten Option B into a per-tool provenance allow-map (Option A)** | F2 D4 chose **Option B** — enforce "the asserted `actor.type` is one the operator configured this consumer to assert" (an operator-config VALUE), NOT an invented per-tool product-rule map. We avoided authoring speculative rules ("a bot can't create bots") because those are product decisions not yet made and have no herobids oracle. Once real per-tool provenance rules exist as a product matter, B can be tightened to a per-tool/per-category allow-map (Option A) — a stricter, tool-granular check. | Define the per-tool (or per-category) `actor.type` allow-map from real product rules; enforce in the dispatcher authz step; add tests. Only worthwhile once the rules are actually decided. | Med | Low | Low |
| B4 | **Boundary: consolidate the duplicated identity extractor** | `identityFor` (`packages/boundary/src/app.ts`) duplicates `identityFromRaw` (`packages/boundary/src/dispatcher.ts`) — both best-effort `{requestId, correlationId}` extractors. F1 CodeReviewer LOW-1. Harmless today; a drift risk if one changes and the other doesn't. | Consolidate into one helper in `result.ts`; point both call sites at it. | Low | Low | Low |
| B5 | **Boundary: `bin.ts` empty `allowedConsumers` should fail-closed** | `packages/boundary/src/bin.ts` warns (rather than refusing to start) when `allowedConsumers` is empty. Not exploitable — every request then fails `unknown consumer`, so the boundary is closed by default — but an operator misconfiguration starts a boundary that accepts nobody, silently. F1 CodeReviewer LOW-3 / 013 §8.5. | Fail-closed at startup (exit non-zero with a clear message) when no consumer is configured, unless an explicit "no-consumers" dev flag is set. Likely folded into F2's composition/config hardening. | Med | Low | Low |
| B6 | **F2a: narrow `BeginResult.replay.terminalResponse` type (drop the `\| null`)** | `beginOrResolve`'s `replay` variant types `terminalResponse: Record<string, unknown> \| null`, but a `terminal` row always has a non-null response — the `null` is a can't-happen case leaked to the F2b caller. F2a CodeReviewer LOW-1. Harmless; a minor type-tightening for the F2b integration. | Enforce non-null at the `terminal` transition (or narrow the type + assert), so F2b's status endpoint doesn't handle an impossible null. Best done as part of F2b when the caller is written. | Low | Low | Low |
| B7 | **F2b: source the swap/orderbook `venueType` classification from venue metadata, not hardcoded literals** | `subject-resolver.ts` `venueTypeFor` falls back to a hardcoded venue allow-list (`jupiter`/`1inch` → swap, else orderbook) when a bot config carries no explicit `venueType`. It is a fallback only (explicit config `venueType` wins), but a future swap venue would be silently misclassified `orderbook`, and the literals can drift from the `@traderton/venues` source of truth. F2b CodeReviewer M2. | Derive `venueType` from a single venue-metadata source (the venues package) rather than duplicated literals; keep the explicit-config path as the primary. Verify against real venue-account rows in F2c integration. | Med | Low | Low |
| B9 | **F2c: prune dev dependencies from the Dockerfile runtime stage** | The compose `Dockerfile` runtime stage is `FROM build` so `drizzle-kit` stays available for the one-shot `migrate` service — which means the boundary runtime image ships dev deps + build tooling. Fine for the F ops artifact (local/staging stack), but a leaner production image would separate the migrate tooling from the boundary runtime (multi-stage prune, or a dedicated migrate image). F2c CodeReviewer L2. | Split the migrate step into its own stage/image or `pnpm prune --prod` the runtime stage; keep the boundary runtime minimal. | Low | Low | Low |
| B8 | **Boundary: consolidate the third identity-extractor + revisit `bin.ts` casts / per-owner `sessionId`** | Grab-bag of F2b LOWs: `identityFromRaw` (dispatcher) still duplicates `identityFor` (app.ts) — same as B4, now three-ish call sites; `bin.ts` uses `as unknown as` double-casts for `redis`/`botRepo` (works, but hides future shape drift); `sessionId` is `boundary:${ownerId}` (stable per owner, not per invocation — fine unless a side-effecting tool namespaces Redis on `sessionId`, to confirm in F2c). F2b CodeReviewer L2/L3/L4. | Fold the identity extractor into `result.ts` (with B4); replace the double-casts with a typed adapter or a documented single cast; confirm no tool relies on `sessionId` uniqueness (else switch to requestId). | Low | Low | Low |

| B10 | **005 async result delivery: replace status-endpoint POLLING with push (webhook / SSE / stream)** | L3 D3 chose to map `submit_decision`'s synchronous 30s Redis BLPOP onto the 005 shape as **invoke → poll `GET /internal/v1/invocations/:requestId` to the deadline**. Polling is the simple, contract-native path (005 already defines the status endpoint) and is correct for the current agent path (an LLM already spent seconds reasoning; a poll loop is noise). Its shortcomings: wasted round-trips + latency granularity bounded by the poll interval; it does not generalize to low-latency or high-fanout result/event delivery; and it is a *pull* model where a *push* would be cleaner. A better path is a **push channel** — a consumer webhook the boundary calls on terminal outcome, or SSE/WebSocket/stream for results + the fills/marks/position-delta events. **Related but distinct:** the backend→consumer event/streaming channel already flagged as Open in [000](./000-vision.md) ("Open") + [004](./004-decision-log.md) — that is Traderton pushing *market/position events* out; THIS item (B10) is specifically the *invoke-result* delivery mechanism. They likely share transport and should be designed together. | Design a push result/event channel (webhook callback URL in the 005 envelope, or SSE/WS/stream); keep polling as the fallback + the ambiguous-timeout recovery path 005 already specifies. Coordinate with the 000/004 event-channel Open decision. Revisit if result latency or poll volume becomes a real cost (e.g. many concurrent side-effecting invocations, or a latency-sensitive consumer). | Med | Med | Low |

## Log conventions

- Add a row when you take a fork's safe/simple branch and the better branch is worth remembering. Grade it.
- When an item is done, strike it (or move it to a "Done" note) with the commit — do not silently delete it.
- If an item's Risk-if-deferred rises to Med/High, re-home it to 001/003 (it has become an obligation).
