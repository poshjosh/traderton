// Phase 3 T0.3 — the shared 005 HMAC invocation signing vectors. The fixture is
// byte-identical to herobids packages/domain/src/traderton/__fixtures__/ (it moves
// to external-backend/__fixtures__/ at herobids T1.1), where the herobids signer
// must emit exactly these bytes. Here the REAL verifier must accept every case
// and reject a one-byte mutation. Regenerate only in herobids
// (scripts/ts/generate-signing-vectors.ts), then copy the bytes here.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { AgentTool, ToolResult, TradingToolContext } from '@traderton/domain';
import { ToolRegistry } from '@traderton/worker';
import { createBoundaryApp } from './app.js';
import { authenticateRequest, buildCanonicalString, type BodyAssertions, type SignedRequest } from './auth.js';
import type { BoundaryConfig } from './config.js';
import type {
  BoundaryInvocationStore,
  ComputeRequestFingerprint,
  TradingToolContextFactory,
} from './dispatcher.js';
import { BoundaryFailure } from './result.js';

/** sha256 of the fixture file bytes. Same constant in herobids' signing-vectors.test.ts. */
const SIGNING_VECTORS_SHA256 = '1d4a04b8e92c2baddea4fc8fef787a310d756cfa621d88c11609ad0f9d0520ef';

const FIXTURE_URL = new URL('./__fixtures__/invocation-signing-vectors.json', import.meta.url);
const STATUS_PATH_PREFIX = '/internal/v1/invocations/';

const SigningVectorCaseSchema = z
  .object({
    id: z.string(),
    description: z.string(),
    method: z.enum(['GET', 'POST']),
    requestPath: z.string(),
    signedPath: z.string(),
    timestamp: z.string(),
    deadlineAt: z.string(),
    consumerId: z.string(),
    keyId: z.string(),
    secret: z.string(),
    body: z.string(),
    bodyUtf8ByteLength: z.number().int(),
    bodyUtf16Length: z.number().int(),
    bodySha256: z.string().regex(/^[0-9a-f]{64}$/),
    expectedCanonical: z.string(),
    expectedSignature: z.string().regex(/^sha256=[0-9a-f]{64}$/),
    expectedHeaders: z.record(z.string()),
  })
  .strict();

const SigningVectorFileSchema = z
  .object({
    formatVersion: z.literal(1),
    description: z.string(),
    generator: z.string(),
    secretIsTestOnly: z.literal(true),
    cases: z.array(SigningVectorCaseSchema),
  })
  .strict();

/** The invoke-envelope values the tests read back (value reads only; the raw body is sent as-is). */
const InvokeBodySchema = z.object({
  requestId: z.string(),
  correlationId: z.string(),
  deadlineAt: z.string(),
  caller: z.object({ consumerId: z.string(), keyId: z.string() }),
  payload: z.object({ value: z.string() }),
});

type SigningVectorCase = z.infer<typeof SigningVectorCaseSchema>;

const fixtureBytes = readFileSync(FIXTURE_URL);
const cases = SigningVectorFileSchema.parse(JSON.parse(fixtureBytes.toString('utf8'))).cases;
const postCases = cases.filter((c) => c.method === 'POST');
const getCases = cases.filter((c) => c.method === 'GET');

function caseById(id: string): SigningVectorCase {
  const found = cases.find((c) => c.id === id);
  if (!found) throw new Error(`fixture is missing case ${id}`);
  return found;
}

function configFor(c: SigningVectorCase): BoundaryConfig {
  return {
    clockSkewMs: 30_000,
    idempotencyRetentionHours: 168,
    allowedConsumers: { [c.consumerId]: { keyId: c.keyId, secret: c.secret } },
  };
}

