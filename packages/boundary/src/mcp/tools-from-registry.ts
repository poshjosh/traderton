// AUTHORED (Phase 4 T2) — build the MCP `tools/list` surface from Traderton's
// OWN tool registry (ADR 017 §4, EC-13), replacing the removed herobids-generated
// descriptor projection (D26). Each advertised tool carries its real `name`,
// `description` and `inputSchema` (the registry's already-computed JSON Schema),
// plus the skill ref(s) it belongs to under the neutral `_meta` key (P4-1).
//
// Only tools that belong to at least one published skill (SKILL_TOOL_MAP) are
// advertised: the skill surface is the consumer contract Phase 4 defines, and a
// tool with no skill ref would have nothing to carry in `_meta`. A consumer's
// visible set is these names intersected with its own registry.

import type { ToolRegistry } from '@traderton/worker';
import { SKILL_REFS_META_KEY, SKILL_TOOL_MAP, buildToolSkillRefs } from './skill-tool-map.js';

/** A tool advertised by `tools/list`, with its skill ref(s) in `_meta`. */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: 'object'; [key: string]: unknown };
  _meta: Record<string, unknown>;
}

/** Failure codes for building the surface (namespaced, AGENTS.md convention). */
export type ToolSurfaceError =
  | 'mcp.skill_tool_missing'
  | 'mcp.tool_schema_not_object';

/**
 * Build the `tools/list` entries from the registry and the skill→tool map.
 *
 * - For every (ref, toolName) in {@link SKILL_TOOL_MAP}, the registry MUST have a
 *   tool with that name — a mapped name absent from the registry is a wiring
 *   defect (`mcp.skill_tool_missing`), surfaced at boundary start (fail-fast).
 * - A tool's `inputSchema` is its registry JSON Schema (`tool.parameters`); its
 *   root MUST be an object schema (MCP requires it) else `mcp.tool_schema_not_object`.
 * - Each entry carries `_meta[SKILL_REFS_META_KEY] = [sorted skill refs]`.
 */
export function buildToolsFromRegistry(
  registry: ToolRegistry,
  skillToolMap: Readonly<Record<string, readonly string[]>> = SKILL_TOOL_MAP,
):
  | { ok: true; tools: McpToolDefinition[] }
  | { ok: false; error: { code: ToolSurfaceError; message: string } } {
  const toolSkillRefs = buildToolSkillRefs(skillToolMap);
  const tools: McpToolDefinition[] = [];

  // Iterate the map (not the registry) so the advertised set is exactly the
  // published-skill tool set, in a stable, declaration-driven order.
  const seen = new Set<string>();
  for (const toolNames of Object.values(skillToolMap)) {
    for (const toolName of toolNames) {
      if (seen.has(toolName)) continue;
      seen.add(toolName);

      const tool = registry.get(toolName);
      if (!tool) {
        return {
          ok: false,
          error: {
            code: 'mcp.skill_tool_missing',
            message: `skill-tool-map names "${toolName}" but the Traderton registry has no such tool`,
          },
        };
      }

      const inputSchema = tool.parameters as Record<string, unknown>;
      if (inputSchema['type'] !== 'object') {
        return {
          ok: false,
          error: {
            code: 'mcp.tool_schema_not_object',
            message: `tool "${toolName}" inputSchema root is not an object schema`,
          },
        };
      }

      const refs = toolSkillRefs.get(toolName) ?? [];
      tools.push({
        name: tool.name,
        description: tool.description,
        inputSchema: inputSchema as { type: 'object'; [key: string]: unknown },
        _meta: { [SKILL_REFS_META_KEY]: [...refs] },
      });
    }
  }

  return { ok: true, tools };
}
