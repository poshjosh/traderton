// AUTHORED (Phase 9b item F1) — the 005 consumer-boundary contract types.
//
// 005 is a FRESH Traderton contract (herobids has no `tools:invoke`/HMAC
// boundary — its auth is JWT `request.userId`). There is nothing to copy; these
// types transcribe docs/005-consumer-boundary-contract.md exactly. This is
// boundary MACHINERY only — no trading behaviour lives here.

import { z } from 'zod';

/** The single supported contract literal (005 §Invocation Contract). */
export const CONTRACT_VERSION = '1.0' as const;

/**
 * The closed `TradertonBoundaryFailureCode` union (005 §Invocation Contract).
 * Exactly these 10 codes — no others may be returned over the boundary.
 */
export const BOUNDARY_FAILURE_CODES = [
  'validation.invalid_payload',
  'authentication.invalid_caller',
  'authorization.denied',
  'not_found.resource',
  'precondition.not_ready',
  'rate_limit.exceeded',
  'deadline.expired',
  'upstream.transient',
  'internal.non_retryable',
  'contract.unsupported_version',
] as const;

export type TradertonBoundaryFailureCode = (typeof BOUNDARY_FAILURE_CODES)[number];

/**
 * The invocation actor subject (005 §Invocation Contract). Traderton accepts an
 * authenticated `ownerId` + `actor`; it does not resolve identity itself
 * (Fixed Decision 4).
 */
export const InvocationActorSchema = z
  .object({
    type: z.enum(['agent', 'bot', 'user', 'system']),
    id: z.string(),
  })
  .strict();

export const InvocationSubjectSchema = z
  .object({
    ownerId: z.string(),
    actor: InvocationActorSchema,
  })
  .strict();

export const InvocationCallerSchema = z
  .object({
    consumerId: z.string(),
    keyId: z.string(),
  })
  .strict();

/**
 * `TradertonToolInvocationV1` (005 §Invocation Contract). Unknown outer keys are
 * rejected (`.strict()`), per "Unknown keys in the outer request envelope are
 * rejected."
 */
export const TradertonToolInvocationV1Schema = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION),
    requestId: z.string(),
    idempotencyKey: z.string(),
    correlationId: z.string(),
    issuedAt: z.string(),
    deadlineAt: z.string(),
    caller: InvocationCallerSchema,
    subject: InvocationSubjectSchema,
    toolName: z.string(),
    payload: z.unknown(),
  })
  .strict();

export type TradertonToolInvocationV1 = z.infer<typeof TradertonToolInvocationV1Schema>;

/** `TradertonToolResultV1` (005 §Invocation Contract). */
export type TradertonToolResultV1 = {
  contractVersion: typeof CONTRACT_VERSION;
  requestId: string;
  correlationId: string;
  outcome:
    | { kind: 'success'; payload: unknown }
    | {
        kind: 'failure';
        code: TradertonBoundaryFailureCode;
        message: string;
        retryable: boolean;
        details?: Record<string, unknown>;
      };
};
