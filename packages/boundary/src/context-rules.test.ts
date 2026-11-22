import { describe, it, expect } from 'vitest';
import { isReadOnlyCategory } from '@traderton/domain';
import type { ToolCategory } from '@traderton/domain';
import { canBuildPresetAssessment, skipsVenueResolution } from './context-rules.js';
import { buildToolRegistry } from './registry.js';

const ALL_CATEGORIES: ToolCategory[] = [
  'read-database',
  'read-memory',
  'read-market-data',
  'read-trade',
  'read-web',
  'read-config',
  'read-filesystem',
  'write-database',
  'write-memory',
  'write-messaging',
  'write-filesystem',
  'execute-trade',
  'execute-filesystem',
];

describe('skipsVenueResolution', () => {
  it.each(ALL_CATEGORIES.filter((category) => isReadOnlyCategory(category)))(
    'skips for the read-only category %s, with or without the owner-scoped flag',
    (category) => {
      expect(skipsVenueResolution({ category })).toBe(true);
      expect(skipsVenueResolution({ category, ownerScopedNoVenue: true })).toBe(true);
      expect(skipsVenueResolution({ category, ownerScopedNoVenue: false })).toBe(true);
    },
  );

  it.each(ALL_CATEGORIES.filter((category) => !isReadOnlyCategory(category)))(
    'skips for the non-read category %s only when the tool is owner-scoped with no venue',
    (category) => {
      expect(skipsVenueResolution({ category })).toBe(false);
      expect(skipsVenueResolution({ category, ownerScopedNoVenue: false })).toBe(false);
      expect(skipsVenueResolution({ category, ownerScopedNoVenue: true })).toBe(true);
    },
  );

  it('treats an unregistered tool as the default read-only category, as the factory always did', () => {
    expect(skipsVenueResolution(undefined)).toBe(true);
  });

  describe('against the real tool registry', () => {
    const registry = buildToolRegistry();

    it.each(['list_strategy_presets', 'assess_strategy_preset', 'change_strategy_preset'])(
      'skips venue resolution for %s, so its account can only come from the payload',
      (toolName) => {
        expect(registry.get(toolName), `${toolName} is not registered`).toBeDefined();
        expect(skipsVenueResolution(registry.get(toolName))).toBe(true);
      },
    );

    it('still resolves a venue for a drive-path tool', () => {
      expect(skipsVenueResolution(registry.get('submit_decision'))).toBe(false);
    });
  });
});

describe('canBuildPresetAssessment', () => {
  it('builds for an agent with a resolved venue account', () => {
    expect(canBuildPresetAssessment('agent', 'va-1')).toBe(true);
  });

  it('does not build for an agent whose request resolved no venue account', () => {
    expect(canBuildPresetAssessment('agent', '')).toBe(false);
  });

  it.each(['bot', 'user', 'system', 'unknown-actor', ''])(
    'does not build for a %s subject even with a resolved venue account',
    (actorType) => {
      expect(canBuildPresetAssessment(actorType, 'va-1')).toBe(false);
    },
  );

  it('does not build for a non-agent subject with no account either', () => {
    expect(canBuildPresetAssessment('user', '')).toBe(false);
  });
});
