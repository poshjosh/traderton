// Phase 3 T2.2 — the MCP route over the existing dispatcher, driven through
// `app.inject` with frames signed by the committed dev signer. The route authors
// no execution semantics: these assert the parse/authenticate/encode edges and
// that the SAME dispatcher the REST route uses answers. Fixtures are LOCAL copies
// (never imported from app.test.ts), per the plan.
import { describe, it, expect } from 'vitest';
import type { TradingToolContext, ToolResult, AgentTool } from '@traderton/domain';
import { ToolRegistry } from '@traderton/worker';
import { z } from 'zod';
import { createBoundaryApp, type BoundaryAppDeps } from '../app.js';
import type { BoundaryConfig } from '../config.js';
import type {
  TradingToolContextFactory,
  BoundaryInvocationStore,
  ComputeRequestFingerprint,
} from '../dispatcher.js';
import { signRequest, type SigningIdentity } from '../dev/sign.js';
import { MCP_PATH } from './constants.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const IDENTITY: SigningIdentity = {
  consumerId: 'consumerA',
  keyId: 'current',
  secret: 'test-signing-secret',
};
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const CONFIG: BoundaryConfig = {
  clockSkewMs: 30_000,
  idempotencyRetentionHours: 168,
  allowedConsumers: { [IDENTITY.consumerId]: { keyId: IDENTITY.keyId, secret: IDENTITY.secret } },
};

const toolRuns = { echo: 0, write: 0 };

const echoReadTool: AgentTool<TradingToolContext> = {
  name: 'echo_read',
  description: 'read-only echo (route-test fixture)',
  parametersSchema: z.object({ value: z.string() }),
  parameters: {},
  category: 'read-config',
  async execute(params: unknown): Promise<ToolResult> {
    toolRuns.echo += 1;
    const { value } = z.object({ value: z.string() }).parse(params);
    return { success: true, data: { echoed: value } };
  },
};

const writeTool: AgentTool<TradingToolContext> = {
  name: 'write_thing',
  description: 'side-effecting (route-test fixture)',
  parametersSchema: z.object({}),
  parameters: {},
  category: 'execute-trade',
  async execute(): Promise<ToolResult> {
    toolRuns.write += 1;
    return { success: true, data: { didSideEffect: true } };
  },
};

const CONTEXT_FACTORY: TradingToolContextFactory = (request) =>
  ({
    agentId: request.actor.id,
    sessionId: `s:${request.ownerId}`,
    executionMode: 'paper',
    authorizationMode: 'direct',
    redis: {} as TradingToolContext['redis'],
    publishToInbound: async () => {},
  }) satisfies TradingToolContext;

type BeginResult = Awaited<ReturnType<BoundaryInvocationStore['beginOrResolve']>>;

function makeFakeStore(opts: { begin?: BeginResult } = {}) {
  const calls = { beginOrResolve: 0, complete: 0, completed: [] as Record<string, unknown>[] };
  const store: BoundaryInvocationStore = {
    async beginOrResolve() {
      calls.beginOrResolve += 1;
      return opts.begin ?? { kind: 'started', id: 'row-1' };
    },
    async complete(params) {
      calls.complete += 1;
      calls.completed.push(params.terminalResponse);
    },
    async findByRequestId() {
      return null;
    },
  };
  return { store, calls };
}

const FAKE_FINGERPRINT: ComputeRequestFingerprint = (input) =>
  `fp:${input.consumerId}:${input.ownerId}:${input.toolName}`;

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(echoReadTool);
  registry.register(writeTool);
  return registry;
}

function makeApp(overrides: Partial<BoundaryAppDeps> = {}): ReturnType<typeof createBoundaryApp> {
  return createBoundaryApp({
    config: CONFIG,
    registry: buildRegistry(),
    contextFactory: CONTEXT_FACTORY,
    invocationStore: makeFakeStore().store,
    computeRequestFingerprint: FAKE_FINGERPRINT,
    retentionMs: 168 * 60 * 60 * 1000,
    now: () => NOW,
    mcp: { tools: [] },
    ...overrides,
  });
}

const DEADLINE = '2026-01-01T00:00:30.000Z';

function envelopeMeta(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: '1.0',
    requestId: 'req-1',
    idempotencyKey: 'idem-1',
    correlationId: 'corr-1',
    issuedAt: '2026-01-01T00:00:00.000Z',
    deadlineAt: DEADLINE,
    caller: { consumerId: IDENTITY.consumerId, keyId: IDENTITY.keyId },
    subject: { ownerId: 'owner-1', actor: { type: 'agent', id: 'actor-1' } },
    ...overrides,
  };
}

/** A JSON-RPC frame body as a raw string. */
function frame(method: string, params: unknown, id: number | string | null = 1): string {
  const base: Record<string, unknown> = { jsonrpc: '2.0', method, params };
  if (id !== null) base['id'] = id;
  return JSON.stringify(base);
}

function toolsCallFrame(
  args: { name: string; arguments: unknown; meta?: Record<string, unknown> },
  id: number | string = 1,
): string {
  return frame('tools/call', { name: args.name, arguments: args.arguments, _meta: args.meta ?? envelopeMeta() }, id);
}

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

