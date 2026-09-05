# Phase 0 — Subtraction Plan

**Status:** draft for review
**Created:** 2026-09-01
**Method:** copy-and-delete (see [000-vision.md](./000-vision.md))

This plan classifies the `herobids` monorepo into **copy / stay / cut-seam /
defer**, fixes the leaf-first delete order, and names the seams to stub. It is
the artifact to review before any code moves.

## Source layout (herobids)

```
packages/  backtesting db documents domain engine llm market-data strategy venues
apps/      api web worker
```

## Key finding — the data seam is small and clean

Contrary to the "70-table shared schema with cross-boundary FKs" worry, the
trading core tables are **already soft-linked**. `decisions`, `positions`,
`orders`, `fills`, `journal-events`, `decision-contexts`,
`reconciliation-events`, `balance-snapshots`, `instruments`, `execution-plans`
carry `botId` / `venueAccountId` / `actorType` / `actorId` as plain `text`
columns with **no `references()`**.

The **only** trading→platform hard FKs are the identity/grant seam:

| Table | FK → | Seam action |
|-------|------|-------------|
| `bots` | `users`, `venue_accounts`, `connections` | keep `venue_accounts`; convert `users`/`connections` to soft references |
| `venue_accounts` | `users` | convert to soft `ownerId` |
| `connections` | `users` | stays platform; replace the dependency with boundary-validated soft owner refs |
| `backtest-runs` | `users` | soft `ownerId` |

Heavy FK webs (`agents`, `sessions`, `skills`, `blueprints`, `billing`,
`chat`, `market-assessment`, `agent-*`) are **platform** — they stay behind.

## Classification

### COPY (trading core)

- **packages:** `venues`, `engine`, `market-data`, `backtesting`, the
  **mechanical slice** of `strategy` (`mechanical-strategy`, `dca-strategy`,
  `scan-engine`; NOT `llm`, `hybrid`, `llm-provider`),
  and the trading slice of `domain` (`trading/`, `values/`, `ports/venue.ts`,
  `ports/swap-venue.ts`, `ports/mark-source.ts`, `ports/strategy.ts`,
  `ports/candle-fetcher.ts`, `ports/token-safety.ts`, `ports/economic-calendar.ts`,
  `ports/sentiment.ts`, `result.ts`, `enums.ts`, `pagination.ts`,
   the `blueprint.ts` risk/execution/token-safety schema slice,
   `market-assessment.ts`, `scanner-types.ts`,
  `agent-risk-contract.ts`, `cost-profile.ts` minus billing).
- **db schema (trading cluster):** `bots`, `decisions`, `decision-contexts`,
  `decision-approvals`, `decision-failures`, `positions`, `orders`, `fills`,
  `execution-plans`, `journal-events`, `reconciliation-events`,
   `balance-snapshots`, `instruments`, `venue_accounts`, `user_credentials`,
  `backtest-runs`, `replay-corpora`, `replay-market-events`,
  `market-assessment-*`, `token-safety-overrides`, `datasets`.
- **db repositories** for the above.
- **apps/worker:** the trading loop only — actors, stream pool, scan loops,
  executors, reconciliation. (Extract from agent-session machinery.)
- **apps/api:** trading control-plane + tool endpoints only.
- **all copied tests** for the above (the parity harness).

### STAY (platform — do not copy)

`agents`, `sessions`, `users`(full), `connections`, `agent_connections`,
`skills*`, `blueprints*`, `chat*`, `agent-*`, `alert-deliveries`,
`oauth-identities`, `local-identities`, `user-*`; packages `documents`, `llm`,
the LLM strategy slice (`strategy/llm`, `strategy/hybrid`,
`strategy/llm-provider`), the agent runtime/session manager, messaging, web UI.

Note: `connections`/`agent_connections` are the platform grant layer (cover
telegram/twitter too), so they stay. `venue_accounts` + `user_credentials`
move to Traderton (credential custody follows the venue caller).

### CUT-SEAM (stub to narrowest equivalent)

1. **Identity/ownership:** `bots.userId` FK → soft `ownerId`; `bots.connectionId`
   FK → `venueAccountId` (drop connection indirection). Traderton does not own
   user identity; it accepts an `ownerId` + `actor` from the caller and owns
   `venue_accounts` + `user_credentials`.
2. **Actor resolution:** `actorType`/`actorId` (`agent|bot|user|system`) stays
   as data; the platform's `DecisionIntakeResolver` linkage becomes a boundary
   input, not an import.
3. **Tool dispatch:** trading tools exposed via API/MCP/skill surface instead
   of in-process agent tool registry.
4. **LLM/strategy assessment:** if `strategy`/`market-assessment` pulls the
   platform LLM layer, route that reasoning back across the consumer boundary
   or delete the LLM-owned path. Do not copy `packages/llm` into Traderton.

### DEFER

- **Payments:** all `billing-*` tables, `usage-billing-repository`,
  `assessment-billing`, cost metering/caps. Delete; ledger as Deferred.

## Leaf-first delete order (inside the copied repo)

1. `apps/web` (entire UI).
2. Non-trading API routes; non-trading worker loops (agent session mgmt,
   messaging, chat).
