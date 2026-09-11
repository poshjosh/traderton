# L3-P1 Implementer Prompt — the `provision_venue_account` boundary tool

**Status:** ready to hand to an implementer. On branch `l3-p1-provision` (off `f-m2-rest`).
**Task:** expose venue-account + credential provisioning as ONE side-effecting 005 boundary tool,
`provision_venue_account`, by **un-quarantining + adapting the ALREADY-COPIED trading half** — not authoring.
**Authoritative brief:** [L3-P1-provision-venue-account-proposal.md](./L3-P1-provision-venue-account-proposal.md)
(APPROVED) + [CANONICAL-STATE.md](../CANONICAL-STATE.md) §3.2 P1 + [005](../005-consumer-boundary-contract.md).

## 0. Orient first

You are in **Traderton** (`/Users/chinomso.ikwuagwu/dev_ai/traderton`), branch `l3-p1-provision`. The M2 REST
boundary (`packages/boundary`, `@traderton/boundary`) is complete (F1–F2c): HMAC auth, envelope/version
validation, the `tools:invoke` dispatcher (deadline + idempotency + side-effecting dispatch), the status
endpoint. L3-P1 adds ONE new tool the boundary can dispatch: `provision_venue_account`.

**The law (copy-never-author):** the provisioning trading logic is **already copied** into the quarantine —
you un-quarantine + adapt it, you do not re-author it. Author only the thin boundary/tool seam (the same
route→tool, `userId`→`ownerId` adapt F1/F2b used). If you find yourself writing provisioning/encryption
logic from scratch, STOP — it exists; copy/reuse it.

## 1. What already exists (reuse — do NOT re-author)

- **`packages/worker/src/crypto.ts`** — `encryptCredential(plaintext, keyHex, keyVersion=1) →
  { encryptedData, encryptionMeta }` + `decryptCredential`. Copied + unit-tested. USE for at-rest encryption.
- **`packages/db/src/schema/user-credentials.ts`** — `user_credentials` (`ownerId`, `provider`, `label`,
  `encryptedData`, `encryptionMeta`). **NOTE:** the schema is already `ownerId`-keyed (soft-owner). The
  quarantined route below still writes `userId` — that is the adapt (see §3).
- **`packages/db/src/schema/venue-accounts.ts`** — `venue_accounts` (`ownerId`, `venue`, `label`,
  `venueAccountRef`, `credentialId`, `venueProfile`). Already `ownerId`-keyed.
- **`packages/worker/src/_deferred-authoring/api-routes/credentials.ts`** — the copied credential CREATE
  flow: `canonicalizeVenueSecrets` + `validateVenueSecrets` (via `providers/registry` + `providers/validator`),
  `getEncryptionKey()` + `encryptCredential`, insert `user_credentials`, audit event. (Also list/rotate/
  delete — NOT in scope; create only.) Quarantined Fastify route, JWT `request.userId`.
- **`packages/worker/src/_deferred-authoring/api-routes/accounts.ts`** — the copied `venue_accounts` CREATE:
  validates the `credentialId` linkage (scoped to the owner), the Jupiter `venueAccountRef` (Solana wallet)
  rule, then inserts `venue_accounts`.
- Sibling deps in the quarantine: `providers/` (registry + validator/canonicalizer), `schemas.ts`
  (`CreateCredentialSchema` etc.), `error-payload.ts`. Reuse them; move what you need out of the quarantine.

**herobids reference (READ-ONLY):** `apps/api/src/trading-provisioner.ts` `provisionTradingTarget` shows the
exact seam — it inserts `venue_accounts` (the trading half you copy) AND updates
`connections.resolvedVenueAccountId` (the PLATFORM half — herobids does this itself with the returned id;
Traderton does NOT touch `connections`).

## 2. What L3-P1 delivers

**ONE `AgentTool` `provision_venue_account`** (D1) that, in one idempotent transaction: validates +
canonicalizes the venue secrets → `encryptCredential` → inserts `user_credentials` → inserts `venue_accounts`
(linked to the new credential) → returns `{ venueAccountId }` (metadata only). Registered in the boundary
tool registry so the dispatcher can invoke it as a **side-effecting write tool** (idempotency + deadline via
the F2 store — same path as the other write tools).

## 3. The adapt (route → tool; `userId` → `ownerId`; JWT → 005 subject)

The quarantined code is a Fastify route keyed on JWT `request.userId`. The boundary dispatches `AgentTool`s
with a `TradingToolContext` carrying the signed subject. So:

