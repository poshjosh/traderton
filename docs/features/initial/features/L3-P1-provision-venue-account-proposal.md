# L3-P1 — `provision_venue_account` boundary tool (investigate → propose)

**Status:** APPROVED (2026-09-08, human). D1–D4 locked per §7 recommendations: (A) one
`provision_venue_account` tool; credentials-in-payload/encrypted-at-rest confirmed; plan-limit dropped at
the boundary; runs now on a Traderton branch parallel to L3c, before L3e. Decisions mirrored in
CANONICAL-STATE §3.2. Implementation proceeds on branch `l3-p1-provision`, coordinator loop, pause before
merge.
**Slice:** L3-P1 of the consumption phase (its own slice, AFTER L3c authoring, BEFORE L3e — CANONICAL-STATE
§3.2 P1). Traderton-side; I do this on a Traderton branch.
**Reads:** [CANONICAL-STATE.md](../CANONICAL-STATE.md) §3.2 (P1), [005](./../005-consumer-boundary-contract.md)
(the boundary contract), vision decisions 10/12 (Traderton owns `venue_accounts` + `user_credentials`).

## 1. Why L3-P1 exists

For `submit_decision`/`create_bot` to work end-to-end, Traderton's `venue_accounts` (+ `user_credentials`)
must hold the owner's account, or `subject-resolver.ts` returns `precondition.not_ready`. There is no
provisioning path over the 005 boundary today. herobids owns the connection/grant flow but no longer owns
the trading tables. So Traderton needs a boundary tool to provision a venue account + its credentials.

## 2. Key finding — this is COPY + ADAPT, not author

The trading half of herobids' provisioning flow was **already copied into Traderton during extraction** and
sits quarantined. L3-P1 un-quarantines + adapts it to the boundary; it authors almost nothing:

- **`packages/worker/src/crypto.ts`** — the credential encryption util (`encryptCredential`,
  `getEncryptionKey`), already copied + unit-tested. The at-rest design already exists.
- **`packages/db/src/schema/user-credentials.ts`** — already has `encryptedData` + `encryptionMeta`
  ("Secrets are encrypted at rest. Decrypted just-in-time by the worker."). Schema is ready.
- **`packages/worker/src/_deferred-authoring/api-routes/credentials.ts`** — the FULL credential create flow:
  venue-secret canonicalize + validate (`providers/registry` + `providers/validator`),
  `encryptCredential`, insert `user_credentials`, audit event. (Also list/rotate/delete, fail-closed on
  dependents.) Quarantined Fastify route, JWT `request.userId`.
- **`packages/worker/src/_deferred-authoring/api-routes/accounts.ts`** — the `venue_accounts` create.
- **herobids `apps/api/src/trading-provisioner.ts` `provisionTradingTarget`** — the exact seam: it inserts
  the `venue_accounts` row (trading → Traderton) AND updates `connections.resolvedVenueAccountId` (platform →
  herobids keeps). Traderton copies only the `venue_accounts` insert; herobids does the `connections` update
  itself with the returned id.

So the trading logic is present and tested; L3-P1's authored surface is the **thin 005 boundary adapter**
around it (the same adapt F1/F2b did: JWT-route → HMAC-tool, `userId` → `ownerId`, Fastify route → dispatcher
tool + Zod payload). Copy-never-author holds: the provisioning behaviour is copied; only the boundary seam
is authored.

## 3. The seam (what crosses the boundary; what each side owns)

- **herobids sends** (in the 005 `tools:invoke` payload): `venue`/`provider`, `label`, `venueAccountRef`,
  and the **credential secrets** (API key/secret/passphrase, or wallet material) — the platform-owned VALUES
  a consumer injects. Subject: `ownerId` + `actor` (as always).
- **Traderton does** (the copied trading half): validate + canonicalize the venue secrets → `encryptCredential`
  → insert `user_credentials` (encrypted) → insert `venue_accounts` (referencing the credential) → return the
  new **`venueAccountId`**.
- **herobids keeps** (platform half — NOT in Traderton): the `connections` / `agent_connections` grant rows,
  and it updates its own `connections.resolvedVenueAccountId` with the returned `venueAccountId` (the
  `provisionTradingTarget` platform half). Traderton never touches `connections`.

## 4. Credential custody — the crux (design, mostly pre-existing)

