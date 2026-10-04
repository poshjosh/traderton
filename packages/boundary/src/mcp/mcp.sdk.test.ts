// Phase 3 T2.2 (promoted gate-1 leg A) — the REAL official SDK client talks to
// the REAL `createBoundaryApp` (listening on an ephemeral port) through a fetch
// middleware that signs with the committed dev signer (`dev/sign.ts`, which
// reuses `auth.ts` `buildCanonicalString`). Nothing on the auth path is stubbed.
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client, SdkError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { AgentTool, ToolResult, TradingToolContext } from '@traderton/domain';
import { ToolRegistry } from '@traderton/worker';
import type { FastifyInstance } from 'fastify';
import { createBoundaryApp } from '../app.js';
import type { BoundaryConfig } from '../config.js';
import type { BoundaryInvocationStore, TradingToolContextFactory } from '../dispatcher.js';
import { signRequest, type SigningIdentity } from '../dev/sign.js';
import { buildToolsFromRegistry } from './tools-from-registry.js';
import { SKILL_REFS_META_KEY } from './skill-tool-map.js';
import { MCP_PATH } from './constants.js';
import { ENVELOPE_META_KEYS } from './tool-call.js';

// Phase 4 T2: the MCP surface is built from a ToolRegistry (not a descriptor
// file). This fixture skill-tool map tags the SDK fixture tools so the real
// `buildToolsFromRegistry` path is exercised end-to-end.
const FIXTURE_SKILL_REF = 'example/fixtures/sdk-read-tools';
const FIXTURE_SKILL_TOOL_MAP = {
  [FIXTURE_SKILL_REF]: ['echo_read', 'slow_read', 'fail_read'],
};

const IDENTITY: SigningIdentity = {
  consumerId: 'herobids',
  keyId: 'sdk-key',
  secret: 'sdk-test-only-secret',
};

const CONFIG: BoundaryConfig = {
  clockSkewMs: 30_000,
  idempotencyRetentionHours: 168,
  allowedConsumers: { [IDENTITY.consumerId]: { keyId: IDENTITY.keyId, secret: IDENTITY.secret } },
};

const toolRuns = { echo: 0 };

const echoReadTool: AgentTool<TradingToolContext> = {
  name: 'echo_read',
  description: 'read-only echo (sdk fixture)',
  parametersSchema: z.object({ value: z.string() }),
  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  category: 'read-config',
  async execute(params: unknown): Promise<ToolResult> {
    toolRuns.echo += 1;
    const { value } = z.object({ value: z.string() }).parse(params);
    return { success: true, data: { echoed: value } };
  },
};

const slowReadTool: AgentTool<TradingToolContext> = {
  name: 'slow_read',
  description: 'read-only, answers after 1.2 s (sdk fixture)',
  parametersSchema: z.object({}),
  parameters: { type: 'object', properties: {}, required: [] },
  category: 'read-config',
  async execute(): Promise<ToolResult> {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    return { success: true, data: { slow: true } };
  },
};

const failReadTool: AgentTool<TradingToolContext> = {
  name: 'fail_read',
  description: 'read-only, non-retryable content failure (sdk fixture)',
  parametersSchema: z.object({}),
  parameters: { type: 'object', properties: {}, required: [] },
  category: 'read-config',
  async execute(): Promise<ToolResult> {
    return { success: false, error: 'nope', fault: false, retryable: false };
  },
};

const CONTEXT_FACTORY: TradingToolContextFactory = (request) => ({
  agentId: request.actor.id,
  sessionId: `s:${request.ownerId}`,
  executionMode: 'paper',
  authorizationMode: 'direct',
  redis: {} as TradingToolContext['redis'],
  publishToInbound: async () => {},
});

const STORE: BoundaryInvocationStore = {
  async beginOrResolve() {
    return { kind: 'started', id: 'row-1' };
  },
  async complete() {},
  async findByRequestId() {
    return null;
  },
};

interface SendRecord {
  method: string;
  rpcMethod: string | undefined;
  bodyType: string;
  body: string | undefined;
  sha256: string;
  status?: number;
}

type Tamper = 'none' | 'flip_meta_byte';

const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function describeBody(body: unknown): string {
  if (body === undefined) return 'undefined';
  if (body === null) return 'null';
  return typeof body === 'string' ? 'string' : Object.prototype.toString.call(body);
}

function rpcMethodOf(body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  const parsed: unknown = JSON.parse(body);
  return typeof parsed === 'object' && parsed !== null && 'method' in parsed && typeof parsed.method === 'string'
    ? parsed.method
    : undefined;
}

