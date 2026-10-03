// AUTHORED (Phase 3 T2.2) — project a signed External Backend Descriptor wrapper
// into the `tools/list` shape MCP serves. Traderton SERVES the descriptor's tools
// verbatim; it never verifies the signature — herobids is the sole verifier (DT1,
// D16). The descriptor bytes/encoding and the tools/list cross-check rule are
// normative in herobids Step 10 §3; the shared conformance fixtures
// (src/__fixtures__/descriptor-conformance/) pin both repos to the same shape.

import { ok, err, type Result } from '@traderton/domain';
import { z } from 'zod';

/** A tool advertised by `tools/list` (served, never invented — D16). */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: 'object'; [key: string]: unknown };
}

/** The projection failure codes (namespaced dot-strings, AGENTS.md convention). */
export type DescriptorProjectionError =
  | 'mcp.descriptor_invalid'
  | 'mcp.descriptor_tool_conflict'
  | 'mcp.descriptor_schema_not_object';

const DescriptorToolSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    inputSchema: z.record(z.unknown()),
    category: z.string(),
  })
  .passthrough();

/**
 * The signed descriptor wrapper, loosened to what the projection needs. The
 * canonical bytes, signature and pinning are herobids' verification concern
 * (Step 10 §3); traderton only reads `descriptor.sourceSkills[].tools`.
 */
const DescriptorWrapperSchema = z
  .object({
    descriptor: z
      .object({
        backendId: z.string(),
        sourceSkills: z.array(
          z
            .object({
              ref: z.string(),
              tools: z.array(DescriptorToolSchema),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
    signature: z.string(),
    keyId: z.string(),
  })
  .passthrough();

/**
 * Project a descriptor wrapper into the MCP tool-definition list: the union of
 * every source skill's tools, deduped by name, `category` dropped. A duplicate
 * name whose definitions disagree is a conflict; an `inputSchema` whose root is
 * not an `object` schema is rejected (MCP requires an object input schema).
 */
export function projectDescriptorTools(
  wrapper: unknown,
): Result<McpToolDefinition[], { code: DescriptorProjectionError; message: string }> {
  const parsed = DescriptorWrapperSchema.safeParse(wrapper);
  if (!parsed.success) {
    return err({ code: 'mcp.descriptor_invalid', message: 'descriptor wrapper is malformed' });
  }

  const byName = new Map<string, McpToolDefinition>();
  for (const skill of parsed.data.descriptor.sourceSkills) {
    for (const tool of skill.tools) {
      if (tool.inputSchema['type'] !== 'object') {
        return err({
          code: 'mcp.descriptor_schema_not_object',
          message: `tool ${tool.name} inputSchema root is not an object schema`,
        });
      }
      const definition: McpToolDefinition = {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as { type: 'object'; [key: string]: unknown },
      };
      const existing = byName.get(tool.name);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(definition)) {
          return err({
            code: 'mcp.descriptor_tool_conflict',
            message: `tool ${tool.name} is declared more than once with differing definitions`,
          });
        }
        continue;
      }
      byName.set(tool.name, definition);
    }
  }

  return ok([...byName.values()]);
}