The one genuinely security-sensitive fact: **plaintext venue secrets cross the boundary in the
`tools:invoke` payload.** That is unavoidable — Traderton makes the venue calls, so it must receive the
secrets to encrypt + store. The custody design (most of which already exists):

- **In transit:** the 005 boundary is HMAC-signed over TLS (005 §Authentication). The secrets ride inside
  the signed request body. No new transport needed; it is the same channel every tool call uses.
- **At rest:** Traderton `encryptCredential` (copied `crypto.ts`) encrypts before insert; only
  `encryptedData` + `encryptionMeta` are stored. **Never store plaintext.** (Already the copied behaviour.)
- **Never logged:** the provisioning tool MUST NOT log the payload/secrets (the boundary already avoids
  echoing bodies; the tool must scrub). The success result returns metadata only (`venueAccountId`, `venue`,
  `label`) — never the secret (the copied route already returns "without secrets").
- **Read-back:** decrypted just-in-time by the runtime for a venue call (already the model). Out of L3-P1
  scope (that path exists).
- **Idempotency:** provisioning is side-effecting → it flows through F2's `boundary_invocations` idempotency
  store like any write tool (a retried provision with the same key does not double-insert).

## 5. Tool shape — one decision to make (§7 D-1)

Two viable shapes for the 005 surface:

- **(A) One tool `provision_venue_account`** — payload carries venue + label + secrets + accountRef; it
  creates the credential AND the venue_account in one transaction, returns `venueAccountId`. Simplest for the
  consumer (one call), matches "provision a venue account" as the unit. RECOMMEND.
- **(B) Two tools `create_credential` + `create_venue_account`** — mirrors the herobids route split more
  literally (credentials.ts + accounts.ts are separate). More flexible (rotate/reuse a credential across
  accounts) but two round-trips + the consumer must sequence them.

RECOMMEND **(A)** — the consumer's actual unit of work is "provision this owner's venue account"; the
credential exists only to back it. (Rotate/delete can be separate later tools if needed — not L3-P1.)

## 6. Scope / sub-shape

- **In L3-P1:** the `provision_venue_account` tool (create path) + its registration in the boundary tool
  registry + its dispatch (it is a **side-effecting write tool** → idempotency + deadline like F2's writes) +
  un-quarantining the copied credential/account creation + `providers/`/`schemas`/crypto wiring + copied
  tests as the parity oracle. Follows the investigate → propose → **pause** → implementer-prompt →
  coordinator-loop pattern.
- **NOT in L3-P1:** credential rotate/delete tools (later if needed); the herobids-side call (herobids sends
  the provision request + does its own `connections` update — that is herobids' work, on its branch); the
  read-back/decrypt path (exists).
- **New 005 surface:** yes — `provision_venue_account` is a new tool beyond the original 25 + a new contract
  entry. Record in 005 + the tool catalog + the ledger (Gap→Met when done).

## 7. Decisions needed before implementing

- **D-1 — one tool (A) or two (B)?** RECOMMEND **(A)** `provision_venue_account` (create credential +
  venue_account in one call, return `venueAccountId`).
- **D-2 — credentials cross the wire in the payload (plaintext-in-transit, HMAC+TLS, encrypted-at-rest by
  Traderton).** Confirm this is acceptable (it is inherent to Traderton owning credentials + making venue
  calls). RECOMMEND confirm; the alternative (herobids holds credentials, Traderton fetches) re-couples
  custody to the platform and contradicts decision 12.
- **D-3 — plan-limit checks (`checkCredentialLimit`) on the boundary?** The copied route enforces a per-user
  credential limit from `PlansConfig` — a platform concept. RECOMMEND **drop it** at the boundary (plan
  entitlement is a herobids concern, checked pre-boundary — same as maxBots #4); Traderton just provisions.
  Confirm.
- **D-4 — sequencing:** L3-P1 runs now (Traderton-side) in parallel with herobids L3c (independent), lands
  before L3e. Confirm.

## 8. Recommendation

Proceed L3-P1 as **(A)** one `provision_venue_account` write tool, un-quarantining the already-copied
credential+account creation, adapting it to the 005 boundary (userId→ownerId, route→tool, idempotent write),
credentials-in-payload/encrypted-at-rest per §4, plan-limit dropped (D-3). On your steer I lock D-1..D-4 into
CANONICAL-STATE, write the L3-P1 implementer prompt, and run the coordinator loop on a Traderton branch,
pausing before merge (nothing merges to `main` without you).
