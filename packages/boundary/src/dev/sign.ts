// AUTHORED (Phase 9b item F2c) — a committed dev/test HMAC signing helper.
//
// It produces the EXACT 005 canonical string + signed headers the boundary's
// `authenticateRequest` verifies (auth.ts), so the F2c verification tests — and a
// human doing a manual `curl` — can make real signed calls. This is ops/test
// tooling (dependency-light, no HTTP framework, no trading behaviour); it reuses
// `buildCanonicalString` from auth.ts so the signed bytes cannot drift from the
// verifier.
//
// Canonical string (005, exact — see auth.ts):
//   METHOD + "\n" + PATH + "\n" + X-Traderton-Timestamp + "\n" + SHA256(rawBody)
// Signature: `sha256=` + HMAC-SHA256(secret, canonicalString) in hex.
//
// Required headers (005 §Authentication) the helper emits:
//   content-type: application/json
//   x-traderton-consumer-id / x-traderton-key-id / x-traderton-timestamp
//   x-traderton-signature: sha256=<hex>
//   x-request-deadline-at: <same value as body.deadlineAt>

import { createHmac } from 'node:crypto';
import { buildCanonicalString } from '../auth.js';

/** The signing material + caller identity a dev/test caller holds. */
export interface SigningIdentity {
  consumerId: string;
  keyId: string;
  /** The resolved signing secret (never crosses the boundary — local only). */
  secret: string;
}

/** A request to sign. `rawBody` is empty for a GET (the status endpoint). */
export interface SignRequestInput {
  method: string;
  /** The PATH exactly as signed — NO query string (005; the boundary strips it). */
  path: string;
  /** The RAW request-body bytes the SHA256 hashes. Empty Buffer for GET. */
  rawBody?: Buffer;
  /** RFC3339/ISO timestamp for X-Traderton-Timestamp (defaults to now). */
  timestamp?: string;
  /**
   * The `X-Request-Deadline-At` header value. MUST equal the body's `deadlineAt`
   * for a `tools:invoke` call (005; the boundary asserts header ↔ body match).
   * Omit for GET status requests (no body to match against, but the header is
   * still required by the verifier, so a caller-supplied value is used).
   */
  deadlineAt: string;
}

/** The signed headers, lower-cased to match Fastify/HTTP header handling. */
export type SignedHeaders = Record<string, string>;

/**
 * Build the signed headers for a request. Produces the 005 canonical string via
 * the SAME `buildCanonicalString` the verifier uses, HMACs it with the caller's
 * secret, and returns every required header.
 */
export function signRequest(identity: SigningIdentity, input: SignRequestInput): SignedHeaders {
  const rawBody = input.rawBody ?? Buffer.alloc(0);
  const timestamp = input.timestamp ?? new Date().toISOString();

  const canonical = buildCanonicalString(input.method, input.path, timestamp, rawBody);
  const signature = 'sha256=' + createHmac('sha256', identity.secret).update(canonical).digest('hex');

  return {
    'content-type': 'application/json',
    'x-traderton-consumer-id': identity.consumerId,
    'x-traderton-key-id': identity.keyId,
    'x-traderton-timestamp': timestamp,
    'x-traderton-signature': signature,
    'x-request-deadline-at': input.deadlineAt,
  };
}

/**
 * Convenience: sign a `POST /internal/v1/tools:invoke` request from an invocation
 * envelope object. Serializes the envelope to the raw bytes that are BOTH the
 * signed body and the wire payload (they must be identical — the SHA256 hashes
 * these exact bytes), and derives `X-Request-Deadline-At` from `body.deadlineAt`.
 * Returns the signed headers AND the exact raw body to send.
 */
export function signInvoke(
  identity: SigningIdentity,
  invokePath: string,
  envelope: { deadlineAt: string; [k: string]: unknown },
  opts: { timestamp?: string } = {},
): { headers: SignedHeaders; rawBody: string } {
  const rawBody = JSON.stringify(envelope);
  const headers = signRequest(identity, {
    method: 'POST',
    path: invokePath,
    rawBody: Buffer.from(rawBody, 'utf8'),
    ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
    deadlineAt: envelope.deadlineAt,
  });
  return { headers, rawBody };
}

/**
 * Convenience: sign a `GET /internal/v1/invocations/:requestId` status request.
 * GET has no body → the canonical string hashes empty bytes. The verifier still
 * requires `X-Request-Deadline-At`; a caller-supplied value is used (there is no
 * body to match it against for a GET).
 */
export function signStatus(
  identity: SigningIdentity,
  statusPath: string,
  opts: { timestamp?: string; deadlineAt?: string } = {},
): SignedHeaders {
  return signRequest(identity, {
    method: 'GET',
    path: statusPath,
    rawBody: Buffer.alloc(0),
    ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
    deadlineAt: opts.deadlineAt ?? new Date(Date.now() + 30_000).toISOString(),
  });
}