/** Inject a POST to the MCP path, signing over the exact body bytes (deadline overridable). */
async function post(
  app: ReturnType<typeof makeApp>,
  rawBody: string,
  opts: { deadlineAt?: string; tamperSignature?: boolean; timestamp?: string } = {},
) {
  const signed = signRequest(IDENTITY, {
    method: 'POST',
    path: MCP_PATH,
    rawBody: Buffer.from(rawBody, 'utf8'),
    deadlineAt: opts.deadlineAt ?? DEADLINE,
    // The app clock is pinned to NOW; sign at that instant so the HMAC timestamp
    // stays inside the clock-skew window.
    timestamp: opts.timestamp ?? '2026-01-01T00:00:00.000Z',
  });
  if (opts.tamperSignature) signed['x-traderton-signature'] = 'sha256=deadbeef';
  return app.inject({
    method: 'POST',
    url: MCP_PATH,
    headers: { ...signed, ...MCP_HEADERS },
    payload: rawBody,
  });
}

/** The JSON-RPC result/error of a successful HTTP frame. */
function rpc(res: Awaited<ReturnType<typeof post>>): Record<string, unknown> {
  return JSON.parse(res.body) as Record<string, unknown>;
}

describe('MCP route — mounting', () => {
  it('does not mount the MCP route unless an MCP surface is configured', async () => {
    const app = createBoundaryApp({
      config: CONFIG,
      registry: buildRegistry(),
      contextFactory: CONTEXT_FACTORY,
      invocationStore: makeFakeStore().store,
      computeRequestFingerprint: FAKE_FINGERPRINT,
      retentionMs: 168 * 60 * 60 * 1000,
      now: () => NOW,
      // no `mcp`
    });
    const res = await app.inject({ method: 'POST', url: MCP_PATH, headers: MCP_HEADERS, payload: '{}' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('MCP route — authentication', () => {
  it('authenticates every POST frame with the shared canonical string over the raw body', async () => {
    const app = makeApp();
    const res = await post(app, frame('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c', version: '0' } }));
    expect(res.statusCode).toBe(200);
    expect(rpc(res)).toHaveProperty('result.protocolVersion');
    await app.close();
  });

  it('rejects an unsigned initialize with a JSON-RPC error whose data is the authentication.invalid_caller failure', async () => {
    const app = makeApp();
    const res = await post(
      app,
      frame('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c', version: '0' } }),
      { tamperSignature: true },
    );
    const body = rpc(res);
    expect(body['id']).toBe(1);
    const error = body['error'] as { code: number; data: { outcome: { code: string } } };
    expect(error.code).toBe(-32000);
    expect(error.data.outcome.code).toBe('authentication.invalid_caller');
    await app.close();
  });

  it('rejects an unsigned notification with 401 and dispatches nothing', async () => {
    toolRuns.echo = 0;
    const app = makeApp();
    const res = await post(app, frame('notifications/initialized', {}, null), { tamperSignature: true });
    expect(res.statusCode).toBe(401);
    const error = rpc(res)['error'] as { data: { outcome: { code: string } } };
    expect(rpc(res)['id']).toBeNull();
    expect(error.data.outcome.code).toBe('authentication.invalid_caller');
    expect(toolRuns.echo).toBe(0);
    await app.close();
  });

  it('returns authentication.invalid_caller as an isError tool result when a tools/call signature does not verify', async () => {
    toolRuns.echo = 0;
    const app = makeApp();
    const res = await post(app, toolsCallFrame({ name: 'echo_read', arguments: { value: 'hi' } }), {
      tamperSignature: true,
    });
    expect(res.statusCode).toBe(200);
    const result = (rpc(res)['result']) as { isError?: boolean; structuredContent: { outcome: { code: string } } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.outcome.code).toBe('authentication.invalid_caller');
    expect(toolRuns.echo).toBe(0);
    await app.close();
  });

  it('rejects a tools/call whose _meta caller or deadline disagrees with the signed headers', async () => {
    toolRuns.echo = 0;
    const app = makeApp();
    // The signed deadline header differs from _meta.deadlineAt → body/header mismatch.
    const res = await post(app, toolsCallFrame({ name: 'echo_read', arguments: { value: 'hi' } }), {
      deadlineAt: '2026-01-01T00:05:00.000Z',
    });
    const result = (rpc(res)['result']) as { isError?: boolean; structuredContent: { outcome: { code: string } } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.outcome.code).toBe('authentication.invalid_caller');
    expect(toolRuns.echo).toBe(0);
    await app.close();
  });
});

describe('MCP route — dispatch over the shared core', () => {
  it('dispatches tools/call through the existing dispatcher with the envelope rebuilt from name, arguments and _meta', async () => {
    toolRuns.echo = 0;
    const app = makeApp();
    const res = await post(app, toolsCallFrame({ name: 'echo_read', arguments: { value: 'hi' } }));
    const result = (rpc(res)['result']) as {
      isError?: boolean;
      structuredContent: { requestId: string; correlationId: string; outcome: { kind: string; payload: unknown } };
    };
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.requestId).toBe('req-1');
    expect(result.structuredContent.correlationId).toBe('corr-1');
    expect(result.structuredContent.outcome).toEqual({ kind: 'success', payload: { echoed: 'hi' } });
    expect(toolRuns.echo).toBe(1);
    await app.close();
  });

  it('ignores _meta keys outside the envelope field set', async () => {
    toolRuns.echo = 0;
    const app = makeApp();
    const meta = envelopeMeta({ progressToken: 'tok', somethingElse: { a: 1 } });
    const res = await post(app, toolsCallFrame({ name: 'echo_read', arguments: { value: 'hi' }, meta }), {
      deadlineAt: DEADLINE,
    });
    const result = (rpc(res)['result']) as { isError?: boolean; structuredContent: { outcome: { kind: string } } };
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.outcome.kind).toBe('success');
    await app.close();
  });

  it('returns the dispatcher failure envelope in structuredContent with isError true and the code intact', async () => {
    const app = makeApp();
    // Unknown tool → dispatcher returns validation.invalid_payload (closed union).
    const res = await post(app, toolsCallFrame({ name: 'does_not_exist', arguments: {} }));
    const result = (rpc(res)['result']) as { isError?: boolean; structuredContent: { outcome: { kind: string; code: string; retryable: boolean } } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.outcome.kind).toBe('failure');
    expect(result.structuredContent.outcome.code).toBe('validation.invalid_payload');
    expect(result.structuredContent.outcome.retryable).toBe(false);
    await app.close();
  });

  it('returns the in_progress status shape without isError for a same-key re-issue while the first is running', async () => {
    const { store } = makeFakeStore({ begin: { kind: 'in_progress' } });
    const app = makeApp({ invocationStore: store });
    const res = await post(app, toolsCallFrame({ name: 'write_thing', arguments: {} }));
    const result = (rpc(res)['result']) as { isError?: boolean; structuredContent: { state: string } };
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.state).toBe('in_progress');
    await app.close();
  });

  it('returns the stored terminal result for a same-key re-issue after completion', async () => {
    const stored = {
      contractVersion: '1.0',
      requestId: 'req-1',
      correlationId: 'corr-1',
      outcome: { kind: 'success', payload: { fromReplay: true } },
    };
    const { store } = makeFakeStore({ begin: { kind: 'replay', terminalResponse: stored } });
    const app = makeApp({ invocationStore: store });
    const res = await post(app, toolsCallFrame({ name: 'write_thing', arguments: {} }));
    const result = (rpc(res)['result']) as { isError?: boolean; structuredContent: unknown };
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(stored);
    await app.close();
  });

  it('returns validation.invalid_payload for a reused key with a changed payload', async () => {
    const { store } = makeFakeStore({ begin: { kind: 'conflict' } });
    const app = makeApp({ invocationStore: store });
    const res = await post(app, toolsCallFrame({ name: 'write_thing', arguments: {} }));
    const result = (rpc(res)['result']) as { isError?: boolean; structuredContent: { outcome: { code: string } } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.outcome.code).toBe('validation.invalid_payload');
    await app.close();
  });

  it('surfaces a dispatcher exception as a sanitized JSON-RPC internal error, not a tool result', async () => {
    const throwingStore: BoundaryInvocationStore = {
      async beginOrResolve() {
        throw new Error('db exploded with secret details');
      },
      async complete() {},
      async findByRequestId() {
        return null;
      },
    };
    const app = makeApp({ invocationStore: throwingStore });
    const res = await post(app, toolsCallFrame({ name: 'write_thing', arguments: {} }));
    const body = rpc(res);
    expect(body['result']).toBeUndefined();
    const error = body['error'] as { code: number; message: string };
    expect(error.code).toBe(-32603);
    expect(error.message).toBe('boundary internal error');
    expect(JSON.stringify(body)).not.toContain('secret details');
    await app.close();
  });
});

describe('MCP route — method and batch handling', () => {
  it('answers GET and DELETE with 405 and no side effect', async () => {
    toolRuns.echo = 0;
    const app = makeApp();
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await app.inject({ method, url: MCP_PATH, headers: MCP_HEADERS });
      expect(res.statusCode).toBe(405);
      expect(res.headers['allow']).toBe('POST');
    }
    expect(toolRuns.echo).toBe(0);
    await app.close();
  });

  it('rejects JSON-RPC batches as invalid requests', async () => {
    const app = makeApp();
    const batch = JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }]);
    const res = await post(app, batch);
    expect(res.statusCode).toBe(400);
    const error = rpc(res)['error'] as { code: number; message: string };
    expect(error.code).toBe(-32600);
    expect(error.message).toContain('batch');
    await app.close();
  });

  it('answers an authenticated notification with 202', async () => {
    const app = makeApp();
    // A notification must follow a session init in the SDK; here we assert the
    // route authenticates and forwards it — the stateless transport answers 202.
    const res = await post(app, frame('notifications/initialized', {}, null));
    expect([202, 200]).toContain(res.statusCode);
    await app.close();
  });
});
