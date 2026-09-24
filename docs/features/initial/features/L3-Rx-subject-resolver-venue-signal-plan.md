# L3-Rx — Subject-resolver: per-tool venue-resolution signal (plan, NOT yet scheduled)

**Status:** IMPLEMENTED 2026-09-11 (on `l3-integration`). Flag swap done; the method
split was deliberately NOT done (authored code, no oracle — kept the four resolution
paths byte-identical; only the short-circuit entry changed). Drafted 2026-09-11.
**Durable obligation lives in** [001-parity-ledger.md](../../001-parity-ledger.md) →
"Subject-resolver: replace the provisioning name-set with a per-tool signal". If this
transient plan is pruned, the ledger entry is authoritative.

**Trigger to schedule this:** BEFORE the first non-drive side-effecting tool
(`adjust_risk_limits` or a watch tool) is routed over REST from herobids. Until then the
issue is **latent, not live** — the boundary would mishandle those tools, but herobids does
not send them yet. Doing it earlier is fine (it removes known-suboptimal code); doing it
later than the trigger is a live bug.

---

## 1. Problem

`packages/boundary/src/subject-resolver.ts` decides "does this invocation need a resolved
venue account?" by **fall-through**:
1. read-only category (`isReadOnlyCategory`) → short-circuit (minimal injection).
2. an explicit name-set `OWNER_SCOPED_PROVISIONING_TOOLS` (`provision_venue_account`,
   `deprovision_venue_account`) → short-circuit (added in L3-P1b).
3. payload names a `botId` → resolve from the bot row.
4. ELSE → require a per-owner default venue account, else `precondition.not_ready`.

Step 4 is a catch-all that wrongly assumes every remaining side-effecting tool needs a venue
account. It does not: only tools that DRIVE THE EXECUTOR need injected venue coordinates.

**Ground truth (verified 2026-09-11 — which tool modules use `ctx.publishToInbound`, the
drive target that consumes the injected `venue`/`venueType`/`venueAccountId`/`ownerMode`):**

| Tool module | uses `publishToInbound`? | needs venue resolution? |
|---|---|---|
| `trading.ts` (`submit_decision`) | YES | **yes** |
| `bots.ts` (`create_bot`,`start_bot`,`stop_bot`,`adjust_bot_config`) | YES | **yes** |
| `provisioning.ts` (`provision_venue_account`,`deprovision_venue_account`) | no | no |
| `risk-limits.ts` (`adjust_risk_limits`) | no | no (uses `ctx.riskContractOps`) |
| `watch.ts` (`watch_token`,`remove_watch`,`check_watches`,`list_watches`,`resolve_watch`) | no | no |
| all `read-*` tools | no | no (already short-circuited) |

So the distinction is **category-blind** — `provision`/`deprovision`/`adjust_risk_limits`
and the drive-path bot tools all share `write-database`. It MUST be a per-tool property.

The L3-P1b name-set patched only `provision`/`deprovision`. `adjust_risk_limits` + the watch
tools remain mishandled by step 4 (latent). Growing the name-set is rejected: it hard-codes
tool names in the resolver, and a new non-drive tool silently falls into the wrong bucket.

## 2. Decision (settled)

Replace the name-set with a **per-tool signal on the `AgentTool` contract**, framed as
**opt-out** with a **fail-closed default**:

- **Signal:** an OPTIONAL boolean on `AgentTool` (in
  `packages/domain/src/trading/tool-contract.ts`). Recommended name/semantics:
  `ownerScopedNoVenue?: boolean` (or `skipsVenueResolution?`) — `true` = "owner-scoped,
  needs NO venue resolution". **Absent/`false` = needs resolution** (the safe default).
- **Why opt-out / this default:** a forgotten flag on a NEW non-drive tool → it wrongly
  requires an account → refuses to run (`precondition.not_ready`) — visible, non-destructive,
  identical to today's fall-through. The inverse framing (`drivesExecutor`, default false)
  would let a forgotten flag on a drive tool run WITHOUT venue coords — silent + dangerous.
  Fail-closed wins.
