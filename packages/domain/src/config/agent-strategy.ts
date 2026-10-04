import crypto from 'node:crypto';
import { z } from 'zod';
import {
  agentStyleToPresetStyle,
  applyPresetToAgent,
  isStyleKey,
  type StyleKey,
} from './presets.js';
import { getPreset } from './presets-loader.js';
import { TechnicalConfigSchema, type TechnicalConfig } from './schema.js';

// ---------------------------------------------------------------------------
// Agent strategy ownership (004 "Agent strategy ownership in the trading
// profile", 2026-10-04). The agent trading profile splits into:
//   - creator inputs (`scanMode`, `creatorStrategy`) written only by herobids;
//   - `activeStrategy` (the resolved config the actor runs) written only by
//     Traderton, derived from the creator inputs on write.
//
// This module owns the two value shapes and the single resolution function the
// tool (boundary validation) and the repository (activeStrategy derivation)
// both call, so they can never diverge. Resolution reads Traderton's own preset
// catalog (`presets-loader`) and `applyPresetToAgent`, matching herobids'
// `apps/api/src/agents/strategy-preset-resolver.ts` (parity-tested).
// ---------------------------------------------------------------------------

/** Scan loop mode. `null` (absent column) means the agent has no scan loop. */
export const SCAN_MODES = ['scanner_gated', 'mixed'] as const;
export type ScanMode = (typeof SCAN_MODES)[number];
export const ScanModeSchema = z.enum(SCAN_MODES);

/**
 * Creator-authored strategy input — exactly one of a preset reference
 * (`{ presetKey, styleTier }`) or a custom technical config
 * (`{ customTechnical }`). Written only by herobids.
 */
export const CreatorStrategySchema = z.union([
  z.object({
    presetKey: z.string().min(1),
    styleTier: z.string().min(1),
  }).strict(),
  z.object({
    customTechnical: TechnicalConfigSchema,
  }).strict(),
]);
export type CreatorStrategy = z.infer<typeof CreatorStrategySchema>;

/**
 * Traderton-derived active strategy — the resolved technical config the actor
 * runs, plus provenance. Written only by Traderton.
 */
export const ActiveStrategySchema = z.object({
  presetKey: z.string().nullable(),
  styleTier: z.string(),
  behaviorVersion: z.string(),
  technical: TechnicalConfigSchema,
  source: z.enum(['creator', 'agent']),
  changedAt: z.string(),
});
export type ActiveStrategy = z.infer<typeof ActiveStrategySchema>;

/** Venue coordinates needed to complete `technical.filters` during resolution. */
export interface ResolveStrategyContext {
  venue: string;
  venueType: 'orderbook' | 'swap';
}

export class StrategyResolutionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'StrategyResolutionError';
  }
}

/**
 * Deterministic 12-char behavior version for a custom technical config, hashed
 * from the resolved config so an unchanged custom config keeps a stable
 * version. Mirrors `computePresetBehaviorVersion`'s hash shape (SHA-256 prefix).
 */
function computeTechnicalBehaviorVersion(technical: TechnicalConfig): string {
  return crypto.createHash('sha256').update(stableJson(technical)).digest('hex').slice(0, 12);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}

/**
 * Resolve a creator strategy input into the active strategy the actor runs.
 *
 * - `{ presetKey, styleTier }`: look up the preset in Traderton's catalog and
 *   split it with `applyPresetToAgent` (same path as herobids), then assemble a
 *   complete `TechnicalConfig` with the venue binding's venue/venueType.
 * - `{ customTechnical }`: used as-is (re-parsed to normalize defaults), with
 *   `presetKey: null` and a hash-derived behavior version.
 *
 * The returned `technical` is a complete, default-filled `TechnicalConfig`.
 * `source` is always `'creator'` here — the agent-driven write path
 * (`source:'agent'`) arrives with the later preset slice.
 *
 * @throws {StrategyResolutionError} when a preset key or style tier is unknown.
 */
export function resolveActiveStrategy(
  creatorStrategy: CreatorStrategy,
  ctx: ResolveStrategyContext,
  changedAt: string,
): ActiveStrategy {
  if ('customTechnical' in creatorStrategy) {
    const technical = TechnicalConfigSchema.parse({
      ...creatorStrategy.customTechnical,
      filters: {
        ...creatorStrategy.customTechnical.filters,
        venue: ctx.venue,
        venueType: ctx.venueType,
      },
    });
    return {
      presetKey: null,
      // Sentinel "no preset style tier" for creator-authored custom technical
      // configs — not operator config; a custom config has no preset lineage.
      styleTier: 'standard',
      behaviorVersion: computeTechnicalBehaviorVersion(technical),
      technical,
      source: 'creator',
      changedAt,
    };
  }

  const presetStyle: StyleKey = isStyleKey(creatorStrategy.styleTier)
    ? creatorStrategy.styleTier
    : agentStyleToPresetStyle(creatorStrategy.styleTier);
  const preset = getPreset(creatorStrategy.presetKey, presetStyle);
  if (!preset) {
    throw new StrategyResolutionError(
      'validation.unknown_preset',
      `No preset '${creatorStrategy.presetKey}' for style tier '${presetStyle}'.`,
    );
  }

  const split = applyPresetToAgent(creatorStrategy.presetKey, preset, presetStyle, 'hybrid');
  const technical = TechnicalConfigSchema.parse({
    filters: { venue: ctx.venue, venueType: ctx.venueType },
    indicators: split.technical.indicators,
    candles: split.technical.candles,
    signalBias: split.technical.signalBias,
    ...(split.technical.scanIntervalMs != null ? { scanIntervalMs: split.technical.scanIntervalMs } : {}),
  });

  return {
    presetKey: split.presetKey,
    styleTier: split.presetStyle,
    behaviorVersion: split.presetBehaviorVersion,
    technical,
    source: 'creator',
    changedAt,
  };
}
