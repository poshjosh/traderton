// Phase 4 T2 — building the MCP `tools/list` surface from Traderton's own tool
// registry, with each tool tagged by the skill ref(s) it belongs to.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { AgentTool, ToolResult, TradingToolContext } from '@traderton/domain';
import { ToolRegistry } from '@traderton/worker';
import { buildToolsFromRegistry } from './tools-from-registry.js';
import { SKILL_REFS_META_KEY, SKILL_TOOL_MAP, buildToolSkillRefs } from './skill-tool-map.js';

function readTool(name: string): AgentTool<TradingToolContext> {
  return {
    name,
    description: `desc for ${name}`,
    parametersSchema: z.object({}),
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'read-config',
    async execute(): Promise<ToolResult> {
      return { success: true, data: {} };
    },
  };
}

describe('buildToolsFromRegistry', () => {
  it('serves only the tools named by the skill map, each with its skill ref in _meta', () => {
    const registry = new ToolRegistry();
    registry.register(readTool('alpha'));
    registry.register(readTool('beta'));
    registry.register(readTool('gamma')); // not in the fixture map → not advertised
    const map = { 'o/r/skill-a': ['alpha', 'beta'] };

    const built = buildToolsFromRegistry(registry, map);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.tools.map((t) => t.name).sort()).toEqual(['alpha', 'beta']);
    for (const t of built.tools) {
      expect(t._meta[SKILL_REFS_META_KEY]).toEqual(['o/r/skill-a']);
      expect(t.inputSchema['type']).toBe('object');
      expect(t.description).toBe(`desc for ${t.name}`);
    }
  });

  it('dedupes a tool shared by two skills and lists both refs sorted', () => {
    const registry = new ToolRegistry();
    registry.register(readTool('shared'));
    const map = { 'o/r/skill-b': ['shared'], 'o/r/skill-a': ['shared'] };

    const built = buildToolsFromRegistry(registry, map);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.tools).toHaveLength(1);
    expect(built.tools[0]?._meta[SKILL_REFS_META_KEY]).toEqual(['o/r/skill-a', 'o/r/skill-b']);
  });

  it('fails fast when the skill map names a tool the registry does not have', () => {
    const registry = new ToolRegistry();
    const built = buildToolsFromRegistry(registry, { 'o/r/skill-a': ['missing'] });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.code).toBe('mcp.skill_tool_missing');
  });

  it('rejects a tool whose inputSchema root is not an object schema', () => {
    const registry = new ToolRegistry();
    const bad = readTool('bad');
    bad.parameters = { type: 'string' };
    registry.register(bad);
    const built = buildToolsFromRegistry(registry, { 'o/r/skill-a': ['bad'] });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.code).toBe('mcp.tool_schema_not_object');
  });
});

describe('SKILL_TOOL_MAP (the published Traderton skills)', () => {
  it('names the three crypto skills and omits the herobids-owned preset tools from crypto-trading', () => {
    expect(Object.keys(SKILL_TOOL_MAP).sort()).toEqual([
      'traderton/skills/crypto-bot-management',
      'traderton/skills/crypto-risk-monitoring',
      'traderton/skills/crypto-trading',
    ]);
    const trading = SKILL_TOOL_MAP['traderton/skills/crypto-trading'] ?? [];
    expect(trading).not.toContain('assess_strategy_preset');
    expect(trading).not.toContain('change_strategy_preset');
  });

  it('inverts to a tool→refs map that tags shared tools with every owning skill', () => {
    const byTool = buildToolSkillRefs();
    // list_positions belongs to all three skills.
    expect(byTool.get('list_positions')).toEqual([
      'traderton/skills/crypto-bot-management',
      'traderton/skills/crypto-risk-monitoring',
      'traderton/skills/crypto-trading',
    ]);
    // find_instrument belongs only to crypto-trading.
    expect(byTool.get('find_instrument')).toEqual(['traderton/skills/crypto-trading']);
  });
});
