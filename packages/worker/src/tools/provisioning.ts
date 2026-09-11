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
import type { Database } from '@traderton/db';
import { userCredentials, venueAccounts } from '@traderton/db';
import { convertZodToJsonSchema } from './registry.js';
import { encryptCredential, getEncryptionKey } from '../crypto.js';
import { findProviderRegistryEntry } from '../providers/registry.js';
import { canonicalizeProviderSecrets, validateProviderSecrets, type ProviderValidationError } from '../providers/validator.js';

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

const ProvisionVenueAccountParamsSchema = z.object({
  venue: z.string().min(1),
  label: z.string().min(1),
  /** The secrets to encrypt (API key, secret, wallet key, etc.) — never logged or returned. */
  secrets: z.record(z.string()),
  /** Venue-specific reference (e.g. a Solana wallet address for Jupiter). */
  venueAccountRef: z.string().optional(),
});

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
  description:
    "Provision a venue account with its trading credential in one step: validate + encrypt the venue secrets, store them, and create the linked venue account. Returns the new venueAccountId (never the secrets). Use this to onboard an owner's exchange/wallet before creating bots or submitting decisions.",
  parametersSchema: ProvisionVenueAccountParamsSchema,
  parameters: convertZodToJsonSchema(ProvisionVenueAccountParamsSchema),
  category: 'write-database',
  promptGuidance:
    'Provide the venue (e.g. "hyperliquid", "jupiter", "1inch", "bybit"), a display label, and the venue secrets. For Jupiter, venueAccountRef must be a valid Solana wallet address. Secrets are encrypted at rest and are never returned.',
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

    // 1. Canonicalise + validate the venue secrets (copied parity logic).
    const normalizedSecrets = canonicalizeVenueSecrets(params.venue, params.secrets);
    const venueSecretErrors = validateVenueSecrets(params.venue, normalizedSecrets);
    if (venueSecretErrors.length > 0) {
      return validationFailure(venueSecretErrors[0]!);
    }

    // 2. Venue-specific venueAccountRef enforcement (copied Jupiter rule verbatim).
    //    Normalise early so the trimmed value is used for validation + persistence.
    let venueAccountRef = params.venueAccountRef != null ? params.venueAccountRef.trim() : null;
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

    // 6. Metadata-only success — NEVER the secrets.
    return {
      success: true,
      data: {
        venueAccountId,
        venue: params.venue,
        label: params.label,
      },
    };
  },
};

export const provisioningTools: AgentTool<TradingToolContext>[] = [provisionVenueAccountTool];
