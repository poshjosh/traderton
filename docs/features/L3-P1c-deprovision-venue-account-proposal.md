# L3-P1c — `deprovision_venue_account` boundary tool (investigate → propose)

**Status:** APPROVED (human, 2026-09-08) — OQ1–OQ3 resolved against **current herobids practice**
(§5). Implementation proceeds. The delete-counterpart tool the L3-P1b review resolved as Option (a):
provision + deprovision are a pair; L3-P1b's write path cannot ship its clean orphan-compensation,
and the three surviving in-process delete call sites cannot re-point, until this exists. Traderton-side
build (mirror of L3-P1 `provision_venue_account`).

**Reads:** L3-P1 proposal (`L3-P1-provision-venue-account-proposal.md`),
[CANONICAL-STATE.md](../CANONICAL-STATE.md) (legal-isolation; decision-13 soft references),
[L3-direction-overview-for-herobids.md](./L3-direction-overview-for-herobids.md).

## 1. Why

herobids currently deletes `venue_accounts` + `user_credentials` in-process at **three** call sites
(verified): `apps/api/src/provider-links.ts` `deleteProviderLink` (L182/L186), `apps/api/src/routes/accounts.ts:210`
(delete venue account), `apps/api/src/routes/credentials.ts:241` (delete credential). Post-cutover
those tables are Traderton-owned, so herobids can no longer delete them directly — it needs a
boundary tool. This tool also gives L3-P1b's D1 its clean orphan-compensation (provision succeeded +
local insert failed → call deprovision to roll back).

## 2. This is COPY + ADAPT (mirror of provision), not author

