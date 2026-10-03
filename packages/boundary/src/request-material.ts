// AUTHORED (Phase 9b item F1; moved verbatim from app.ts in Phase 3 T2.2) —
// the request-material helpers shared by the REST routes and the MCP route, so
// both bindings authenticate with byte-identical extraction semantics.

import type { FastifyRequest } from 'fastify';
import type { SignedRequest, BodyAssertions } from './auth.js';

/** The parsed body + retained raw bytes for a JSON request. */
export interface ParsedJsonBody {
  parsed: unknown;
  raw: Buffer;
}

export function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Extract the signed-request material from a Fastify request. */
export function toSignedRequest(request: FastifyRequest, rawBody: Buffer): SignedRequest {
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

/**
 * Extract the body values the headers must match exactly (005 §Authentication):
 * the `caller` object and `deadlineAt`. Returns undefined unless all three are
 * present as strings — a partial body cannot be matched, so the header presence
 * checks in `authenticateRequest` remain the gate.
 */
export function extractBodyAssertions(body: unknown): BodyAssertions | undefined {
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

export function identityFor(body: unknown): { requestId: string; correlationId: string } {
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
