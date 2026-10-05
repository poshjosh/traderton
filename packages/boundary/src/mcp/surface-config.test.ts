// Phase 3 T2.2 (rewritten Phase 4 T2) — `buildMcpSurfaceConfig` entry-point
// fail-fast behaviour, building tools/list from the tool registry.
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '@traderton/worker';
import { buildMcpSurfaceConfig } from './surface-config.js';
import { buildToolRegistry } from '../registry.js';
import { SKILL_REFS_META_KEY, SKILL_TOOL_MAP } from './skill-tool-map.js';

describe('buildMcpSurfaceConfig', () => {
  it('fails fast when the real tool registry is missing a mapped skill tool', () => {
    // An empty registry cannot satisfy SKILL_TOOL_MAP → start-time crash.
    const registry = new ToolRegistry();
    expect(() => buildMcpSurfaceConfig(registry)).toThrow(
      /could not be built from the tool registry/,
    );
  });

  it('builds the surface from the real production registry', () => {
    const config = buildMcpSurfaceConfig(buildToolRegistry());
    const names = new Set(config.tools.map((t) => t.name));
    // Every tool named by the published skills is served.
    for (const toolNames of Object.values(SKILL_TOOL_MAP)) {
      for (const n of toolNames) expect(names.has(n)).toBe(true);
    }
    // Each served tool carries its skill ref(s) in the neutral _meta key.
    for (const t of config.tools) {
      expect(Array.isArray(t._meta[SKILL_REFS_META_KEY])).toBe(true);
    }
  });

  it('advertises submit_decision (a crypto-trading tool) from the production registry', () => {
    const config = buildMcpSurfaceConfig(buildToolRegistry());
    const submit = config.tools.find((t) => t.name === 'submit_decision');
    expect(submit).toBeDefined();
    expect(submit?._meta[SKILL_REFS_META_KEY]).toEqual(['traderton/skills/crypto-trading']);
  });
});
