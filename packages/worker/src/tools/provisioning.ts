// AUTHORED SEAM (L3-P1) — the `provision_venue_account` boundary tool.
//
// This is the thin route→tool seam over ALREADY-COPIED provisioning behaviour.
// It authors NO provisioning/encryption/validation logic: it reuses the copied
// `crypto.ts` (encryptCredential/getEncryptionKey), the un-quarantined
// `providers/` registry+validator (canonicalize/validate venue secrets), and the
// copied Jupiter `venueAccountRef` (Solana wallet) rule + credential-linkage
// shape from `_deferred-authoring/api-routes/{credentials,accounts}.ts`.
//
// The adapt (author only this): Fastify route → `AgentTool`; JWT `request.userId`
// → the boundary-resolved `ctx.ownerId` (written to BOTH tables — the Traderton
// schemas are already `ownerId`-keyed); the plan-limit (`checkCredentialLimit` /
// `checkVenueAccountLimit` + the `pg_advisory_xact_lock(13,…)`) is DROPPED — plan
// entitlement is a herobids pre-boundary concern (L3-P1 D3, mirrors maxBots #4).
//
// Credential custody (L3-P1 D2): secrets arrive in the HMAC+TLS `tools:invoke`
// payload, are encrypted BEFORE insert, and are NEVER logged or returned — the
// success result is metadata only (`venueAccountId`/`venue`/`label`).
//
// The credential-audit event (`credentialCreatedEvent`) is DROPPED: it was not
// copied into `@traderton/engine` and its payload is `userId`-shaped (platform
// identity), so appending it would drag a platform dep. Flagged in docs/003.

import { z } from 'zod';
import crypto from 'node:crypto';
import type { AgentTool, ToolResult, TradingToolContext } from '@traderton/domain';
import { and, eq } from 'drizzle-orm';
import type { Database } from '@traderton/db';
import { userCredentials, venueAccounts, bots } from '@traderton/db';
import { convertZodToJsonSchema } from './registry.js';
import { encryptCredential, getEncryptionKey } from '../crypto.js';
import { findProviderRegistryEntry } from '../providers/registry.js';
import { canonicalizeProviderSecrets, validateProviderSecrets, type ProviderValidationError } from '../providers/validator.js';
import { generateWallet, WalletGenerationError } from '@traderton/venues';

// --- Copied venue-secret canonicalisation + validation seams (from the copied
//     credentials route). Thin wrappers over the un-quarantined providers logic. ---

export interface SecretValidationError {
  field: string;
  code: string;
  message: string;
  params?: Record<string, unknown>;
}

export function canonicalizeVenueSecrets(venue: string, secrets: Record<string, string>): Record<string, string> {
  return canonicalizeProviderSecrets(venue, secrets, findProviderRegistryEntry(venue));
}

/** Venue-specific validation of credential secrets. Returns empty array if valid. */
export function validateVenueSecrets(venue: string, secrets: Record<string, string>): SecretValidationError[] {
  return validateProviderSecrets(venue, secrets, findProviderRegistryEntry(venue)) as ProviderValidationError[];
}

// --- Copied Solana wallet-address validation (verbatim from the copied
//     accounts route — the Jupiter `venueAccountRef` rule). ---

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Validate a Solana public key by base58-decoding and checking the byte length is exactly 32.
 * No dependency required — base58 decoding is a trivial big-integer conversion.
 */
function isValidSolanaAddress(address: string): boolean {
  let value = 0n;
  for (const char of address) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx < 0) return false; // character not in base58 alphabet
    value = value * 58n + BigInt(idx);
  }
  // Leading '1' characters each encode a leading zero byte
  let leadingZeros = 0;
  for (const char of address) {
    if (char !== '1') break;
    leadingZeros++;
  }
  const bytes: number[] = [];
  let v = value;
  while (v > 0n) { bytes.unshift(Number(v & 0xffn)); v >>= 8n; }
  return leadingZeros + bytes.length === 32;
}

// --- The tool ---