function signedRequestFor(
  c: SigningVectorCase,
  overrides: { path?: string; rawBody?: Buffer; signature?: string } = {},
): SignedRequest {
  const headers = c.expectedHeaders;
  return {
    method: c.method,
    path: overrides.path ?? c.signedPath,
    rawBody: overrides.rawBody ?? Buffer.from(c.body, 'utf8'),
    headers: {
      consumerId: headers['x-traderton-consumer-id'],
      keyId: headers['x-traderton-key-id'],
      timestamp: headers['x-traderton-timestamp'],
      signature: overrides.signature ?? headers['x-traderton-signature'],
      contentType: headers['content-type'],
      deadlineAt: headers['x-request-deadline-at'],
    },
  };
}

function bodyAssertionsFor(c: SigningVectorCase): BodyAssertions | undefined {
  if (c.method !== 'POST') return undefined;
  const body = InvokeBodySchema.parse(JSON.parse(c.body));
  return { consumerId: body.caller.consumerId, keyId: body.caller.keyId, deadlineAt: body.deadlineAt };
}

function authenticate(c: SigningVectorCase, request: SignedRequest) {
  return authenticateRequest(request, configFor(c), Date.parse(c.timestamp), bodyAssertionsFor(c));
}

/** Flip the low bit of the last byte; an empty body gains one byte instead. */
function mutateOneByte(bytes: Buffer): Buffer {
  if (bytes.length === 0) return Buffer.from([0x20]);
  const copy = Buffer.from(bytes);
  const last = copy.length - 1;
  copy.writeUInt8(copy.readUInt8(last) ^ 0x01, last);
  return copy;
}

function mutateLastHexChar(signature: string): string {
  return signature.slice(0, -1) + (signature.endsWith('0') ? '1' : '0');
}

