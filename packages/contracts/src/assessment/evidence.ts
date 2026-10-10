/** Versioned evidence wrapper + volatility evidence (regime & volatility group, C1.5). */
import { z } from 'zod';

/**
 * Versioned, auditable evidence wrapper.
 *
 * Evidence is either available (with a typed value, source, and expiry) or
 * unavailable (with a reason code and message for observability).
 */
export type EvidenceValue<T> =
  | {
      state: 'available';
      value: T;
      source: string;
      observedAt: string;
      expiresAt: string;
    }
  | {
      state: 'unavailable';
      reasonCode: string;
      message: string;
      observedAt: string;
    };

/** Create a Zod schema for EvidenceValue<T> given a value schema for T. */
export function EvidenceValueSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.discriminatedUnion('state', [
    z.object({
      state: z.literal('available'),
      value: valueSchema,
      source: z.string(),
      observedAt: z.string(),
      expiresAt: z.string(),
    }),
    z.object({
      state: z.literal('unavailable'),
      reasonCode: z.string(),
      message: z.string(),
      observedAt: z.string(),
    }),
  ]);
}

export interface VolatilityEvidence {
  averageTrueRange: number;
  volatilityRegime: 'low' | 'normal' | 'high' | 'extreme';
  calculationVersion: string;
}

export const VolatilityEvidenceSchema = z.object({
  averageTrueRange: z.number().nonnegative(),
  volatilityRegime: z.enum(['low', 'normal', 'high', 'extreme']),
  calculationVersion: z.string().min(1),
});