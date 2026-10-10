/** Narrowed wake envelope — producer-facing base fields + the scanner wake only (C1.4). */
import { z } from 'zod';
import { MarketAssessmentIdentitySchema } from '../assessment/identity.js';

export const WakePrioritySchema = z.enum(['low', 'normal', 'high']);
export type WakePriority = z.infer<typeof WakePrioritySchema>;

/** Shared wake base fields — herobids reuses these when it re-composes its own envelope. */
export const AgentWakePayloadBaseSchema = z.object({
  wakeId: z.string().min(1),
  reason: z.string().min(1),
  eventIds: z.array(z.string().min(1)),
  priority: WakePrioritySchema,
  requestedAt: z.string().datetime(),
  notBefore: z.string().datetime().optional(),
});
export type AgentWakePayloadBase = z.infer<typeof AgentWakePayloadBaseSchema>;

export const ScannerWakeContextSchema = z.discriminatedUnion('scannerKind', [
  z.object({
    scannerKind: z.literal('signal_scoring'),
    signalCount: z.number().int().min(0),
    topSymbol: z.string().optional(),
    topConfidence: z.number().min(0).max(1).optional(),
    regimePass: z.boolean().nullable().optional(),
  }),
  z.object({
    scannerKind: z.literal('preset_review'),
    /** Reference to the market assessment artifact that triggered this review. */
    assessmentRef: z.string().min(1),
    /** The preset key recommended by the platform assessor. */
    recommendedPreset: z.string().min(1),
    /** The agent's current preset key at the time of the assessment. */
    currentPreset: z.string().min(1),
    /** The relative score uplift of the recommended preset over the current one. Must be non-negative. */
    relativeUplift: z.number().min(0),
    /** The platform assessor's confidence in the recommendation (0-1). */
    confidence: z.number().min(0).max(1),
  }),
  z.object({
    scannerKind: z.literal('assessment_review'),
    /** Bounded advice list — at most one entry per canonical identity. */
    advice: z.array(z.object({
      /** Canonical per-symbol identity for the advised candidate. */
      identity: MarketAssessmentIdentitySchema,
      /** Position in the deterministic scanner ranking (1-based). */
      candidateRank: z.number().int().min(1),
      /** The agent's active preset key at check time. */
      activePreset: z.string().min(1),
      /** Mechanically-derived behavior version at check time. */
      presetBehaviorVersion: z.string().min(1),
      /** Deterministic reason(s) the candidate was advised — cheap facts only, no LLM. */
      reasons: z.array(z.string().min(1)).min(1),
      /** The market assessment artifact ID, if a synchronous assessment was performed. */
      assessmentArtifactId: z.string().min(1).optional(),
      /** The preset key recommended by the platform assessor, if available. */
      recommendedPreset: z.string().min(1).nullable().optional(),
      /** The platform assessor's confidence (0-1), if available. */
      confidence: z.number().min(0).max(1).optional(),
      /** When the assessment artifact expires, if available. */
      expiresAt: z.string().datetime().optional(),
    })).min(1),
    /** When the deterministic pre-check ran. */
    checkedAt: z.string().datetime(),
    /** When the next review is eligible. */
    nextEligibleAt: z.string().datetime(),
  }),
]);
export type ScannerWakeContext = z.infer<typeof ScannerWakeContextSchema>;