// AUTHORED (Phase 9b item F1) — the Fastify boundary app: the 005 endpoints
// (`POST /internal/v1/tools:invoke`, `GET /health/{live,ready}`), an HMAC
// preHandler, and the raw-body retention the canonical string requires.
//
// All HTTP/HMAC concern lives HERE, in the boundary package — it never leaks
// into `@traderton/worker`/core (the 000 invariant). The route is a thin adapter:
// authenticate → dispatch → serialize the terminal `TradertonToolResultV1`.

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { BoundaryConfig } from './config.js';
import { authenticateRequest } from './auth.js';
import {
  extractBodyAssertions,
  identityFor,
  toSignedRequest,
  type ParsedJsonBody,
} from './request-material.js';
import { BoundaryFailure, failureResult } from './result.js';
import {
  ToolInvocationDispatcher,
  type DispatcherDeps,
} from './dispatcher.js';
import { registerMcpRoute } from './mcp/route.js';
import type { McpSurfaceConfig } from './mcp/surface-config.js';

/** The one execution route (005 §Endpoints). */
const INVOKE_PATH = '/internal/v1/tools:invoke';
/** The invocation-status route (005 §Endpoints; F2b). */
const STATUS_PATH = '/internal/v1/invocations/:requestId';
/** The path major for the v1 boundary (005 §Version Compatibility). */
const PATH_MAJOR = '1';

export interface BoundaryAppDeps extends DispatcherDeps {
  config: BoundaryConfig;
  /** Injectable clock — tests pin it; production defaults to `Date.now`. */
  now?: () => number;
  /**
   * The MCP surface (Phase 3 T2.2). When present, `POST /internal/v1/mcp` is
   * mounted over the SAME dispatcher the REST route uses; when absent, no MCP
   * route is registered. Production (`bin.ts`) always supplies it; tests may
   * omit it to build a REST-only app.
   */
  mcp?: McpSurfaceConfig;
}

export function createBoundaryApp(deps: BoundaryAppDeps): FastifyInstance {
  const now = deps.now ?? Date.now;
  const dispatcher = new ToolInvocationDispatcher(deps);

  const app = Fastify({ logger: false });

  // Retain the raw body bytes AND parse JSON — the canonical string hashes the
  // RAW bytes, not a re-serialization (005 §Authentication). Malformed JSON is
  // surfaced as a validation failure by the route, not a Fastify 400, so the
  // parser stores the raw buffer and a parse marker rather than throwing.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => {
      const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
      let parsed: unknown = undefined;
      let parseError = false;
      if (raw.length > 0) {
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          parseError = true;
        }
      }
      const payload: ParsedJsonBody & { parseError: boolean } = { parsed, raw, parseError };
      done(null, payload);
    },
  );

  app.get('/health/live', async (_req, reply: FastifyReply) => {
    // 005 §Deployment And Health: /live confirms the process can serve.
    return reply.code(200).send({ status: 'live' });
  });

  app.get('/health/ready', async (_req, reply: FastifyReply) => {
    // 005 §Deployment And Health: /ready confirms config + boundary validation +
    // the underlying runtime are ready. F1 reflects what F1 wired: config parsed
    // + the dispatcher (registry + context factory) constructed. Full persistence
    // readiness firms up in F2.
    return reply.code(200).send({ status: 'ready' });
  });

  app.post(INVOKE_PATH, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as (ParsedJsonBody & { parseError: boolean }) | undefined;
    const rawBody = body?.raw ?? Buffer.alloc(0);

    // 1. Authenticate BEFORE trusting or dispatching the body (005 §Authentication).
    //    The header/body caller match needs the body caller — but only if the body
    //    parsed. Signature verification itself hashes the raw bytes, so it runs
    //    regardless of JSON validity.
    const parsedBody = body?.parseError ? undefined : body?.parsed;
    const bodyAssertions = extractBodyAssertions(parsedBody);

    try {
      authenticateRequest(toSignedRequest(request, rawBody), deps.config, now(), bodyAssertions);
    } catch (err) {
      if (err instanceof BoundaryFailure) {
        const result = failureResult(
          identityFor(parsedBody),
          err.code,
          err.message,
          err.retryable,
          err.details,
        );
        // Auth failures are a security outcome; return 200 with the typed failure
        // envelope so consumers read the closed union, not an HTTP status
        // (the contract is envelope-typed — 005 §Consumer Result Mapping).
        return reply.code(200).send(result);
      }
      throw err;
    }

    // 2. If the JSON body did not parse, that is a terminal validation failure.
    if (body?.parseError) {
      return reply.code(200).send(
        failureResult(
          { requestId: '', correlationId: '' },
          'validation.invalid_payload',
          'request body is not valid JSON',
          false,
        ),
      );
    }

    // 3. Dispatch (envelope/version/tool/deadline/payload/authz + execute).
    const result = await dispatcher.dispatch(parsedBody, PATH_MAJOR);
    return reply.code(200).send(result);
  });

  // The invocation-status endpoint (005 §Endpoints; F2b). Authenticated the SAME
  // way as tools:invoke — HMAC over the canonical string whose PATH includes the
  // concrete `:requestId` (toSignedRequest strips any query). It reads the
  // idempotency store only; it NEVER triggers a second execution (005). GET has
  // no body, so the canonical string hashes empty bytes and there is no
  // header/body caller match to assert.
  app.get(STATUS_PATH, async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = Buffer.alloc(0);
    try {
      authenticateRequest(toSignedRequest(request, rawBody), deps.config, now());
    } catch (err) {
      if (err instanceof BoundaryFailure) {
        const result = failureResult(
          { requestId: '', correlationId: '' },
          err.code,
          err.message,
          err.retryable,
          err.details,
        );
        return reply.code(200).send(result);
      }
      throw err;
    }

    const { requestId } = request.params as { requestId: string };
    const status = await dispatcher.status(requestId);
    return reply.code(200).send(status);
  });

  // The additive MCP binding (Phase 3 T2.2), mounted only when configured. It
  // reuses the SAME dispatcher instance — the one core, two thin seams rule: the
  // MCP route authors no execution semantics, only parse/authenticate/encode edges.
  if (deps.mcp) {
    registerMcpRoute(app, { config: deps.config, now, dispatcher, surface: deps.mcp });
  }

  return app;
}
