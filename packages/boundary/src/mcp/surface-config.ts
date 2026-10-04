// AUTHORED (Phase 3 T2.2; rewritten Phase 4 T2) — what an operator hands the
// boundary to mount the MCP route, and how `bin.ts` resolves it from the
// environment. Off by default: the route mounts only when
// `BOUNDARY_MCP_ENABLED=true`. `tools/list` is built from Traderton's OWN tool
// registry (ADR 017 §4, D26 — no descriptor file), with each tool tagged by the
// skill ref(s) it belongs to.

import type { ToolRegistry } from '@traderton/worker';
import { buildToolsFromRegistry, type McpToolDefinition } from './tools-from-registry.js';

export type { McpToolDefinition };

export interface McpSurfaceConfig {
  tools: readonly McpToolDefinition[];
}

/** The operator env the MCP surface is resolved from (read only in `bin.ts`). */
export interface McpSurfaceEnv {
  /** `BOUNDARY_MCP_ENABLED` — mounts the route when exactly `'true'`. */
  enabled?: string | undefined;
}

/**
 * Resolve the MCP surface config from operator env (entry-point fail-fast):
 * - `enabled` unset or `'false'` → `undefined` (no route).
 * - `enabled === 'true'` → tools built from Traderton's tool registry.
 * - any other `enabled` value → throw (not a boolean).
 * - a tool-surface build failure (a mapped tool missing, or a non-object input
 *   schema) → throw, so a misconfig crashes the process at start.
 */
export function resolveMcpSurfaceConfig(
  env: McpSurfaceEnv,
  registry: ToolRegistry,
): McpSurfaceConfig | undefined {
  const { enabled } = env;

  if (enabled === undefined || enabled === 'false') {
    return undefined;
  }

  if (enabled !== 'true') {
    throw new Error(`BOUNDARY_MCP_ENABLED must be 'true' or 'false', got '${enabled}'`);
  }

  const built = buildToolsFromRegistry(registry);
  if (!built.ok) {
    throw new Error(
      `MCP tools/list could not be built from the tool registry: ${built.error.code} — ${built.error.message}`,
    );
  }

  return { tools: built.tools };
}
