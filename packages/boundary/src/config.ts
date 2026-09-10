// AUTHORED (Phase 9b item F1) — the Traderton-side caller-verification config
// (005 §Configuration). This lives in the boundary package so no HMAC/HTTP
// concern leaks into `@traderton/worker`/core (the 000 invariant).
//
// F1 needs only the auth surface: `allowedConsumers` + `clockSkewMs`. The
// `idempotencyRetentionHours` retention key (005 §Deadlines, Retries, And
// Idempotency) is F2 and intentionally absent here.

import { z } from 'zod';

/** Default clock-skew window (005 §Configuration example: 30000ms). */
export const DEFAULT_CLOCK_SKEW_MS = 30_000;

/**
 * A configured consumer's signing material (005 §Configuration
 * `boundary.allowedConsumers.<consumerId>`). `secretRef` resolves to local
 * signing material and never crosses the boundary.
 */
export const AllowedConsumerSchema = z
  .object({
    keyId: z.string(),
    /** The resolved signing secret (operator config resolves `secretRef`). */
    secret: z.string(),
  })
  .strict();

export type AllowedConsumer = z.infer<typeof AllowedConsumerSchema>;

/**
 * `boundary.*` operator config (005 §Configuration). Keyed by consumerId; each
 * entry names the active keyId + its signing secret.
 */
export const BoundaryConfigSchema = z
  .object({
    clockSkewMs: z.number().int().min(0).default(DEFAULT_CLOCK_SKEW_MS),
    allowedConsumers: z.record(AllowedConsumerSchema).default({}),
  })
  .strict();

export type BoundaryConfig = z.infer<typeof BoundaryConfigSchema>;
