// AUTHORED (Phase 9b item F1) — HMAC-SHA-256 request authentication
// (005 §Authentication And Authorization). Boundary machinery only; no HTTP
// framework type appears here so the algorithm is unit-testable in isolation.
//
// Canonical string (005, exact):
//   METHOD + "\n" + PATH + "\n" + X-Traderton-Timestamp + "\n" + SHA256(raw JSON body)
//
// Any mismatch → `authentication.invalid_caller` BEFORE authorization or any
// dispatch (raised as a `BoundaryFailure`).

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { BoundaryConfig } from './config.js';
import { BoundaryFailure } from './result.js';

/** The verified caller identity, once the signature checks out. */
export interface VerifiedCaller {
  consumerId: string;
  keyId: string;
}

/** The request material the verifier reads (transport-agnostic). */
export interface SignedRequest {
  method: string;
  /** The request PATH exactly as signed (no query string in F1's endpoints). */
  path: string;
  /** Raw request body bytes — the SHA256 input MUST be the bytes, not re-serialized JSON. */
  rawBody: Buffer;
  headers: {
    consumerId?: string;
    keyId?: string;
    timestamp?: string;
    signature?: string;
    contentType?: string;
    deadlineAt?: string;
  };
}

const SIGNATURE_PREFIX = 'sha256=';

function invalidCaller(message: string): BoundaryFailure {
  // `authentication.invalid_caller` is never retryable — a bad signature will
  // not become valid on retry (005 §Consumer Result Mapping).
  return new BoundaryFailure('authentication.invalid_caller', message, false);
}

/** Build the exact 005 canonical string for a request. */
export function buildCanonicalString(
  method: string,
  path: string,
  timestamp: string,
  rawBody: Buffer,
): string {
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  return `${method}\n${path}\n${timestamp}\n${bodyHash}`;
}

/** Constant-time hex-digest comparison (005: "constant-time signature comparison"). */
function constantTimeHexEqual(a: string, b: string): boolean {
  // timingSafeEqual requires equal-length buffers; a length mismatch is itself a
  // non-match, but comparing against a fixed-length buffer keeps the compare
  // constant-time regardless of the presented value.
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Parse an RFC3339/ISO timestamp to epoch ms, or null if unparseable. */
function parseTimestampMs(timestamp: string): number | null {
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Authenticate a signed request against the operator config. Returns the
 * verified caller on success; throws `BoundaryFailure('authentication.invalid_caller')`
 * on any mismatch — before authorization or dispatch.
 *
 * The `bodyAssertions` argument carries the parsed body values the headers must
 * match exactly (005 §Authentication): the `caller` object
 * (`X-Traderton-Consumer-Id`/`X-Traderton-Key-Id`) and `deadlineAt`
 * (`X-Request-Deadline-At: <same value as body.deadlineAt>`). They are passed
 * separately because they are only trustworthy after the envelope parses; the
 * route supplies them once known. A mismatch fails with
 * `authentication.invalid_caller` before authorization or side effects.
 */
export interface BodyAssertions {
  consumerId: string;
  keyId: string;
  deadlineAt: string;
}

export function authenticateRequest(
  request: SignedRequest,
  config: BoundaryConfig,
  now: number,
  bodyAssertions?: BodyAssertions,
): VerifiedCaller {
  const { headers } = request;

  // Required headers (005 §Authentication).
  if (!headers.contentType || !headers.contentType.startsWith('application/json')) {
    throw invalidCaller('Content-Type must be application/json');
  }
  if (!headers.consumerId) throw invalidCaller('missing X-Traderton-Consumer-Id');
  if (!headers.keyId) throw invalidCaller('missing X-Traderton-Key-Id');
  if (!headers.timestamp) throw invalidCaller('missing X-Traderton-Timestamp');
  if (!headers.signature) throw invalidCaller('missing X-Traderton-Signature');
  if (!headers.deadlineAt) throw invalidCaller('missing X-Request-Deadline-At');

  // The consumer + key must be configured (005: "accepts only configured
  // consumer IDs and key IDs").
  const consumer = config.allowedConsumers[headers.consumerId];
  if (!consumer || consumer.keyId !== headers.keyId) {
    throw invalidCaller('unknown consumer or key');
  }

  // Clock-skew window (005: "rejects timestamps outside the configured
  // clock-skew window").
  const tsMs = parseTimestampMs(headers.timestamp);
  if (tsMs === null) {
    throw invalidCaller('invalid X-Traderton-Timestamp');
  }
  if (Math.abs(now - tsMs) > config.clockSkewMs) {
    throw invalidCaller('timestamp outside clock-skew window');
  }

  // Signature form: `sha256=<hex>`.
  if (!headers.signature.startsWith(SIGNATURE_PREFIX)) {
    throw invalidCaller('malformed signature');
  }
  const presented = headers.signature.slice(SIGNATURE_PREFIX.length);

  const canonical = buildCanonicalString(
    request.method,
    request.path,
    headers.timestamp,
    request.rawBody,
  );
  const expected = createHmac('sha256', consumer.secret).update(canonical).digest('hex');

  if (!constantTimeHexEqual(presented, expected)) {
    throw invalidCaller('signature mismatch');
  }

  // Header ↔ body exact match (005: "The header values and the body `caller`
  // fields must match exactly" + "X-Request-Deadline-At: <same value as
  // body.deadlineAt>").
  if (bodyAssertions) {
    if (
      bodyAssertions.consumerId !== headers.consumerId ||
      bodyAssertions.keyId !== headers.keyId
    ) {
      throw invalidCaller('caller header/body mismatch');
    }
    if (bodyAssertions.deadlineAt !== headers.deadlineAt) {
      throw invalidCaller('deadline header/body mismatch');
    }
  }

  return { consumerId: headers.consumerId, keyId: headers.keyId };
}
