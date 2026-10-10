import { z } from 'zod';

// ---------------------------------------------------------------------------
// Creator preset policy (004 "Preset assessment becomes data-only and free",
// 2026-10-04). A creator-authored input written by herobids into the trading
// profile (`preset_policy` jsonb), read-only to the agent. It governs whether
// and how the agent may change its own active strategy preset.
//
// Ownership rule (004 "Agent strategy ownership in the trading profile"): the
// creator writes `preset_policy`; Traderton enforces it. The agent can never
// weaken it. `active_strategy` (Traderton-owned) is unchanged by this.
// ---------------------------------------------------------------------------

/**
 * Creator-authored preset-change policy. Written by herobids from the creator's
 * config (`unifiedConfig.platformAssessment` + `allowedPresets`); read-only to
 * the agent. `changesAllowed: false` or an `allowedPresets` list that excludes a
 * target preset blocks `change_strategy_preset`.
 */
export const PresetPolicySchema = z.object({
  /** Whether the agent may change its own preset at all. */
  changesAllowed: z.boolean(),
  /** Preset keys the creator permits. Empty = no restriction (all presets). */
  allowedPresets: z.array(z.string().min(1)),
  /** Style tier the policy applies to. */
  styleTier: z.string().min(1),
  /** Optional creator-lengthened minimum interval between assessments (ms).
   *  Never shorter than the operator floor. */
  minRequestIntervalMs: z.number().int().positive().optional(),
  /** Optional creator-lengthened cooldown between preset changes (ms).
   *  Never shorter than the operator floor. */
  changeCooldownMs: z.number().int().positive().optional(),
});
export type PresetPolicy = z.infer<typeof PresetPolicySchema>;