- **Shape:** author `provision_venue_account` as an `AgentTool` (like the copied tools in
  `packages/worker/src/tools/*`), category side-effecting (NOT `read-*`), with a Zod `parametersSchema`. Put
  it in a tool group the boundary registry composes (e.g. a new `provisioningTools` export from
  `@traderton/worker`, added to `packages/boundary/src/registry.ts`'s `buildToolRegistry`).
- **Payload (Zod):** `{ venue, label, secrets: Record<string,string>, venueAccountRef?: string }`. Reuse the
  quarantined `CreateCredentialSchema`/account schemas' field shapes + the venue-secret validation
  (`validateVenueSecrets`/`canonicalizeVenueSecrets`) + the Jupiter `venueAccountRef` rule VERBATIM (they are
  the copied parity logic — do not re-invent).
- **Owner:** use `ctx`'s signed owner (the boundary resolves `subject.ownerId`). Write `ownerId` (NOT
  `userId`) to both tables — the Traderton schemas are already `ownerId`-keyed; the quarantined route's
  `userId:` insert field is the ONE adapt (change to `ownerId`). This mirrors the soft-reference rule.
- **Transaction:** credential insert + venue_account insert in ONE `db.transaction` (both succeed or neither).
  Return `{ venueAccountId }` + `venue` + `label` — **never the secrets** (the copied route already returns
  "without secrets"; keep that).
- **DROP (D3):** the `checkCredentialLimit` / `PlansConfig` plan-limit + the `pg_advisory_xact_lock(13,...)`
  that guards it — plan entitlement is a herobids pre-boundary concern (like maxBots #4). Keep the venue-
  secret validation + the credential-linkage/Jupiter validation (those are trading, not platform).
- **Audit:** keep the `credentialCreatedEvent` audit append if it copies cleanly (it is trading audit); drop
  it if it drags platform deps — flag either way.

## 4. Credential custody (D2 — mostly pre-existing; enforce it)

- Secrets arrive in the `tools:invoke` payload (HMAC+TLS in transit — the boundary's existing channel).
- **Encrypt before insert** via `encryptCredential(getEncryptionKey-equivalent)`. **Never** store plaintext.
- **Never log the payload/secrets.** The tool must not `console.log`/logger the `secrets`; scrub. The success
  result is metadata only (`venueAccountId`/`venue`/`label`).
- `getEncryptionKey()` in the quarantine reads the key from env/config — confirm Traderton has the key source
  wired (the boundary `bin.ts` / worker config); if not, surface it as a config item (do not hard-code a key).

## 5. Idempotency + dispatch

`provision_venue_account` is side-effecting → it goes through the F2 idempotency store like the other write
tools (no special handling needed IF you register it as a non-read-only tool; the dispatcher already persists
+ dedupes by the 4-tuple). A retried provision with the same idempotency key must NOT double-insert — verify
the dispatcher's begin/replay path covers it (it should, generically). Do NOT author a second idempotency
mechanism.

## 6. Tests (the copied tests are the parity oracle)

- Un-quarantine + adapt the copied `credentials.test.ts` / `accounts.test.ts` create-path assertions into
  the tool's tests (re-keyed `userId`→`ownerId`; route→tool). They are the parity harness — keep their
  assertions (secret validation, canonicalization, Jupiter rule, credential linkage, encrypt-at-rest,
  no-secret-in-response).
- Add boundary-level tests (like `app.test.ts` / F2b): a signed `provision_venue_account` invoke →
  a `venue_accounts` + `user_credentials` row created (encrypted), `{venueAccountId}` returned; a bad venue
  secret → `validation.invalid_payload`; the DATABASE_URL-gated integration test creates real rows +
  asserts `encryptedData` is not plaintext.
- Prove **the secret never appears** in the result envelope or logs.

## 7. Guardrails / done criteria

- **Un-quarantine + adapt, do NOT re-author** the provisioning/encryption/validation logic.
- **Author only** the tool wrapper + the Zod payload + the registry wiring + the `userId`→`ownerId` adapt +
  dropping the plan-limit.
- **Never log secrets; never return them; always encrypt at rest.**
- **Do NOT touch `connections`** (platform — herobids updates `resolvedVenueAccountId` itself).
- `pnpm build` green, `pnpm lint` clean, `pnpm test` green (+ the DATABASE_URL-gated integration test passes
  when a DB is available — run it against a throwaway Postgres like the F2a/F2c proof).
- Register `provision_venue_account` in `packages/boundary/src/registry.ts`; record it in
  [005](../005-consumer-boundary-contract.md) (new tool) + the ledger.
- Report: files un-quarantined/added, the adapt (route→tool, userId→ownerId, plan-limit dropped), the
  credential-custody enforcement, and any seam surfaced. Do NOT commit — the coordinator commits.
- **Then PAUSE** — nothing merges to `main` without the human.

## 8. Key file map

- Reuse: `packages/worker/src/crypto.ts`; `packages/worker/src/_deferred-authoring/api-routes/{credentials,
  accounts}.ts` + `providers/` + `schemas.ts` + `error-payload.ts`; `packages/db/src/schema/{user-credentials,
  venue-accounts}.ts`.
- Author/wire: a `provision_venue_account` `AgentTool` (+ its tool-group export from `@traderton/worker`);
  `packages/boundary/src/registry.ts` (register it); tests.
- READ-ONLY reference: `herobids/apps/api/src/trading-provisioner.ts` (the seam),
  `herobids/apps/api/src/routes/accounts.ts` + `credentials.ts` (the source of the copied quarantine).