/** Asserts a rejection for the signature itself, not an earlier header/config check. */
function expectSignatureMismatch(run: () => unknown): void {
  let caught: unknown;
  try {
    run();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(BoundaryFailure);
  if (caught instanceof BoundaryFailure) {
    expect(caught.code).toBe('authentication.invalid_caller');
    expect(caught.retryable).toBe(false);
    expect(caught.message).toBe('signature mismatch');
  }
}

describe('invocation signing vectors (shared with herobids)', () => {
  it('fixture file digest equals the recorded constant', () => {
    expect(createHash('sha256').update(fixtureBytes).digest('hex')).toBe(SIGNING_VECTORS_SHA256);
  });

  it.each(cases)('auth buildCanonicalString reproduces the canonical string for $id', (c) => {
    expect(buildCanonicalString(c.method, c.signedPath, c.timestamp, Buffer.from(c.body, 'utf8'))).toBe(
      c.expectedCanonical,
    );
  });

  it.each(cases)('authenticateRequest accepts $id', (c) => {
    expect(authenticate(c, signedRequestFor(c))).toEqual({ consumerId: c.consumerId, keyId: c.keyId });
  });

  it.each(cases)('rejects a one-byte body mutation for $id', (c) => {
    const rawBody = mutateOneByte(Buffer.from(c.body, 'utf8'));
    expectSignatureMismatch(() => authenticate(c, signedRequestFor(c, { rawBody })));
  });

  it.each(cases)('rejects a one-byte signature mutation for $id', (c) => {
    const signature = mutateLastHexChar(c.expectedSignature);
    expectSignatureMismatch(() => authenticate(c, signedRequestFor(c, { signature })));
  });

  it('query case: verifying over requestPath (unstripped) is rejected', () => {
    const c = caseById('status-query-stripped');
    expect(c.requestPath).not.toBe(c.signedPath);
    expectSignatureMismatch(() => authenticate(c, signedRequestFor(c, { path: c.requestPath })));
  });
});

// ── Through the real boundary app (local minimal deps; app.test.ts untouched) ──

const echoParamsSchema = z.object({ value: z.string() });

/** Read-only, so the dispatcher runs it directly and never touches the store. */
const echoVectorTool: AgentTool<TradingToolContext> = {
  name: 'echo_vector',
  description: 'read-only echo (signing-vector fixture)',
  parametersSchema: echoParamsSchema,
  parameters: {},
  category: 'read-config',
  async execute(params: unknown): Promise<ToolResult> {
    const { value } = echoParamsSchema.parse(params);
    return { success: true, data: { echoed: value } };
  },
};

const contextFactory: TradingToolContextFactory = (request) =>
  ({
    agentId: request.actor.id,
    sessionId: `s:${request.ownerId}`,
    executionMode: 'paper',
    authorizationMode: 'approval_required',
    redis: {} as TradingToolContext['redis'],
    publishToInbound: async () => {},
  }) satisfies TradingToolContext;

function storeBypassed(): never {
  throw new Error('read-only tools must bypass the invocation store');
}

/** Every requestId reads back as an in-progress row, so the status route has something to return. */
const inProgressStore: BoundaryInvocationStore = {
  async beginOrResolve() {
    return storeBypassed();
  },
  async complete() {
    return storeBypassed();
  },
  async findByRequestId(requestId) {
    return { requestId, correlationId: `corr-for-${requestId}`, state: 'in_progress', terminalResponse: null };
  },
};

const fingerprint: ComputeRequestFingerprint = (input) => `fp:${input.consumerId}:${input.ownerId}:${input.toolName}`;

function makeApp(c: SigningVectorCase) {
  const registry = new ToolRegistry();
  registry.register(echoVectorTool);
  return createBoundaryApp({
    config: configFor(c),
    registry,
    contextFactory,
    invocationStore: inProgressStore,
    computeRequestFingerprint: fingerprint,
    retentionMs: 168 * 60 * 60 * 1000,
    now: () => Date.parse(c.timestamp),
  });
}

function injectCase(app: ReturnType<typeof makeApp>, c: SigningVectorCase, headers: Record<string, string>) {
  return c.method === 'POST'
    ? app.inject({ method: 'POST', url: c.requestPath, headers, payload: c.body })
    : app.inject({ method: 'GET', url: c.requestPath, headers });
}

describe('invocation signing vectors through the real boundary app', () => {
  it.each(postCases)('POST $id with the recorded headers and body succeeds', async (c) => {
    const envelope = InvokeBodySchema.parse(JSON.parse(c.body));
    const app = makeApp(c);
    try {
      const res = await injectCase(app, c, c.expectedHeaders);
      expect(res.statusCode).toBe(200);
      // `echoed` round-trips the payload, so the non-ASCII case proves the
      // boundary hashes the UTF-8 wire bytes and decodes the payload as UTF-8.
      expect(res.json()).toEqual({
        contractVersion: '1.0',
        requestId: envelope.requestId,
        correlationId: envelope.correlationId,
        outcome: { kind: 'success', payload: { echoed: envelope.payload.value } },
      });
    } finally {
      await app.close();
    }
  });

  it.each(getCases)('GET $id is authenticated by the real app', async (c) => {
    const requestId = c.signedPath.slice(STATUS_PATH_PREFIX.length);
    const app = makeApp(c);
    try {
      // requestPath carries the query for status-query-stripped: this passes only
      // because toSignedRequest strips it before verification.
      const res = await injectCase(app, c, c.expectedHeaders);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        contractVersion: '1.0',
        requestId,
        correlationId: `corr-for-${requestId}`,
        state: 'in_progress',
      });
    } finally {
      await app.close();
    }
  });

  it.each(cases)('$id with a one-character signature mutation is rejected by the real app', async (c) => {
    const headers = { ...c.expectedHeaders, 'x-traderton-signature': mutateLastHexChar(c.expectedSignature) };
    const app = makeApp(c);
    try {
      const res = await injectCase(app, c, headers);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        outcome: {
          kind: 'failure',
          code: 'authentication.invalid_caller',
          message: 'signature mismatch',
          retryable: false,
        },
      });
    } finally {
      await app.close();
    }
  });
});
