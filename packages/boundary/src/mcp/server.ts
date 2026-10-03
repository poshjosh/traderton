// AUTHORED (Phase 3 T2.2) — one low-level MCP `Server` per POST (the stateless
// web-standard transport cannot be reused). `tools/call` dispatches through the
// SAME dispatcher as REST; nothing here authenticates.
import { INTERNAL_ERROR, ProtocolError, Server } from '@modelcontextprotocol/server';
import { createLogger } from '@traderton/worker';
import type { TradertonInvokeResponseV1 } from '../contract.js';
import { identityFor } from '../request-material.js';
import { failureResult, type BoundaryFailure } from '../result.js';
import { MCP_PATH_MAJOR, MCP_SERVER_INFO } from './constants.js';
import type { McpSurfaceConfig } from './surface-config.js';
import { envelopeFromToolCall, toCallToolResult } from './tool-call.js';

const logger = createLogger('mcp');

export interface McpServerDeps {
  surface: McpSurfaceConfig;
  dispatch: (rawBody: unknown, pathMajor: string) => Promise<TradertonInvokeResponseV1>;
  /** A `tools/call` that failed authentication answers with this instead of dispatching. */
  preDispatchFailure?: BoundaryFailure;
}

export function createMcpServer(deps: McpServerDeps): Server {
  const server = new Server(MCP_SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler('tools/list', async () => ({ tools: [...deps.surface.tools] }));

  server.setRequestHandler('tools/call', async (request) => {
    const failure = deps.preDispatchFailure;
    if (failure) {
      return toCallToolResult(
        failureResult(
          identityFor(request.params._meta),
          failure.code,
          failure.message,
          failure.retryable,
          failure.details,
        ),
      );
    }
    const envelope = envelopeFromToolCall(request.params);
    try {
      return toCallToolResult(await deps.dispatch(envelope, MCP_PATH_MAJOR));
    } catch (err) {
      // The outcome is unknown (REST answers 500): never leak the cause, never
      // claim a terminal code — the consumer maps this to a same-key re-issue.
      logger.error(
        {
          requestId: envelope['requestId'],
          toolName: request.params.name,
          err: err instanceof Error ? err.message : String(err),
        },
        'mcp tools/call dispatch threw',
      );
      throw new ProtocolError(INTERNAL_ERROR, 'boundary internal error');
    }
  });

  return server;
}