- **Template:** `provision_venue_account` (`packages/worker/src/tools/provisioning.ts`) — same
  structure (owner+db guards, one transaction, metadata-only result, `write-database` category,
  read-only-seam N/A since it's a write).
- **Delete logic + fail-closed rule:** copied from herobids `deleteProviderLink` +
  `findCredentialDependents` (`credential-dependents.ts`). The tool authors no new deletion policy;
  it copies the source's block-if-in-use behaviour, restricted to Traderton-owned dependents (§4).

## 3. Contract

- **Name:** `deprovision_venue_account`, category `write-database`.
- **Inputs:** `venueAccountId` (string). The envelope carries `ownerId` + `actor`.
- **Behind the boundary:**
  1. owner + db guards (mirror provision).
  2. Load the venue account by `venueAccountId`; verify `ownerId` matches (ownership — else
     `authorization.denied` / not-found). Capture its `credentialId`.
  3. **Fail-closed dependents check (§4)** — block if any Traderton-owned dependent is in use.
  4. ONE transaction: delete the `venue_account` first, then its `user_credentials` row (FK order:
     `venue_accounts.credentialId → userCredentials` is `onDelete: 'restrict'`, so the account must
     go first — mirrors source step 7→8).
  5. Metadata-only success: `{ venueAccountId, deleted: true }` (never secrets).
- **Idempotency:** side-effecting → goes through the dispatcher's persist-before-side-effect wrap
  (like provision). A repeat call after deletion returns not-found (or a benign already-deleted
  result — decide in §5 OQ2).

## 4. The fail-closed check — Traderton-owned dependents ONLY (the key parity nuance)

The source `deleteProviderLink`/`findCredentialDependents` blocks on a MIX of platform + trading
dependents: `agent_connections`, active `connections` (PLATFORM), and `venue_accounts` + running
`bots` (TRADING). Post-cutover Traderton owns ONLY the trading side. Verified: Traderton's schema has
`bots.venueAccountId` FK (`onDelete: 'restrict'`, with a `status` column) and NO
`connections`/`agent_connections` tables.

**So the tool blocks ONLY on Traderton-owned dependents: running bots on that venue account.**
The `connections` / `agent_connections` blocking checks STAY IN HEROBIDS (platform) — herobids runs
them BEFORE calling `deprovision_venue_account` (it already does, in `deleteProviderLink`). This
keeps the legal split honest: Traderton refuses to delete a venue account with a running bot (its own
integrity); herobids refuses to initiate deprovision while a platform connection/agent still depends
on it (its own integrity). Neither reaches into the other's tables.

- Block rule (copied from current practice — OQ1): if **any** `bots` row with `venueAccountId = <id>`
  exists (NO status filter) → refuse with a typed `provision.in_use` failure listing the blocking bot
  ids. Plus the **FK-`23503` fallback**: if a bot appears between the pre-check and the delete, catch
  the pg foreign-key violation, re-query, and return the same `in_use` failure (never a raw error).

## 5. Open questions — RESOLVED against current herobids practice (human, 2026-09-08)

Answers verified against what herobids does TODAY (the copy source), not by preferred semantics:

1. **Bot dependents → BLOCK ON ANY BOT (no status filter) + FK-`23503` fallback.** Verified:
   `accounts.ts` (delete venue account) and `provider-links.ts` `resolveProviderLinkDependents` both
   select bots by `venueAccountId` with **no status filter** and block if any exist (409
   `venue_account_in_use` with `blockingBotIds`); both catch pg `23503` on the delete, re-query, and
   return the same `in_use`. (My earlier "running-only" lean was wrong — the venue-account delete path
   is any-bot; only the *credential* dependents report filters running, for a different purpose.) The
   tool copies **any-bot + FK fallback**.
2. **Repeat / not-found → `not_found` FAILURE.** Verified: `credentials.ts` (load scoped to owner →
   404 if absent) and `provider-links.ts` (`if (!resources) return { kind: 'not_found' }`). The tool
   returns a `not_found` failure for an absent/unowned `venueAccountId`. (The idempotency wrap still
   handles true same-request retries.)
3. **Cascade → DELETE BOTH (account + its credential), ordered, mirroring `deleteProviderLink`.**
   Verified: the holistic path deletes venue_account then credential in one transaction. **Flagged as
   a SEPARATE question (not this tool):** herobids ALSO supports deleting a venue_account alone
   (`accounts.ts`) and a credential alone (`credentials.ts`, fail-closed `credential_in_use` if any
   venue account still references it). The `deprovision_venue_account` tool covers the account-centric
   cascade (the `deleteProviderLink` + `accounts.ts` sites). Whether Traderton also needs a standalone
   **`deprovision_credential`** tool for the `credentials.ts:241` site is a separate contract question,
   raised by the delete-re-point slice — NOT folded in here.

## 6. Scope + verification plan

- **Authored surface:** the tool adapter (mirror of provision) + the trading-only dependents check
  (copied from `findCredentialDependents`, restricted to `bots`). Registration in `provisioningTools`.
- **Tests:** mirror `provisioning.test.ts` — happy path (deletes account + credential, metadata-only
  result); ownership mismatch → denied; running-bot present → blocked/in_use; not-found; delete order
  (account before credential) respected.
- **Verify:** `pnpm build` + `pnpm lint` + `pnpm test` green; the tool dispatches side-effecting
  (idempotency wrap), owner-scoped, secrets never logged.

## 6b. IMPLEMENTED (2026-09-08, branch `l3-p1-provision`)

`deprovision_venue_account` built + verified. Changes (all in `packages/worker/src/tools/`):
- **`provisioning.ts`** — added `deprovisionVenueAccountTool` (`write-database`), appended to
  `provisioningTools` (so the boundary registry picks it up). Un-quarantines + adapts the copied
  `_deferred-authoring/api-routes/accounts.ts` DELETE handler: owner-scoped load → not_found;
  block on ANY bot (no status filter) → `provision.in_use`; one transaction deletes the venue
  account THEN its credential (FK order); FK-`23503` fallback re-queries and returns `in_use`;
  metadata-only `{ venueAccountId, deleted: true }`. Added `and`/`eq` + `bots` imports.
- **`deprovision.test.ts`** (new) — 7 tests: cascade delete-in-order; account-only when no
  credential; not_found; any-bot block; FK-23503→in_use; owner-missing fail-closed; write category.

Verified: `pnpm build` clean; `pnpm lint` clean; full suite **2388 passed / 39 skipped / 0 failed**
(+7). Dispatches side-effecting (idempotency wrap), owner-scoped, secrets never touched.

This unblocks L3-P1b's D1 orphan-compensation and the three herobids delete-call-site re-points
(`deleteProviderLink`, `accounts.ts`, `credentials.ts`). The standalone `deprovision_credential`
question (OQ3) remains open for the `credentials.ts` re-point — NOT built here.

## 7. Next step (on approval)

1. Resolve OQ1–OQ3.
2. Build `deprovisionVenueAccountTool` + the trading-only dependents check + tests, on branch
   `l3-p1-provision` (alongside provision — they're a pair) or a fresh `l3-p1c-deprovision` (human's
   call).
3. Pause for review. This unblocks L3-P1b's write path (compensation) + the three delete-call-site
   re-points (herobids side, tracked under L3-P1b or a follow-slice).