/** Flip one byte inside `_meta` (the last digit of the idempotency key) AFTER signing. */
function flipByteInMeta(body: string): string {
  const bytes = Buffer.from(body, 'utf8');
  const metaAt = bytes.indexOf('"_meta"');
  const keyAt = bytes.indexOf('idem-sdk', metaAt);
  if (metaAt < 0 || keyAt < 0) throw new Error('tamper target not found in _meta');
  const target = keyAt + 'idem-sdk'.length;
  bytes[target] = (bytes[target] ?? 0) ^ 0x01;
  return bytes.toString('utf8');
}

function createSigningFetch(opts: { deadlineAt: string; sends: SendRecord[]; tamper?: Tamper }): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body;
    const bodyType = describeBody(body);
    if (body !== undefined && body !== null && typeof body !== 'string') {
      throw new TypeError(`gate-1 tripwire: non-string ${bodyType} body`);
    }
    const bodyText = body ?? '';
    const rawBody = Buffer.from(bodyText, 'utf8');
    const rpcMethod = rpcMethodOf(body ?? undefined);
    const isToolsCall = rpcMethod === 'tools/call';
    const signed = signRequest(IDENTITY, { method, path: MCP_PATH, rawBody, deadlineAt: opts.deadlineAt });
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(signed)) headers.set(name, value);
    const wireBody =
      opts.tamper === 'flip_meta_byte' && isToolsCall && typeof body === 'string' ? flipByteInMeta(body) : body;
    const record: SendRecord = {
      method,
      rpcMethod,
      bodyType,
      body: typeof body === 'string' ? body : undefined,
      sha256: sha256Hex(rawBody),
    };
    opts.sends.push(record);
    const response = await fetch(url, { ...init, headers, body: wireBody });
    record.status = response.status;
    return response;
  };
}