// Base object shape. The mutual-exclusion rule is applied via `.refine()` below;
// the JSON-schema derivation uses this base object so the required-field
// normalisation (which only unwraps a plain ZodObject) stays correct.
const ProvisionVenueAccountObject = z.object({
  venue: z.string().min(1),
  label: z.string().min(1),
  /**
   * MANUAL mode: the caller-supplied secrets to encrypt (API key, secret,
   * wallet key, etc.) — never logged or returned. Omit when using GENERATE mode.
   */
  secrets: z.record(z.string()).optional(),
  /**
   * GENERATE mode: mint the trading keypair Traderton-side (custody follows the
   * venue caller). `network` labels the generated wallet (operator-config concern
   * resolved by the pre-boundary caller). Mutually exclusive with `secrets`.
   */
  generate: z.object({ network: z.string().min(1) }).optional(),
  /** Venue-specific reference (e.g. a Solana wallet address for Jupiter). */
  venueAccountRef: z.string().optional(),
});

// EXACTLY ONE of manual `secrets` / `generate` must be provided.
const ProvisionVenueAccountParamsSchema = ProvisionVenueAccountObject.refine(
  (v) => (v.secrets != null) !== (v.generate != null),
  {
    message: 'Provide exactly one of `secrets` (manual) or `generate` (mint Traderton-side)',
    path: ['secrets'],
  },
);

type ProvisionVenueAccountParams = z.infer<typeof ProvisionVenueAccountParamsSchema>;

/** A validation failure that maps to the boundary's `validation.invalid_payload`. */
function validationFailure(error: SecretValidationError): ToolResult {
  return {
    success: false,
    fault: false,
    error: error.message,
    errorCode: error.code,
  };
}

