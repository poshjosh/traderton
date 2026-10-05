// AUTHORED (Phase 3 T2.2; rewritten Phase 4 T2) — the MCP surface the boundary
// mounts at `POST /internal/v1/mcp`. Always mounted: consumers discover their
// skills' tools over `tools/list` (ADR 017 §4), so a boundary without the route
// is unusable. `tools/list` is built from Traderton's OWN tool registry (D26 —
// no descriptor file), with each tool tagged by the skill ref(s) it belongs to.

import type { ToolRegistry } from '@traderton/worker';
import { buildToolsFromRegistry, type McpToolDefinition } from './tools-from-registry.js';

export type { McpToolDefinition };

export interface McpSurfaceConfig {
  tools: readonly McpToolDefinition[];
}

/**
 * Build the MCP surface from the tool registry (entry-point fail-fast). Throws
 * on a tool-surface build failure (a mapped tool missing, or a non-object input
 * schema) so a misconfig crashes the process at start.
 */
export function buildMcpSurfaceConfig(registry: ToolRegistry): McpSurfaceConfig {
  const built = buildToolsFromRegistry(registry);
  if (!built.ok) {
    throw new Error(
      `MCP tools/list could not be built from the tool registry: ${built.error.code} — ${built.error.message}`,
    );
  }

  return { tools: built.tools };
}