describe('MCP SDK client ↔ the real boundary route', () => {
  let app: FastifyInstance;
  let baseUrl: URL;

  beforeAll(async () => {
    const registry = new ToolRegistry();
    registry.register(echoReadTool);
    registry.register(slowReadTool);
    registry.register(failReadTool);
    const built = buildToolsFromRegistry(registry, FIXTURE_SKILL_TOOL_MAP);
    if (!built.ok) throw new Error(`tool surface did not build: ${built.error.code}`);
    app = createBoundaryApp({
      config: CONFIG,
      registry,
      contextFactory: CONTEXT_FACTORY,
      invocationStore: STORE,
      computeRequestFingerprint: (input) => `fp:${input.consumerId}:${input.toolName}`,
      retentionMs: 168 * 60 * 60 * 1000,
      mcp: { tools: built.tools },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    baseUrl = new URL(`http://127.0.0.1:${address.port}${MCP_PATH}`);
  });

  afterAll(async () => {
    await app.close();
  });

  function envelopeMeta(overrides: { caller?: { consumerId: string; keyId: string } } = {}) {
    const now = Date.now();
    return {
      contractVersion: '1.0',
      requestId: `req-${now}`,
      idempotencyKey: 'idem-sdk-1',
      correlationId: 'corr-ü-🚀',
      issuedAt: new Date(now).toISOString(),
      deadlineAt: new Date(now + 30_000).toISOString(),
      caller: overrides.caller ?? { consumerId: IDENTITY.consumerId, keyId: IDENTITY.keyId },
      subject: { ownerId: 'owner-1', actor: { type: 'agent', id: 'actor-1' } },
    };
  }

  async function connectClient(deadlineAt: string, sends: SendRecord[], tamper: Tamper = 'none') {
    const client = new Client({ name: 'sdk-leg-a', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(baseUrl, {
      fetch: createSigningFetch({ deadlineAt, sends, tamper }),
    });
    await client.connect(transport);
    return client;
  }

  it('initialize, notifications/initialized and tools/call from the official client all authenticate against the boundary', async () => {
    const sends: SendRecord[] = [];
    const meta = envelopeMeta();
    const client = await connectClient(meta.deadlineAt, sends);
    const result = await client.callTool({ name: 'echo_read', arguments: { value: 'hi' }, _meta: meta });
    await client.close();

    expect(sends.map((s) => `${s.method} ${s.rpcMethod ?? ''}`.trim())).toEqual([
      'POST initialize',
      'POST notifications/initialized',
      'GET',
      'POST tools/call',
    ]);
    const posts = sends.filter((s) => s.method === 'POST');
    for (const send of posts) expect(send.bodyType).toBe('string');
    expect(posts.find((s) => s.rpcMethod === 'initialize')?.status).toBe(200);
    expect(posts.find((s) => s.rpcMethod === 'notifications/initialized')?.status).toBe(202);
    expect(posts.find((s) => s.rpcMethod === 'tools/call')?.status).toBe(200);
    expect(result.isError).toBeUndefined();
  });

  it('the bytes the client signs contain params._meta exactly as sent and the server receives the same bytes', async () => {
    const sends: SendRecord[] = [];
    const meta = envelopeMeta();
    const client = await connectClient(meta.deadlineAt, sends);
    const result = await client.callTool({ name: 'echo_read', arguments: { value: 'hi' }, _meta: meta });
    await client.close();

    // What the middleware signed carries _meta verbatim (same bytes the server hashed).
    const toolsCall = sends.find((s) => s.rpcMethod === 'tools/call');
    const wireMeta: unknown = JSON.parse(toolsCall?.body ?? '{}').params._meta;
    expect(wireMeta).toStrictEqual(meta);
    expect(Object.keys(meta).sort()).toEqual([...ENVELOPE_META_KEYS].sort());
    // The server accepted those exact bytes (authenticated) and echoed the identity
    // it parsed from _meta — proof the server received the same _meta.
    expect(result.structuredContent).toMatchObject({
      requestId: meta.requestId,
      correlationId: meta.correlationId,
      outcome: { kind: 'success', payload: { echoed: 'hi' } },
    });
  });

  it('a byte flipped inside _meta after signing is rejected as authentication.invalid_caller', async () => {
    const runsBefore = toolRuns.echo;
    const sends: SendRecord[] = [];
    const meta = envelopeMeta();
    const client = await connectClient(meta.deadlineAt, sends, 'flip_meta_byte');
    const result = await client.callTool({ name: 'echo_read', arguments: { value: 'hi' }, _meta: meta });
    await client.close();

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      outcome: { kind: 'failure', code: 'authentication.invalid_caller', retryable: false },
    });
    expect(toolRuns.echo).toBe(runsBefore);
  });

  it('the client SSE GET is answered 405 and the session stays usable', async () => {
    const sends: SendRecord[] = [];
    const meta = envelopeMeta();
    const client = await connectClient(meta.deadlineAt, sends);
    // The standalone SSE GET is opened asynchronously after the 202 to
    // notifications/initialized; a completed call guarantees it has been issued.
    const result = await client.callTool({ name: 'echo_read', arguments: { value: 'ok' }, _meta: meta });
    await client.close();
    expect(sends.find((s) => s.method === 'GET')?.status).toBe(405);
    expect(result.isError).toBeUndefined();
  });

  it('a client-side timeout\'s notifications/cancelled is signed and accepted', async () => {
    const sends: SendRecord[] = [];
    const meta = envelopeMeta();
    const client = await connectClient(meta.deadlineAt, sends);
    const timedOut = await client
      .callTool({ name: 'slow_read', arguments: {}, _meta: meta }, { timeout: 300 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(timedOut).toBeInstanceOf(SdkError);

    const deadline = Date.now() + 3_000;
    let cancelled: SendRecord | undefined;
    while (Date.now() < deadline) {
      cancelled = sends.find((s) => s.rpcMethod === 'notifications/cancelled' && s.status !== undefined);
      if (cancelled) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await client.close();
    expect(cancelled?.bodyType).toBe('string');
    expect(cancelled?.status).toBe(202);
  });

  it('an isError tool result reaches the client with the closed failure code and retryable flag intact', async () => {
    const sends: SendRecord[] = [];
    const meta = envelopeMeta();
    const client = await connectClient(meta.deadlineAt, sends);
    const result = await client.callTool({ name: 'fail_read', arguments: {}, _meta: meta });
    await client.close();
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      outcome: { kind: 'failure', code: 'validation.invalid_payload', retryable: false },
    });
  });

  it('tools/list from the client serves the registry-built surface with skill refs in _meta', async () => {
    const registry = new ToolRegistry();
    registry.register(echoReadTool);
    registry.register(slowReadTool);
    registry.register(failReadTool);
    const built = buildToolsFromRegistry(registry, FIXTURE_SKILL_TOOL_MAP);
    if (!built.ok) throw new Error(`tool surface did not build: ${built.error.code}`);

    const sends: SendRecord[] = [];
    const meta = envelopeMeta();
    const client = await connectClient(meta.deadlineAt, sends);
    const listed = await client.listTools();
    await client.close();

    expect(listed.tools.map((t) => t.name).sort()).toEqual(built.tools.map((t) => t.name).sort());
    for (const declared of built.tools) {
      const served = listed.tools.find((t) => t.name === declared.name);
      expect(served?.description).toBe(declared.description);
      expect(canonicalize(served?.inputSchema)).toBe(canonicalize(declared.inputSchema));
      // Phase 4: every advertised tool carries its skill ref(s) in the neutral _meta key.
      expect((served?._meta as Record<string, unknown> | undefined)?.[SKILL_REFS_META_KEY]).toEqual([
        FIXTURE_SKILL_REF,
      ]);
    }
  });
});

/** A minimal JCS-style stable stringify for the inputSchema comparison. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(',')}}`;
}
