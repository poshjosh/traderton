// AUTHORED (Phase 3 T2.2) — what an operator hands the boundary to mount the MCP
// route, and how `bin.ts` resolves it from the environment. Off by default: the
// route mounts only when `BOUNDARY_MCP_ENABLED=true`; `tools/list` serves the
// configured descriptor's tools (D16 — served, never invented), empty when none.

import { projectDescriptorTools, type McpToolDefinition } from './descriptor-tools.js';

export type { McpToolDefinition };

export interface McpSurfaceConfig {
  tools: readonly McpToolDefinition[];
}

/** The operator env the MCP surface is resolved from (read only in `bin.ts`). */
export interface McpSurfaceEnv {
  /** `BOUNDARY_MCP_ENABLED` — mounts the route when exactly `'true'`. */
  enabled?: string | undefined;
  /** `BOUNDARY_MCP_DESCRIPTOR_PATH` — optional signed descriptor wrapper JSON. */
  descriptorPath?: string | undefined;
}

/**
 * Resolve the MCP surface config from operator env (entry-point fail-fast):
 * - `enabled` unset or `'false'` → `undefined` (no route). A descriptor path set
 *   while disabled is an operator mistake → throw.
 * - `enabled === 'true'` → tools from the descriptor file (or `[]` when no path).
 * - any other `enabled` value → throw (not a boolean).
 * - an unreadable or invalid descriptor file → throw.
 * `readFile` is injected so tests drive it without touching the filesystem.
 */
export function resolveMcpSurfaceConfig(
  env: McpSurfaceEnv,
  readFile: (path: string) => string,
): McpSurfaceConfig | undefined {
  const { enabled, descriptorPath } = env;

  if (enabled === undefined || enabled === 'false') {
    if (descriptorPath !== undefined && descriptorPath !== '') {
      throw new Error(
        'BOUNDARY_MCP_DESCRIPTOR_PATH is set but BOUNDARY_MCP_ENABLED is not true',
      );
    }
    return undefined;
  }

  if (enabled !== 'true') {
    throw new Error(`BOUNDARY_MCP_ENABLED must be 'true' or 'false', got '${enabled}'`);
  }

  if (descriptorPath === undefined || descriptorPath === '') {
    return { tools: [] };
  }

  let contents: string;
  try {
    contents = readFile(descriptorPath);
  } catch (cause) {
    throw new Error(`failed to read BOUNDARY_MCP_DESCRIPTOR_PATH (${descriptorPath})`, { cause });
  }

  let wrapper: unknown;
  try {
    wrapper = JSON.parse(contents);
  } catch (cause) {
    throw new Error(`BOUNDARY_MCP_DESCRIPTOR_PATH (${descriptorPath}) is not valid JSON`, { cause });
  }

  const projected = projectDescriptorTools(wrapper);
  if (!projected.ok) {
    throw new Error(
      `BOUNDARY_MCP_DESCRIPTOR_PATH (${descriptorPath}) is not a serviceable descriptor: ${projected.error.code} — ${projected.error.message}`,
    );
  }

  return { tools: projected.data };
}
