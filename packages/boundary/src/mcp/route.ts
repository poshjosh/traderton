// AUTHORED (Phase 3 T2.2) — `POST /internal/v1/mcp` on the existing boundary
// app. Every POST is authenticated by the UNMODIFIED `authenticateRequest` over
// the raw bytes the shared content-type parser kept; the SDK transport receives
// the already-parsed body and never reads the stream. The route authors ZERO
// execution semantics — it parses a JSON-RPC frame into the 005 envelope and
// calls the SAME dispatcher the REST route calls (Step 10 §2.5).
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticateRequest } from '../auth.js';
import type { BoundaryConfig } from '../config.js';
import type { ToolInvocationDispatcher } from '../dispatcher.js';
import { extractBodyAssertions, toSignedRequest, type ParsedJsonBody } from '../request-material.js';
import { BoundaryFailure, failureResult } from '../result.js';
import { MCP_PATH } from './constants.js';
import { isToolsCallFrame, jsonRpcErrorBody, requestIdOf } from './jsonrpc.js';
import { createMcpServer } from './server.js';
import type { McpSurfaceConfig } from './surface-config.js';

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_SERVER_ERROR = -32000;

export interface McpRouteDeps {
  config: BoundaryConfig;
  now: () => number;
  dispatcher: Pick<ToolInvocationDispatcher, 'dispatch'>;
  surface: McpSurfaceConfig;
}

function toWebHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(', '));
  }
  return headers;
}

export function registerMcpRoute(app: FastifyInstance, deps: McpRouteDeps): void {
  app.post(MCP_PATH, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as (ParsedJsonBody & { parseError: boolean }) | undefined;
    const rawBody = body?.raw ?? Buffer.alloc(0);
    const parsed = body?.parseError ? undefined : body?.parsed;
    const toolsCall = isToolsCallFrame(parsed);

    // 1. Authenticate first, exactly like REST. Header ↔ body assertions apply
    //    to tools/call only, with REST's extraction semantics over `_meta`.
    let preDispatchFailure: BoundaryFailure | undefined;
    try {
      authenticateRequest(
        toSignedRequest(request, rawBody),
        deps.config,
        deps.now(),
        toolsCall ? extractBodyAssertions(parsed.params._meta) : undefined,
      );
    } catch (err) {
      if (!(err instanceof BoundaryFailure)) throw err;
      if (!toolsCall) {
        const data = failureResult(
          { requestId: '', correlationId: '' },
          err.code,
          err.message,
          err.retryable,
          err.details,
        );
        const id = requestIdOf(parsed);
        if (id !== undefined) {
          return reply.code(200).send(jsonRpcErrorBody(id, JSONRPC_SERVER_ERROR, err.message, data));
        }
        return reply.code(401).send(jsonRpcErrorBody(null, JSONRPC_SERVER_ERROR, err.message, data));
      }
      preDispatchFailure = err;
    }

    if (body?.parseError) {
      return reply.code(400).send(jsonRpcErrorBody(null, JSONRPC_PARSE_ERROR, 'Parse error'));
    }
    if (Array.isArray(parsed)) {
      return reply
        .code(400)
        .send(jsonRpcErrorBody(null, JSONRPC_INVALID_REQUEST, 'batch requests are not supported'));
    }

    // 2. One Server + one stateless JSON transport per POST.
    const server = createMcpServer({
      surface: deps.surface,
      dispatch: (envelope, pathMajor) => deps.dispatcher.dispatch(envelope, pathMajor),
      ...(preDispatchFailure ? { preDispatchFailure } : {}),
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(
        new Request(`http://boundary${MCP_PATH}`, { method: 'POST', headers: toWebHeaders(request) }),
        { parsedBody: parsed },
      );
      reply.code(response.status);
      response.headers.forEach((value, name) => {
        reply.header(name, value);
      });
      const text = await response.text();
      return reply.send(text.length > 0 ? text : undefined);
    } finally {
      await server.close();
    }
  });

  // Stateless endpoint: no standalone SSE stream, no sessions to delete.
  app.route({
    method: ['GET', 'DELETE'],
    url: MCP_PATH,
    handler: async (_request, reply) =>
      reply
        .code(405)
        .header('allow', 'POST')
        .send(jsonRpcErrorBody(null, JSONRPC_SERVER_ERROR, 'Method not allowed.')),
  });
}