- **Set the flag `true` on exactly these 8 tools:** `provision_venue_account`,
  `deprovision_venue_account`, `adjust_risk_limits`, `watch_token`, `remove_watch`,
  `check_watches`, `list_watches`, `resolve_watch`. (Note: `list_watches`/`resolve_watch`
  are `read-*` and already short-circuit; setting the flag is harmless/defensive — verify
  and only set where not already read-only, to avoid redundancy. Confirm each watch tool's
  category at implementation time.)
- **Read-only short-circuit stays as-is** (`isReadOnlyCategory`) — do not churn working code.

## 3. Implementation steps

1. **Contract** (`packages/domain/src/trading/tool-contract.ts`): add the optional field to
   `AgentTool` with a doc comment (what it means, why the default fails closed). No change to
   any tool that doesn't set it.
2. **Tools** (`packages/worker/src/tools/{provisioning,risk-limits,watch}.ts`): set the flag
   `true` on the non-drive, non-read side-effecting tools listed above. Leave a one-line
   comment on each tying it to this signal (drives no executor → needs no venue account).
3. **Resolver** (`packages/boundary/src/subject-resolver.ts`):
   - Remove `OWNER_SCOPED_PROVISIONING_TOOLS` + `isOwnerScopedProvisioningTool`.
   - The resolver already receives `toolName`; it also needs the tool's flag. Cleanest: pass
     the tool's `ownerScopedNoVenue` into `resolveSubjectInjection` (the `contextFactory` in
     `bin.ts` already looks up the tool via `registry.get(toolName)` to read `category`, so it
     can read the flag in the same place — NO new registry coupling in the resolver).
   - Replace the name-set branch with: `if (isReadOnlyCategory(category) || tool.ownerScopedNoVenue)
     → minimal injection`. Keep the bot-scoped + default-account paths unchanged.
4. **Signature:** prefer passing a resolved boolean (e.g. `skipVenueResolution: boolean`) into
   `resolveSubjectInjection` rather than the whole tool, to keep the resolver port-only and
   unit-testable without a registry. `bin.ts` computes it from `isReadOnlyCategory(category)
   || tool?.ownerScopedNoVenue`.

## 4. Tests

- **Unit** (`packages/boundary/src/subject-resolver.test.ts`): replace the provisioning-seam
  block with flag-driven cases — a flagged tool short-circuits (no port calls) even with NO
  venue account; an UNflagged non-bot side-effecting tool (e.g. `create_bot`) still requires
  an account (`precondition.not_ready`); bot-scoped path unchanged; read-only path unchanged.
- **Contract/tool tests:** assert the 8 tools carry the flag; assert a representative drive
  tool (`submit_decision`, `create_bot`) does NOT.
- **Regression:** re-run the L3-P1b live e2e (provision → idempotent retry → deprovision →
  second-delete not_found → bad-payload) against the docker boundary to confirm no regression.
  (Note the compose stack needs a dev `CREDENTIAL_ENCRYPTION_KEY` — see the ledger LOW obligation.)

## 5. Verification

`pnpm build`, `pnpm lint`, `pnpm test` green; the resolver unit block green; the live e2e green.
Traderton-only change — no herobids edit. Branch: whichever integration branch is current
(today `l3-integration`); nothing to `main` without the human.

## 6. Scope / non-goals

- Does NOT re-point any herobids call site (that's the separate `adjust_risk_limits` / watch
  re-point slices — see the ledger obligations). This slice only makes the boundary resolver
  handle those tools correctly WHEN they arrive.
- Does NOT touch the read-only seam.
- Does NOT change trading behaviour (authored boundary seam only; copy-never-author governs
  trading logic, not this resolution plumbing).

## 7. Open sub-decision (resolve at implementation)

Final field name (`ownerScopedNoVenue` vs `skipsVenueResolution` vs `drivesExecutor` inverted).
Recommendation: `ownerScopedNoVenue` — positive, reads at the call site as intent ("this tool
is owner-scoped and needs no venue"), and keeps the safe default (absent = needs resolution).
