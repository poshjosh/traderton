// AUTHORED (Phase 9b item F1) — the Traderton-side caller-verification config
// (005 §Configuration). This lives in the boundary package so no HMAC/HTTP
// concern leaks into `@traderton/worker`/core (the 000 invariant).
//
// F2 adds the `idempotencyRetentionHours` retention key (005 §Deadlines, Retries,
// And Idempotency) — a VALUE, never hard-coded — and the optional per-consumer
// `allowedActorTypes` (005 §Authorization item 3, D4 Option B).

import { z } from 'zod';

/** Default clock-skew window (005 §Configuration example: 30000ms). */
export const DEFAULT_CLOCK_SKEW_MS = 30_000;

/** Default idempotency retention window (005 §Configuration example: 168h). */
export const DEFAULT_IDEMPOTENCY_RETENTION_HOURS = 168;

/**
 * The actor-type values a consumer may assert (005 `subject.actor.type`). D4
 * Option B enforces that the asserted `actor.type` is one the operator
 * configured this consumer to assert — a VALUE, not an invented per-tool rule.
 */
export const ACTOR_TYPES = ['agent', 'bot', 'user', 'system'] as const;

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
    /**
     * The `actor.type` values this consumer is permitted to assert (005
     * §Authorization item 3, D4 Option B). Absent → all four are allowed
     * (back-compat + no surprise tightening). Per-tool provenance rules
     * (Option A) are the docs/010 B3 later-option — intentionally NOT here.
     */
    allowedActorTypes: z.array(z.enum(ACTOR_TYPES)).optional(),
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
    /**
     * Idempotency retention window in hours (005 §Deadlines, Retries, And
     * Idempotency). A VALUE the operator configures; the store never hard-codes
     * it — the dispatcher derives `retentionMs` from this.
     */
    idempotencyRetentionHours: z
      .number()
      .int()
      .min(1)
      .default(DEFAULT_IDEMPOTENCY_RETENTION_HOURS),
    allowedConsumers: z.record(AllowedConsumerSchema).default({}),
  })
  .strict();

export type BoundaryConfig = z.infer<typeof BoundaryConfigSchema>;