const provisionVenueAccountTool: AgentTool<TradingToolContext> = {
  name: 'provision_venue_account',
  // Owner-scoped write; drives no executor. Needs no venue resolution — and
  // CREATES the owner's first venue account, so requiring one would deadlock.
  ownerScopedNoVenue: true,
  description:
    "Provision a venue account with its trading credential in one step: either supply the venue secrets (manual) or mint a fresh trading keypair Traderton-side (generate); then validate + encrypt them, store them, and create the linked venue account. Returns the new venueAccountId (never the secrets); generate mode also returns the new wallet's public address to fund. Use this to onboard an owner's exchange/wallet before creating bots or submitting decisions.",
  parametersSchema: ProvisionVenueAccountParamsSchema,
  parameters: convertZodToJsonSchema(ProvisionVenueAccountObject),
  category: 'write-database',
  promptGuidance:
    'Provide the venue (e.g. "hyperliquid", "jupiter", "1inch", "bybit") and a display label, then EITHER `secrets` (manual: supply the venue credentials to encrypt) OR `generate: { network }` (mint the trading keypair Traderton-side) — exactly one. For manual Jupiter, venueAccountRef must be a valid Solana wallet address; in generate mode the minted address is used automatically. Secrets are encrypted at rest and are never returned; generate mode returns only the new wallet\'s public address.',
  async execute(rawParams: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const params = rawParams as ProvisionVenueAccountParams;

    if (!ctx.db) {
      return {
        success: false,
        fault: true,
        error: 'Database access not available in this context',
        errorCode: 'provision.db_unavailable',
      };
    }
    if (!ctx.ownerId || !ctx.ownerId.trim()) {
      return {
        success: false,
        fault: true,
        error: 'Owner identity not available in this context',
        errorCode: 'provision.owner_unavailable',
      };
    }
    const db = ctx.db as Database;
    const ownerId = ctx.ownerId;

    // 0. Credential-mode resolution (D1-3b). EXACTLY ONE of manual `secrets` /
    //    `generate` must be provided. The boundary schema (`.refine`) already
    //    enforces this, but the tool re-checks so a direct in-process caller
    //    cannot bypass it. A mode-shape violation is a caller error (fault:false).
    const hasSecrets = params.secrets != null;
    const hasGenerate = params.generate != null;
    if (hasSecrets === hasGenerate) {
      return validationFailure({
        field: 'secrets',
        code: 'provision.validation_error.invalid_credential_mode',
        message: 'Provide exactly one of `secrets` (manual) or `generate` (mint Traderton-side)',
        params: { hasSecrets, hasGenerate },
      });
    }

    // GENERATE mode: mint the trading keypair Traderton-side BEFORE
    // canonicalise/validate. Custody follows the venue caller → Traderton.
    // The generated secrets replace params.secrets for the rest of the flow
    // (canonicalize → validate → encrypt → store). The private key is used
    // ONLY to encrypt-at-rest; only the PUBLIC address is ever surfaced.
    let rawSecrets: Record<string, string>;
    let generatedWalletAddress: string | null = null;
    let generatedNetwork: string | null = null;
    if (params.generate) {
      try {
        const generated = generateWallet({
          provider: params.venue,
          enabled: true,
          network: params.generate.network,
        });
        // GeneratedWalletSecrets is a union of string-valued fields — safe to
        // treat as Record<string,string> for the canonicalize/validate flow.
        rawSecrets = { ...generated.secrets } as Record<string, string>;
        generatedWalletAddress = generated.wallet.address;
        generatedNetwork = generated.wallet.network;
      } catch (err) {
        // Unsupported/disabled provider → a clean validation-style failure
        // (caller error, not a fault). Never surface secrets.
        if (err instanceof WalletGenerationError) {
          return validationFailure({
            field: 'generate',
            code: err.code,
            message: err.message,
            params: { venue: params.venue },
          });
        }
        throw err;
      }
    } else {
      // MANUAL mode. The schema refinement guarantees secrets is present here.
      rawSecrets = params.secrets!;
    }

    // 1. Canonicalise + validate the venue secrets (copied parity logic).
    const normalizedSecrets = canonicalizeVenueSecrets(params.venue, rawSecrets);
    const venueSecretErrors = validateVenueSecrets(params.venue, normalizedSecrets);
    if (venueSecretErrors.length > 0) {
      return validationFailure(venueSecretErrors[0]!);
    }

    // 2. Venue-specific venueAccountRef enforcement (copied Jupiter rule verbatim).
    //    Normalise early so the trimmed value is used for validation + persistence.
    //    In GENERATE mode the minted wallet address IS the venueAccountRef for
    //    Jupiter (mirrors herobids `generated.wallet.address`).
    let venueAccountRef = params.venueAccountRef != null ? params.venueAccountRef.trim() : null;
    if (params.venue === 'jupiter' && generatedWalletAddress) {
      venueAccountRef = generatedWalletAddress;
    }
    if (params.venue === 'jupiter') {
      const ref = venueAccountRef ?? '';
      if (!ref) {
        return validationFailure({
          field: 'venueAccountRef',
          code: 'account.validation_error.missing_venue_account_ref',
          message: 'venueAccountRef (Solana wallet address) is required for Jupiter venue accounts',
          params: { field: 'venueAccountRef', venue: 'jupiter' },
        });
      }
      if (!isValidSolanaAddress(ref)) {
        return validationFailure({
          field: 'venueAccountRef',
          code: 'account.validation_error.invalid_venue_account_ref',
          message: 'venueAccountRef must be a valid Solana wallet address (32-byte base58-encoded public key)',
          params: { field: 'venueAccountRef', venue: 'jupiter' },
        });
      }
      venueAccountRef = ref;
    }

    // 3. Encrypt the secrets blob BEFORE persistence (credential custody — D2).
    //    getEncryptionKey() reads CREDENTIAL_ENCRYPTION_KEY (env/config); never hard-coded.
    let encryptedData: string;
    let encryptionMeta: { algorithm: string; keyVersion: number };
    try {
      const encryptionKey = getEncryptionKey();
      const secretsJson = JSON.stringify(normalizedSecrets);
      ({ encryptedData, encryptionMeta } = encryptCredential(secretsJson, encryptionKey));
    } catch (err) {
      // A misconfigured encryption key is an internal readiness failure, not a
      // caller error. Never surface the key or the secrets.
      const message = err instanceof Error ? err.message : 'encryption unavailable';
      return {
        success: false,
        fault: true,
        error: `Credential encryption unavailable: ${message}`,
        errorCode: 'provision.encryption_unavailable',
      };
    }

    // NOTE (L3-P1 deferred seam): the copied accounts route ran a best-effort,
    // NON-FATAL venue probe here (`<Adapter>.probe(...)`) to cache a
    // `venueProfile`. Traderton's `@traderton/venues` package did not copy the
    // adapters' `probe` methods, so the probe cannot run without authoring it —
    // which copy-never-author forbids. The account is created regardless
    // (`venueProfile` is a nullable cache column), so provisioning is unaffected.
    // Flagged in docs/003 as a deferred enrichment (re-add when probe is copied).

    const credentialId = crypto.randomUUID();
    const venueAccountId = crypto.randomUUID();
    const now = new Date();

    // 5. ONE transaction: insert credential → insert venue account (linked).
    //    Both succeed or neither. userId → ownerId is the sole data adapt.
    try {
      await db.transaction(async (tx) => {
        await tx.insert(userCredentials).values({
          id: credentialId,
          ownerId,
          provider: params.venue,
          label: params.label,
          encryptedData,
          encryptionMeta,
          createdAt: now,
          updatedAt: now,
        });

        await tx.insert(venueAccounts).values({
          id: venueAccountId,
          ownerId,
          venue: params.venue,
          label: params.label,
          venueAccountRef: venueAccountRef ?? null,
          credentialId,
          createdAt: now,
          updatedAt: now,
        });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      return {
        success: false,
        fault: true,
        error: `Failed to provision venue account: ${message}`,
        errorCode: 'provision.persist_failed',
      };
    }

    // 6. Metadata-only success — NEVER the secrets. In GENERATE mode ADD the
    //    minted wallet's PUBLIC address + network so the caller can surface it
    //    to the owner to fund. The private key/secrets are never returned.
    const wallet =
      generatedWalletAddress != null
        ? { address: generatedWalletAddress, network: generatedNetwork }
        : null;
    return {
      success: true,
      data: {
        venueAccountId,
        venue: params.venue,
        label: params.label,
        wallet,
      },
    };
  },
};

// AUTHORED SEAM (L3-P1c) — the `deprovision_venue_account` boundary tool.
//
// The delete counterpart of provision. Thin route→tool seam over the copied,
// quarantined accounts DELETE handler (`_deferred-authoring/api-routes/accounts.ts`)
// — it authors NO deletion policy. Copied behaviour (verified against CURRENT
// herobids practice, the copy source): block on ANY bot referencing the venue
// account (no status filter) + the FK-`23503` fallback for the pre-check→delete
// race. Adapt (author only this): Fastify route → `AgentTool`; JWT `request.userId`
// → boundary-resolved `ctx.ownerId`; replies → `ToolResult`; and the credential
// CASCADE (delete the account THEN its credential, mirroring `deleteProviderLink`
// — the quarantined single-account handler deleted only the account).
//
// Legal split (L3-P1c §4): this blocks ONLY on Traderton-owned dependents (running
// or otherwise — any `bots` row on the account). The platform-owned blocking checks
// (`connections`/`agent_connections`) STAY in herobids, run BEFORE it calls this.
//
// Metadata-only result — never secrets.
const DeprovisionVenueAccountParamsSchema = z.object({
  venueAccountId: z.string().min(1),
});

type DeprovisionVenueAccountParams = z.infer<typeof DeprovisionVenueAccountParamsSchema>;

const deprovisionVenueAccountTool: AgentTool<TradingToolContext> = {
  name: 'deprovision_venue_account',
  // Owner-scoped write (keyed by venueAccountId); drives no executor. No venue
  // resolution needed.
  ownerScopedNoVenue: true,
  description:
    "Delete a venue account and its trading credential in one step. Refuses (in_use) if any bot references the account. Returns the deleted venueAccountId. Use this to offboard an owner's exchange/wallet; the consumer must first clear its own platform dependents (connections/agent grants).",
  parametersSchema: DeprovisionVenueAccountParamsSchema,
  parameters: convertZodToJsonSchema(DeprovisionVenueAccountParamsSchema),
  category: 'write-database',
  promptGuidance:
    'Provide the venueAccountId to remove. Fails with in_use if a bot still references it. The account and its linked credential are both deleted. Irreversible.',
  async execute(rawParams: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const params = rawParams as DeprovisionVenueAccountParams;

    if (!ctx.db) {
      return {
        success: false,
        fault: true,
        error: 'Database access not available in this context',
        errorCode: 'provision.db_unavailable',
      };
    }
    if (!ctx.ownerId || !ctx.ownerId.trim()) {
      return {
        success: false,
        fault: true,
        error: 'Owner identity not available in this context',
        errorCode: 'provision.owner_unavailable',
      };
    }
    const db = ctx.db as Database;
    const ownerId = ctx.ownerId;
    const { venueAccountId } = params;

    // 1. Load the account, owner-scoped. Capture its credentialId for the cascade.
    //    Absent/unowned → not_found (copied practice: credentials.ts / provider-links.ts).
    const [account] = await db
      .select({ id: venueAccounts.id, credentialId: venueAccounts.credentialId })
      .from(venueAccounts)
      .where(and(eq(venueAccounts.id, venueAccountId), eq(venueAccounts.ownerId, ownerId)));

    if (!account) {
      return {
        success: false,
        fault: false,
        error: `Venue account not found: ${venueAccountId}`,
        errorCode: 'not_found.resource',
      };
    }

    // 2. Fail-closed on ANY bot referencing the account (copied any-bot rule).
    //    bots.venueAccountId is ON DELETE RESTRICT — pre-check, then FK fallback.
    const inUseFailure = (botIds: string[]): ToolResult => ({
      success: false,
      fault: false,
      error: `Venue account ${venueAccountId} is in use by bot(s): ${botIds.join(', ')}`,
      errorCode: 'provision.in_use',
    });

    const blockingBots = await db
      .select({ id: bots.id })
      .from(bots)
      .where(eq(bots.venueAccountId, venueAccountId));
    if (blockingBots.length > 0) {
      return inUseFailure(blockingBots.map((b) => b.id));
    }

    // 3. ONE transaction: delete the venue account FIRST, then its credential.
    //    FK order: venue_accounts.credentialId → userCredentials is ON DELETE
    //    RESTRICT, so the account must go before the credential.
    const credentialId = account.credentialId;
    try {
      await db.transaction(async (tx) => {
        await tx.delete(venueAccounts).where(eq(venueAccounts.id, venueAccountId));
        if (credentialId) {
          await tx.delete(userCredentials).where(eq(userCredentials.id, credentialId));
        }
      });
    } catch (err: unknown) {
      // FK violation — a bot linked between the pre-check and the delete (race).
      // Re-query and return the same in_use failure (never a raw error).
      const pgErr = err as { code?: string };
      if (pgErr.code === '23503') {
        const concurrentBots = await db
          .select({ id: bots.id })
          .from(bots)
          .where(eq(bots.venueAccountId, venueAccountId));
        return inUseFailure(concurrentBots.map((b) => b.id));
      }
      const message = err instanceof Error ? err.message : 'unknown error';
      return {
        success: false,
        fault: true,
        error: `Failed to deprovision venue account: ${message}`,
        errorCode: 'provision.persist_failed',
      };
    }

    // 4. Metadata-only success.
    return {
      success: true,
      data: {
        venueAccountId,
        deleted: true,
      },
    };
  },
};

export const provisioningTools: AgentTool<TradingToolContext>[] = [
  provisionVenueAccountTool,
  deprovisionVenueAccountTool,
];
