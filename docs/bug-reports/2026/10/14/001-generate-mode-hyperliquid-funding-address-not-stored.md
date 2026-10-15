# Bug Report: `provision_venue_account` generate mode does not store the minted address for non-Jupiter venues, so `get_funding_info` returns `fundingAddress: null`

- **Status:** OPEN. Not fixed. Awaiting review and approval of the fix.
- **Severity:** High. An agent cannot tell its owner where to send funds, so the funding step of the agent onboarding flow (G1) cannot pass for any generated Hyperliquid wallet.
- **Date:** 2026-10-14
- **Component:** `packages/worker/src/tools/provisioning.ts` (`provision_venue_account` generate branch, `get_funding_info`)
- **Surfaced by:** Herobids G1 self-serve UAT, agent `d43c3384-0d92-4d92-8fc8-3a0ef8572259` (`trader`), tool call `get_funding_info` at 2026-10-14 13:06:50 UTC.
- **Related:** Herobids `docs/features/2026/10/10/002-agent-onboarding-epic/PROGRESS.md` (G1 log, funding row).

## Summary

When `provision_venue_account` runs in generate mode, it mints a keypair and returns the public address in `wallet.address`. It also writes that address into `venue_accounts.venue_account_ref`, but only when `venue === 'jupiter'`:

```ts
// provisioning.ts ~L226
if (params.venue === 'jupiter' && generatedWalletAddress) {
  venueAccountRef = generatedWalletAddress;
}
```

For `hyperliquid` the column stays `null`. `get_funding_info` then returns that column as `fundingAddress` (~L755), so the owner is told there is no funding address. The provisioning response still carries the address, so the Herobids setup reply shows it. That is why the agent gave the owner an address from the setup reply while `get_funding_info` returned `null`.

## Symptom (as observed)

Agent `trader` (Herobids), venue account `5407bd79-b7b1-4551-a0b0-b4ff91d0a0ab` (`hyperliquid test wallet`):

```
get_funding_info -> {"ok":true,"venueAccountId":"5407bd79-…","venue":"hyperliquid",
  "label":"hyperliquid test wallet","fundingAddress":null,"network":"Hyperliquid",
  "fundingStatus":"unknown","balance":null}
```

Herobids `set_trading_setup` on connection `c138cb49…` reported wallet `0x5364cF14EF5Bb0174F1897d9A87cE22F5b12895f`. The agent could not give the owner that address through `get_funding_info`.

## Root cause (from code)

1. Generate branch (`provisioning.ts` ~L182–194) sets `generatedWalletAddress = generated.wallet.address` for every venue.
2. Ref assignment (~L225–227) only applies that address when `params.venue === 'jupiter'`.
3. Insert (~L302) writes `venueAccountRef: venueAccountRef ?? null`, so Hyperliquid rows get `null`.
4. `get_funding_info` (~L755) returns `account.venueAccountRef ?? null` as `fundingAddress`.
5. The generate response (~L322) returns `wallet: { address, network }` from `generatedWalletAddress`, so the address is still surfaced at provision time and lost afterwards.

## Why tests did not catch it

`provisioning.test.ts` ~L330–362 (`generate mode for hyperliquid mints + stores + returns only the public address`) asserts `wallet.address` in the response and that the credential is encrypted. It does not assert `venueAccountInsert.venueAccountRef`. The Jupiter generate test (~L378–391) asserts it, so the rule is tested only for Jupiter.

`funding-info.test.ts` covers `get_funding_info` only with a pre-set `venueAccountRef` (for example `'0xWallet'`). It never runs the generate-then-fund path, so it cannot show the gap.

## Expected behaviour

After `provision_venue_account` generate mode succeeds for any venue, `venue_accounts.venue_account_ref` holds the generated public address, and `get_funding_info` returns it as `fundingAddress`. The same address is returned by both calls.

## Not verified

- The `venue_accounts` row for `5407bd79-…` has not been read directly. The conclusion comes from the code and from the `null` value returned by `get_funding_info`. Confirm with a read of the row before closing.
- Whether the Hyperliquid adapter reads `venueAccountRef` at runtime. A fix that stores the address for every venue could change adapter behaviour, so check the adapter before changing the write.

## Proposed fix (not applied)

Option A (preferred, smallest change): store the generated address as `venueAccountRef` for every generate-mode venue.

```ts
if (generatedWalletAddress) {
  venueAccountRef = generatedWalletAddress;
}
```

Keep the Jupiter validation after it so the Solana address check still runs.

Option B: leave the write alone and make `get_funding_info` read the address from a separate stored wallet record. This is a larger change and needs a schema decision.

## Tests to add

- Hyperliquid generate mode: assert `venueAccountInsert.venueAccountRef` equals `wallet.address`.
- `get_funding_info` after generate: the `fundingAddress` returned equals the `wallet.address` from provisioning.
- Keep the existing Jupiter test passing.

## Acceptance

- Unit tests above pass.
- `pnpm lint` and the worker test suite pass.
- Live: the `trader` agent (or a new one) generates a Hyperliquid wallet, `get_funding_info` returns the same address as the setup reply, and G1 funding step is re-run and recorded.
