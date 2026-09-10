// AUTHORED (Phase 9b item F1) — the Fastify boundary app: the 005 endpoints
// (`POST /internal/v1/tools:invoke`, `GET /health/{live,ready}`), an HMAC
// preHandler, and the raw-body retention the canonical string requires.
//
// All HTTP/HMAC concern lives HERE, in the boundary package — it never leaks
// into `@traderton/worker`/core (the 000 invariant). The route is a thin adapter:
// authenticate → dispatch → serialize the terminal `TradertonToolResultV1`.

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { BoundaryConfig } from './config.js';
import { authenticateRequest, type SignedRequest, type BodyAssertions } from './auth.js';
import { BoundaryFailure, failureResult } from './result.js';
import {
  ToolInvocationDispatcher,
  type DispatcherDeps,
} from './dispatcher.js';

/** The one execution route (005 §Endpoints). */
const INVOKE_PATH = '/internal/v1/tools:invoke';
/** The path major for the v1 boundary (005 §Version Compatibility). */
const PATH_MAJOR = '1';

export interface BoundaryAppDeps extends DispatcherDeps {
  config: BoundaryConfig;
  /** Injectable clock — tests pin it; production defaults to `Date.now`. */
  now?: () => number;
}

/** The parsed body + retained raw bytes for a JSON request. */
interface ParsedJsonBody {
  parsed: unknown;
  raw: Buffer;
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Extract the signed-request material from a Fastify request. */
function toSignedRequest(request: FastifyRequest, rawBody: Buffer): SignedRequest {
  const headers = request.headers;
  return {
    method: request.method,
    // The 005 canonical string signs the PATH only — never the query string.
    // F1's routes take no query, but the F2 status endpoint
    // (`GET /internal/v1/invocations/:requestId`) may; strip any query here so
    // signature verification stays correct as routes grow.
    path: request.url.split('?')[0] ?? request.url,
    rawBody,
    headers: {
      consumerId: headerString(headers['x-traderton-consumer-id']),
      keyId: headerString(headers['x-traderton-key-id']),
      timestamp: headerString(headers['x-traderton-timestamp']),
      signature: headerString(headers['x-traderton-signature']),
      contentType: headerString(headers['content-type']),
      deadlineAt: headerString(headers['x-request-deadline-at']),
    },
  };
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

    // 3. Dispatch (envelope/version/tool/read-only/payload/authz + execute).
    const result = await dispatcher.dispatch(parsedBody, PATH_MAJOR);
    return reply.code(200).send(result);
  });

  return app;
}

/**
 * Extract the body values the headers must match exactly (005 §Authentication):
 * the `caller` object and `deadlineAt`. Returns undefined unless all three are
 * present as strings — a partial body cannot be matched, so the header presence
 * checks in `authenticateRequest` remain the gate.
 */
function extractBodyAssertions(body: unknown): BodyAssertions | undefined {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const caller = record['caller'];
    const deadlineAt = record['deadlineAt'];
    if (caller && typeof caller === 'object' && typeof deadlineAt === 'string') {
      const callerRecord = caller as Record<string, unknown>;
      if (
        typeof callerRecord['consumerId'] === 'string' &&
        typeof callerRecord['keyId'] === 'string'
      ) {
        return {
          consumerId: callerRecord['consumerId'],
          keyId: callerRecord['keyId'],
          deadlineAt,
        };
      }
    }
  }
  return undefined;
}

function identityFor(body: unknown): { requestId: string; correlationId: string } {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    return {
      requestId: typeof record['requestId'] === 'string' ? record['requestId'] : '',
      correlationId:
        typeof record['correlationId'] === 'string' ? record['correlationId'] : '',
    };
  }
  return { requestId: '', correlationId: '' };
}
