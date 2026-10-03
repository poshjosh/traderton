// AUTHORED (Phase 3 T2.2) — the MCP binding's fixed wire facts. Field mapping
// and result encoding are normative in herobids Step 10 §2.5.

/** The MCP Streamable HTTP endpoint (legacy 2025-11-25 era, stateless JSON). */
export const MCP_PATH = '/internal/v1/mcp';
/** The path major handed to the dispatcher, exactly as REST's `PATH_MAJOR`. */
export const MCP_PATH_MAJOR = '1';
export const MCP_SERVER_INFO = { name: 'traderton-boundary', version: '0.0.1' } as const;
