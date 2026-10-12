/** Preset wire/type surface (D2-a Option 1) — schemas + types only, no derivation. */
import { z } from 'zod';

export const PresetEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  strategy: z.object({
    type: z.string(),
    decisionMode: z.enum(['mechanical', 'llm', 'hybrid']).default('mechanical'),
    params: z.record(z.unknown()),
  }),
  risk: z
    .object({
      maxPositionSizePct: z.number().min(0).max(100).optional(),
    })
    .optional(),
  execution: z
    .object({
      mode: z.enum(['paper', 'shadow', 'live']).default('paper'),
    })
    .optional(),
});

export const PresetFileSchema = z.object({
  presets: z.record(PresetEntrySchema),
});

export type PresetEntry = z.infer<typeof PresetEntrySchema>;
export type StyleKey = 'economy' | 'standard' | 'premium';

/**
 * Type-narrowing guard: checks whether a string is a valid StyleKey.
 */
export function isStyleKey(s: string): s is StyleKey {
  return s === 'economy' || s === 'standard' || s === 'premium';
}

/**
 * Map an agent personality style to the corresponding preset style tier.
 */
export function agentStyleToPresetStyle(agentStyle: string): StyleKey {
  switch (agentStyle) {
    case 'careful':
      return 'economy';
    case 'balanced':
      return 'standard';
    case 'bold':
      return 'premium';
    default:
      return 'standard';
  }
}