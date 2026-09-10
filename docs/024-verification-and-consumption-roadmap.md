# 024 — Verification & Consumption Roadmap

**Status:** living (the current where-are-we tracker for post-M1 work).
**Created:** 2026-09-07.
**Peer of:** [009-extraction-roadmap.md](./009-extraction-roadmap.md). 009 governs **extraction** (getting
trading code out of herobids into `@traderton/*`, phases 1–10 — now essentially done through M1). **This
doc governs proving the extracted library is actually consumable, culminating in herobids consuming it.**
**Governed by:** [AGENTS.md](../AGENTS.md), [000-vision.md](./000-vision.md) (copy-never-author;
"herobids becomes a consumer"; not-weaker-than-herobids-today), the parity standard in
[001-parity-ledger.md](./001-parity-ledger.md), and the cutover gates in 001 (§Cutover Sign-Off).

## Why this document exists

M1 is code-complete (items A–E; see [013 §7.5](./features/013-9b-authoring-plan.md) + the 001 ledger).
But "code-complete + unit tests green" is **not** "consumable." Every test to date stubs the boundary it
exercises; **nothing has ever imported `@traderton/worker` and driven a real trade cycle against real
infrastructure.** The project's own law warns about exactly this — "the bar is feature parity with the
source, not 'does it run'" (AGENTS.md). So before the M2 REST boundary (item F) and before any cutover, we
must *prove* consumability by running the library as a consumer would, and *guarantee* it does not deviate
from herobids-today by differential comparison against a frozen reference.

This roadmap sequences that proof as four levels. It does not dictate each level's interior — like 009,
each level drafts its own detailed plan at its start, grounded in what is actually found.

## The reference oracle (how we guarantee "no deviation")

The guarantee mechanism is **differential comparison against a pinned herobids ref** — NOT a separate
copied repo. Rationale: a pinned git ref (a recorded herobids commit SHA at a known-good trading state)
*is* herobids-today by definition — zero drift, zero transcription risk, and inherently READ-ONLY (honours
the hard rule). A copied "reference repo" would itself be a copy that could differ from the original — the
exact failure mode we are guarding against.

- **Reference:** a recorded herobids commit SHA (pinned in this doc when L2 starts), checked out to a
  **git worktree** for side-by-side runs. Never written to.
- **Comparison:** drive both the reference and `@traderton/*` with identical inputs; assert identical
  trading outputs (plans, fills, positions, risk rejections, tool responses). "Does not deviate" = this
  differential passes.
- If the reference must advance (e.g. herobids ships a behaviour-preserving source-fix we depend on),
  re-pin to a new SHA and note it here.

## Ownership boundary (read this — it constrains what is ours to do)

AGENTS.md: **work only in `traderton`; herobids is READ-ONLY.** That draws a hard line through this roadmap:

- **Ours (in `traderton`):** L1 (the in-repo harness), L2 (the differential harness + capturing/pinning the
  reference), F (the M2 REST boundary, item F of 013), and the **migration spec** L3 needs (what herobids
  deletes, what it wires, the acceptance the branch must pass).
- **NOT ours (herobids-owner territory):** the actual **herobids `consume-traderton` branch** — herobids
  deleting its trading code, depending on `@traderton/*`, and merging to main (= cutover). That is editing
  herobids, which we never do; it is executed by the herobids owner, the same authority model as
  source-fix requests. We produce the consumable library + harness + spec; the owner executes the branch.

## The four levels

Legend: `Done` / `Active` / `Queued` / `Blocked (needs decision)`.