3. Non-trading tools and their registrations.
4. Platform packages: `documents`, messaging; non-trading `domain` slices.
5. Non-trading db schema + repositories (agents, sessions, skills, blueprints,
   chat, billing, agent-*), **after** nothing references them.
6. Convert the four identity FKs to soft references (the seam).
7. Delete `users`/`connections` heavy columns once only the soft owner ref
   remains needed.

**After every step: build compiles + copied tests green.**

## Open questions — RESOLVED (see [000-vision.md](./000-vision.md) decisions 7–15)

1. `connections` — **stays platform.** Not copied. `bots.connectionId` →
   `venueAccountId`; `bots.userId` → soft `ownerId`. Seam sits between
   `connections` (platform) and `venue_accounts` (Traderton).
2. `llm` package — **stays agent-side, NOT copied.** Traderton is mechanical.
   `strategy` is **split**: `Dca`, `Mechanical`, `scan-engine`, `regime` move;
   `Llm`, `Hybrid`, `llm-provider` stay agent-side. Bots are mechanical-only.
3. `blueprint.ts` — **stays platform**; copy only its risk/execution/token-
   safety schemas (within-file seam) for Traderton config ownership.
4. `documents` — **stays platform.** market-assessment — copy domain/analysis;
   leave platform orchestration + billing (Deferred).

## Phase 0 Sign-Off Checklist

This checklist is the approval gate between planning and implementation. Phase 1
does not start until this section is complete and the sign-off record is filled
in.

Only the designated phase approver may change a gate from `Pending` to `Met`
and fill the sign-off record. The implementer may gather evidence and propose a
status change, but may not self-approve unless explicitly acting in that
approver role.

For this plan set, the phase approver is the repo owner by default. The repo
owner may delegate approval to one named technical lead or reviewer for this
phase. If approval is delegated, record that designation in the approver
designation section below before gate review begins. Only the repo owner or
that one delegated approver may mark gates `Met` and activate Phase 1.

This is a planning-set approval gate, not just a narrow Phase 1 mechanics
checklist. Some gates point at later-phase docs because the goal here is to
freeze the extraction story before any copying starts.

| Gate | Status | Evidence / notes |
|------|--------|------------------|
| Vision and decisions accepted | Met | [000-vision.md](./000-vision.md) and [004-decision-log.md](./004-decision-log.md) are accepted as the governing direction for extraction. |
| Copy / stay / cut-seam / defer classification accepted | Met | The classifications in this doc are approved without unresolved ownership ambiguity. |
| Data seam accepted | Met | The `ownerId`, `venue_accounts`, `user_credentials`, and `bots` seam is accepted, including `connections` staying platform-side. |
| LLM and bot-model split accepted | Met | The mechanical-only bot decision and the `llm` stay-platform decision are accepted. |
| Static parity inventory accepted | Met | [006-source-capability-manifest.md](./006-source-capability-manifest.md) is accepted as the inventory authority for extracted scope. |
| Live parity tracker initialized | Met | [001-parity-ledger.md](./001-parity-ledger.md) exists, matches the inventory model from [006-source-capability-manifest.md](./006-source-capability-manifest.md), and is ready to receive live status updates as copied slices land in Phase 1. |
| Downstream reference docs frozen | Met | [005-consumer-boundary-contract.md](./005-consumer-boundary-contract.md) and [007-operational-readiness.md](./007-operational-readiness.md) are accepted as stable planning inputs for later phases, even though they are not implemented in Phase 1. |
| Phase 1 scope accepted | Met | [008-phase-1-scaffold-and-domain-slice.md](./008-phase-1-scaffold-and-domain-slice.md) is accepted as the next executable slice and no broader phase is being entered. |
| Open planning contradictions resolved | Met | No unresolved contradiction remains across 000-008 that would change execution order, ownership, or acceptance criteria. |

### Sign-Off Record

Fill this record when Phase 0 is approved and authority passes to Phase 1.

| Field | Value |
|------|-------|
| Approval authority used | chinomso ikwuagwu |
| Approved by (phase approver) | Met |
| Approver role | Met |
| Date | Met |
| Environment / branch / repo state | Met |
| Notes / accepted Deferred items | Met |
| Handoff target | [008-phase-1-scaffold-and-domain-slice.md](./008-phase-1-scaffold-and-domain-slice.md) |

Phase 1 becomes active only after every gate above is `Met` and the sign-off
record is filled in by the named phase approver.

## Next after sign-off

After Phase 0 sign-off, begin Phase 1 by executing
[008-phase-1-scaffold-and-domain-slice.md](./008-phase-1-scaffold-and-domain-slice.md).
That phase owns the live updates to
[001-parity-ledger.md](./001-parity-ledger.md) as copied slices land against the
static inventory in
[006-source-capability-manifest.md](./006-source-capability-manifest.md).
Companion docs for that phase are
[005-consumer-boundary-contract.md](./005-consumer-boundary-contract.md),
[006-source-capability-manifest.md](./006-source-capability-manifest.md), and
[007-operational-readiness.md](./007-operational-readiness.md).