| Level | Proves | Owner | Depends on | Status |
|-------|--------|-------|-----------|--------|
| **L1 — in-repo integration harness** | `@traderton/worker` runs end-to-end vs real Postgres+Redis with **zero `@traderton/*` internals stubbed**: `createTradingRuntime` → create/start a paper bot → `submit_decision` → real plan/fill/position + the decision reply + a maxBots rejection at k+1. Falsifies "consumable end-to-end." | traderton (us) | M1 (done) | **Done (2026-09-07, branch `l1-integration-harness`)** — all 4 scenarios green vs real pg+redis. **Found + fixed a real consumability gap** (see below). |
| **L2 — differential guarantee vs the pinned herobids ref** | Same trading inputs → identical trading outputs across the pinned herobids reference and `@traderton/*`. The "does not deviate" guarantee; side-by-side via a git worktree. | traderton (us) build the harness; the reference is a read-only pin | L1 green | Queued |
| **F — M2 REST boundary** | The authored 005 boundary (Fastify/HMAC/idempotency/deadline + copy-adapted routes). Already scoped as **[013 item F](./features/013-9b-authoring-plan.md)**. | traderton (us) | M1 done; ideally L1 green first | Queued (last 9b item) |
| **L3 — herobids `consume-traderton` branch** | herobids deletes its trading code, consumes `@traderton/*` (via F's REST and/or in-process), passes the L2 differential + herobids' own suite; merges to main = **cutover**. | herobids owner executes; traderton (us) supply the migration spec + the passing library + the harness | F done + L2 green | Blocked (needs decision) — herobids-owner-executed |

## Per-level scope (detail is drafted at each level's start)

### L1 — in-repo integration harness (do first; the direct falsification)
- **Shape:** a new `@traderton/worker` integration test (or a tiny `examples/consumer` script) that acts as
  the consumer: real Postgres + Redis (docker or a provided local instance), `createTradingRuntime({config,
  redis, instanceLoader})`, no Traderton internals stubbed.
- **Must exercise the three seams no unit test has run together:** (1) composition under live infra
  (`createTradingRuntime` against real Postgres/Redis — the DATABASE_URL-gated tests skip locally today, so
  this has *never* run); (2) the drive-path round-trip (`publishToInbound(DECISION_SUBMIT)` → item-C
  `submitDecision` → engine → the `agent:decision:reply:*` reply the tool's `blpop` reads); (3) bot
  lifecycle + limit (`create_and_start` → `enqueueLifecycle` → `WorkerRuntime` starts an actor;
  the maxBots advisory lock serializes at k+1).
- **Assert real side-effects:** bot row `running`; a plan/fill/position persisted for a paper bot; the
  decision reply returned; a maxBots rejection at the limit.
- **Deliverable:** a green, repeatable end-to-end run + whatever wiring gaps it surfaces fixed as bugs
  (any deviation from parity goes through the normal review-fix loop, not silent). **This is the honest
  test of the "consumable end-to-end" claim** and should exist before F regardless.
- **Prereq:** a local/docker Postgres + Redis. (Confirm infra at L1 start.)

**OUTCOME (2026-09-07, branch `l1-integration-harness`).** Built per [025](./features/025-L1-integration-harness-proposal.md)
+ [026](./features/026-L1-implementer-prompt.md). Ran all four scenarios against real Postgres 16 + Redis 7
(docker compose, non-default ports). **Scenarios 1, 3, 4 passed immediately; scenario 2 exposed a real
HIGH consumability gap that 2315 unit tests missed** — vindicating the whole exercise: the
`create_and_start`/`start` drive paths enqueued a bot config **missing `venueAccountId`** (`BotConfigSchema`
strips it; the `bots` row carries it in a column, not the config JSON), so the BullMQ `start` job's
`ActorFactory` threw `no injected venueAccountId — refusing to start`. Fixed as wiring (the drive path now
stamps `venueAccountId` + `ownerId` onto the enqueued config — the values the factory reads), + a
regression guard in the default unit suite. Re-ran: **all 4 scenarios green.** Commits: `95c7c0c` (fix),
`68d67d0` (harness). Reviewed (CodeReviewer PASS; 2 MEDIUMs — a data-loss landmine in the harness infra +
the regression guard — fixed before merge). Default `pnpm test` stays 2315/21 (harness gated to skips);
`pnpm test:integration` runs the four green. **L1 converted "consumable end-to-end" from asserted to
demonstrated, and found the one gap that would have broken a real consumer.**

### L2 — differential guarantee vs the pinned herobids ref
- **Shape:** pin a herobids commit SHA (record it here); check it out to a git worktree; build a harness
  that drives *both* the reference trading path and `@traderton/*` with identical inputs and diffs the
  trading outputs.
- **Corpus:** reuse the copied parity fixtures + the backtesting replay corpora where they exist; add
  representative decision/bot scenarios (paper fills, risk-gate rejections, level validation, maxBots).
- **Deliverable:** a differential report showing identical outputs (or every difference explained + logged
  as a sanctioned Intentional Divergence — nothing silent). This is the guarantee that what we built does
  not deviate from herobids-today.

### F — M2 REST boundary
- Owned by **[013 item F](./features/013-9b-authoring-plan.md)** (the authored Fastify/HMAC adapter over the
  M1 ports, per [005](./005-consumer-boundary-contract.md); copy-adapt the quarantined `_deferred-authoring/
  api-routes/**`). Runs its own investigate→propose→coordinator-loop. This roadmap only tracks its place in
  the sequence; 013 §8 is the authority.

### L3 — herobids `consume-traderton` branch (the cutover)
- **What we produce (in traderton):** a **migration spec** — the exact herobids trading packages/app-slices
  to delete, the `@traderton/*` deps + boundary (F REST and/or in-process) to wire, and the acceptance the
  branch must pass (the L2 differential + herobids' own trading test suite, green).
- **What the herobids owner executes:** the branch itself (delete trading, consume `@traderton/*`), and —
  when fully functioning and differential-clean — the merge to main = cutover.
- **Feeds the 001 cutover gates:** "Consumer boundary contract validated," "Side-effecting parity
  validated," "Operational readiness passed," "Rollback path rehearsed."

## Sequencing

`L1 → (L2 ∥ F) → L3`. L1 is immediate and in-bounds. L2 and F are both unblocked by L1 and can proceed in
parallel (L2 needs no REST; F needs no differential) — do whichever the human directs first; the roadmap
does not force an order between them. L3 needs both F (its consumer surface) and L2 (its acceptance
guarantee), and is herobids-owner-executed.

## What this roadmap does NOT change

- The extraction phases (009) and their status — unaffected; 009 remains the extraction authority.
- The parity ledger (001) remains the source of truth for capability done/pending + the cutover gates;
  this roadmap feeds those gates, it does not replace them.
- The hard invariants (copy-never-author; work-only-in-traderton / herobids-read-only) — unchanged, and
  L3's ownership boundary above is a direct application of them.
