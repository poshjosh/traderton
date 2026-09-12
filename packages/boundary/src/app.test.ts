// AUTHORED (Phase 9b item F1) — the F1 acceptance tests (029 §5). 005 is a fresh
// contract with no copy oracle, so these are authored against the 005 text. They
// exercise the boundary's OWN auth/validation/dispatch end-to-end (via
// `app.inject`, no real network) — those are what's under test, so none is stubbed.

import { describe, it, expect, beforeEach } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import type { TradingToolContext } from '@traderton/domain';
import { ToolRegistry } from '@traderton/worker';
import type { AgentTool, ToolResult } from '@traderton/domain';
import { z } from 'zod';
import { createBoundaryApp } from './app.js';
import type { BoundaryConfig } from './config.js';
import type {
  TradingToolContextFactory,
  BoundaryInvocationStore,
  ComputeRequestFingerprint,
} from './dispatcher.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const CONSUMER_ID = 'consumerA';
const KEY_ID = 'current';
const SECRET = 'test-signing-secret';
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const INVOKE_PATH = '/internal/v1/tools:invoke';

const CONFIG: BoundaryConfig = {
  clockSkewMs: 30_000,
  allowedConsumers: { [CONSUMER_ID]: { keyId: KEY_ID, secret: SECRET } },
};

/** A deterministic read-only tool (no live data needed). */
const echoReadTool: AgentTool<TradingToolContext> = {
  name: 'echo_read',
  description: 'read-only echo (test fixture)',
  parametersSchema: z.object({ value: z.string() }),
  parameters: {},
  category: 'read-config',
  async execute(params: unknown): Promise<ToolResult> {
    const { value } = params as { value: string };
    return { success: true, data: { echoed: value } };
  },
};

/** A read-only tool that reports a retryable fault (maps to upstream.transient). */
const flakyReadTool: AgentTool<TradingToolContext> = {
  name: 'flaky_read',
  description: 'read-only, always retryable-fails (test fixture)',
  parametersSchema: z.object({}),
  parameters: {},
  category: 'read-database',
  async execute(): Promise<ToolResult> {
    return { success: false, error: 'temporary outage', errorCode: 'x.transient', retryable: true };
  },
};

/** A read-only tool that signals a rate-limit throttle (errorCode:'rate_limit',
 *  retryable) — must map to `rate_limit.exceeded`, NOT `upstream.transient`. */
const throttledReadTool: AgentTool<TradingToolContext> = {
  name: 'throttled_read',
  description: 'read-only, always rate-limited (test fixture)',
  parametersSchema: z.object({}),
  parameters: {},
  category: 'read-market-data',
  async execute(): Promise<ToolResult> {
    return { success: false, error: 'rate_limit', errorCode: 'rate_limit', retryable: true };
  },
};

/**
 * A side-effecting tool whose run-count is observable — F1 rejected it, F2b
 * dispatches it. `runs` lets tests assert the tool ran once (started), or NOT at
 * all (replay / in_progress / deadline re-check).
 */
const writeRuns = { count: 0 };
const writeTool: AgentTool<TradingToolContext> = {
  name: 'write_thing',
  description: 'side-effecting (test fixture)',
  parametersSchema: z.object({}),
  parameters: {},
  category: 'execute-trade',
  async execute(): Promise<ToolResult> {
    writeRuns.count += 1;
    return { success: true, data: { didSideEffect: true } };
  },
};

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(echoReadTool);
  registry.register(flakyReadTool);
  registry.register(throttledReadTool);
  registry.register(writeTool);
  return registry;
}

const CONTEXT_FACTORY: TradingToolContextFactory = (request) =>
  ({
    agentId: request.actor.id,
    sessionId: `s:${request.ownerId}`,
    executionMode: 'paper',
    authorizationMode: 'approval_required',
    redis: {} as TradingToolContext['redis'],
    publishToInbound: async () => {},
  }) satisfies TradingToolContext;

/**
 * A programmable fake idempotency store — NO Postgres. The `beginOrResolve`
 * result is scripted per test; `complete` + `findByRequestId` calls are recorded
 * so tests can assert the wrap's behaviour (complete-on-terminal, no re-run).
 */
type BeginResult = Awaited<ReturnType<BoundaryInvocationStore['beginOrResolve']>>;

function makeFakeStore(
  opts: {
    begin?: BeginResult;
    findRow?: Awaited<ReturnType<BoundaryInvocationStore['findByRequestId']>>;
    /** When true, `complete` rejects (a DB blip after the side effect ran). */
    completeRejects?: boolean;
  } = {},
) {
  const calls = {
    beginOrResolve: 0,
    complete: 0,
    findByRequestId: 0,
    completed: [] as Array<{ terminalResponse: Record<string, unknown> }>,
  };
  const store: BoundaryInvocationStore = {
    async beginOrResolve() {
      calls.beginOrResolve += 1;
      return opts.begin ?? { kind: 'started', id: 'row-1' };
    },
    async complete(params) {
      calls.complete += 1;
      calls.completed.push({ terminalResponse: params.terminalResponse });
      if (opts.completeRejects) {
        throw new Error('db blip completing invocation row');
      }
    },
    async findByRequestId() {
      calls.findByRequestId += 1;
      return opts.findRow ?? null;
    },
  };
  return { store, calls };
}

/** A trivial deterministic fingerprint (no db). */
const FAKE_FINGERPRINT: ComputeRequestFingerprint = (input) =>
  `fp:${input.consumerId}:${input.ownerId}:${input.toolName}`;

function makeApp(overrides: Partial<Parameters<typeof createBoundaryApp>[0]> = {}) {
  return createBoundaryApp({
    config: CONFIG,
    registry: buildRegistry(),
    contextFactory: CONTEXT_FACTORY,
    invocationStore: makeFakeStore().store,
    computeRequestFingerprint: FAKE_FINGERPRINT,
    retentionMs: 168 * 60 * 60 * 1000,
    now: () => NOW,
    ...overrides,
  });
}

interface Envelope {
  contractVersion: string;
  requestId: string;
  idempotencyKey: string;
  correlationId: string;
  issuedAt: string;
  deadlineAt: string;
  caller: { consumerId: string; keyId: string };
  subject: { ownerId: string; actor: { type: string; id: string } };
  toolName: string;
  payload: unknown;
}

function validEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    contractVersion: '1.0',
    requestId: 'req-1',
    idempotencyKey: 'idem-1',
    correlationId: 'corr-1',
    issuedAt: '2026-01-01T00:00:00.000Z',
    deadlineAt: '2026-01-01T00:00:30.000Z',
    caller: { consumerId: CONSUMER_ID, keyId: KEY_ID },
    subject: { ownerId: 'owner-1', actor: { type: 'agent', id: 'actor-1' } },
    toolName: 'echo_read',
    payload: { value: 'hi' },
    ...overrides,
  };
}

/** Produce signed headers for a raw JSON body. */
function signHeaders(
  rawBody: string,
  opts: {
    secret?: string;
    consumerId?: string;
    keyId?: string;
    timestamp?: string;
    signature?: string;
    deadlineAt?: string;
  } = {},
): Record<string, string> {
  const timestamp = opts.timestamp ?? '2026-01-01T00:00:00.000Z';
  const bodyHash = createHash('sha256').update(Buffer.from(rawBody, 'utf8')).digest('hex');
  const canonical = `POST\n${INVOKE_PATH}\n${timestamp}\n${bodyHash}`;
  const sig =
    opts.signature ??
    'sha256=' + createHmac('sha256', opts.secret ?? SECRET).update(canonical).digest('hex');
  return {
    'content-type': 'application/json',
    'x-traderton-consumer-id': opts.consumerId ?? CONSUMER_ID,
    'x-traderton-key-id': opts.keyId ?? KEY_ID,
    'x-traderton-timestamp': timestamp,
    'x-traderton-signature': sig,
    'x-request-deadline-at': opts.deadlineAt ?? '2026-01-01T00:00:30.000Z',
  };
}

async function invoke(
  app: ReturnType<typeof makeApp>,
  envelope: Envelope | string,
  headerOpts: Parameters<typeof signHeaders>[1] = {},
) {
  const rawBody = typeof envelope === 'string' ? envelope : JSON.stringify(envelope);
  const res = await app.inject({
    method: 'POST',
    url: INVOKE_PATH,
    headers: signHeaders(rawBody, headerOpts),
    payload: rawBody,
  });
  return res;
}

// ── Health ────────────────────────────────────────────────────────────────

describe('boundary health endpoints', () => {
  it('GET /health/live returns live', async () => {
    const app = makeApp();
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'live' });
    await app.close();
  });

  it('GET /health/ready returns ready', async () => {
    const app = makeApp();
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
    await app.close();
  });
});

// ── Happy path ──────────────────────────────────────────────────────────────

describe('valid signed read-only invocation', () => {
  it('dispatches the tool and returns a success envelope', async () => {
    const app = makeApp();
    const res = await invoke(app, validEnvelope());
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      contractVersion: '1.0',
      requestId: 'req-1',
      correlationId: 'corr-1',
      outcome: { kind: 'success', payload: { echoed: 'hi' } },
    });
    await app.close();
  });

  it('maps a retryable tool failure to upstream.transient', async () => {
    const app = makeApp();
    const res = await invoke(app, validEnvelope({ toolName: 'flaky_read', payload: {} }));
    const body = res.json();
    expect(body.outcome.kind).toBe('failure');
    expect(body.outcome.code).toBe('upstream.transient');
    expect(body.outcome.retryable).toBe(true);
    await app.close();
  });

  it('maps a rate-limit throttle to rate_limit.exceeded (NOT upstream.transient)', async () => {
    // Parity: the consumer must distinguish a throttle from a generic transient
    // fault to split its rate-limit-vs-failure telemetry (L3 Q2 regime re-point).
    const app = makeApp();
    const res = await invoke(app, validEnvelope({ toolName: 'throttled_read', payload: {} }));
    const body = res.json();
    expect(body.outcome.kind).toBe('failure');
    expect(body.outcome.code).toBe('rate_limit.exceeded');
    expect(body.outcome.retryable).toBe(true);
    await app.close();
  });
});

// ── Auth failures (pre-dispatch) ─────────────────────────────────────────────

describe('signature failures fail before dispatch', () => {
  it('rejects a wrong signature', async () => {
    const app = makeApp();
    const res = await invoke(app, validEnvelope(), { signature: 'sha256=deadbeef' });
    const body = res.json();
    expect(body.outcome.code).toBe('authentication.invalid_caller');
    expect(body.outcome.retryable).toBe(false);
    await app.close();
  });

  it('rejects a wrong signing secret', async () => {
    const app = makeApp();
    const res = await invoke(app, validEnvelope(), { secret: 'wrong-secret' });
    expect(res.json().outcome.code).toBe('authentication.invalid_caller');
    await app.close();
  });

  it('rejects an unknown consumer', async () => {
    const app = makeApp();
    const res = await invoke(app, validEnvelope(), { consumerId: 'nope' });
    expect(res.json().outcome.code).toBe('authentication.invalid_caller');
    await app.close();
  });

  it('rejects an unknown key id', async () => {
    const app = makeApp();
    const res = await invoke(app, validEnvelope(), { keyId: 'stale' });
    expect(res.json().outcome.code).toBe('authentication.invalid_caller');
    await app.close();
  });

  it('rejects an out-of-skew (expired) timestamp', async () => {
    const app = makeApp();
    // 5 minutes in the past — well outside the 30s window.
    const res = await invoke(app, validEnvelope(), {
      timestamp: '2025-12-31T23:55:00.000Z',
    });
    expect(res.json().outcome.code).toBe('authentication.invalid_caller');
    await app.close();
  });

  it('rejects a header/body caller mismatch', async () => {
    // Body says consumerB, headers are signed as consumerA (valid signature) →
    // the header↔body match check must reject it as invalid_caller.
    const app = makeApp();
    const envelope = validEnvelope({
      caller: { consumerId: 'consumerB', keyId: KEY_ID },
    });
    const res = await invoke(app, envelope);
    expect(res.json().outcome.code).toBe('authentication.invalid_caller');
    await app.close();
  });

  it('rejects a deadline header/body mismatch', async () => {
    // The X-Request-Deadline-At header must equal body.deadlineAt exactly (005).
    // A valid signature but a differing deadline header must be rejected as
    // invalid_caller before dispatch. The deadline header is not in the signed
    // canonical string, so the signature stays valid — the match check is the gate.
    const app = makeApp();
    const res = await invoke(app, validEnvelope(), {
      deadlineAt: '2026-01-01T00:05:00.000Z',
    });
    expect(res.json().outcome.code).toBe('authentication.invalid_caller');
    await app.close();
  });

  it('replaying a captured request outside the skew window fails', async () => {
    // A signature valid at NOW, but the app's clock has advanced past the window.
    const app = createBoundaryApp({
      config: CONFIG,
      registry: buildRegistry(),
      contextFactory: CONTEXT_FACTORY,
      now: () => NOW + 60_000,
    });
    const res = await invoke(app, validEnvelope());
    expect(res.json().outcome.code).toBe('authentication.invalid_caller');
    await app.close();
  });
});

// ── Envelope / version validation (pre-dispatch) ─────────────────────────────

describe('envelope and version validation', () => {
  it('rejects an unknown outer key', async () => {
    const app = makeApp();
    const envelope = { ...validEnvelope(), unexpected: true } as unknown as Envelope;
    const res = await invoke(app, envelope);
    expect(res.json().outcome.code).toBe('validation.invalid_payload');
    await app.close();
  });

  it('rejects malformed (non-JSON) body', async () => {
    const app = makeApp();
    const res = await invoke(app, '{not json');
    expect(res.json().outcome.code).toBe('validation.invalid_payload');
    await app.close();
  });

  it('rejects an unsupported contract version', async () => {
    const app = makeApp();
    const envelope = validEnvelope({ contractVersion: '2.0' });
    const res = await invoke(app, envelope);
    expect(res.json().outcome.code).toBe('contract.unsupported_version');
    await app.close();
  });
});

// ── Tool / payload validation ────────────────────────────────────────────────

describe('tool and payload validation', () => {
  it('rejects an unknown tool with validation.invalid_payload', async () => {
    const app = makeApp();
    const res = await invoke(app, validEnvelope({ toolName: 'does_not_exist', payload: {} }));
    expect(res.json().outcome.code).toBe('validation.invalid_payload');
    await app.close();
  });

  it('rejects a bad payload with validation.invalid_payload', async () => {
    const app = makeApp();
    const res = await invoke(app, validEnvelope({ payload: { value: 42 } }));
    expect(res.json().outcome.code).toBe('validation.invalid_payload');
    await app.close();
  });

  it('rejects an empty subject.ownerId with authorization.denied', async () => {
    const app = makeApp();
    const envelope = validEnvelope({
      subject: { ownerId: '  ', actor: { type: 'agent', id: 'actor-1' } },
    });
    const res = await invoke(app, envelope);
    expect(res.json().outcome.code).toBe('authorization.denied');
    await app.close();
  });
});

// ── F2b: the read-only gate is OPEN — side-effecting tools now dispatch ──────

describe('F2b side-effecting dispatch (F1 gate opened)', () => {
  it('dispatches the write tool that F1 rejected (through the idempotency wrap)', async () => {
    const { store, calls } = makeFakeStore({ begin: { kind: 'started', id: 'row-1' } });
    const app = makeApp({ invocationStore: store });
    const res = await invoke(app, validEnvelope({ toolName: 'write_thing', payload: {} }));
    const body = res.json();
    expect(body.outcome.kind).toBe('success');
    expect(body.outcome.payload).toEqual({ didSideEffect: true });
    // It went through the store (persist-before-side-effect) and completed once.
    expect(calls.beginOrResolve).toBe(1);
    expect(calls.complete).toBe(1);
    await app.close();
  });
});

// ── F2b: deadline enforcement (D3 pragmatic — pre-check + one re-check) ──────

beforeEach(() => {
  writeRuns.count = 0;
});

describe('F2b deadline enforcement', () => {
  it('pre-check: an already-expired deadline → deadline.expired, tool NOT run, store NOT touched', async () => {
    const { store, calls } = makeFakeStore();
    // App clock is well past the envelope's deadline (00:00:30Z).
    const app = makeApp({ invocationStore: store, now: () => NOW + 120_000 });
    const res = await invoke(
      app,
      validEnvelope({ toolName: 'write_thing', payload: {} }),
      // Keep the signed timestamp current so auth passes; only the deadline is stale.
      { timestamp: '2026-01-01T00:02:00.000Z', deadlineAt: '2026-01-01T00:00:30.000Z' },
    );
    const body = res.json();
    expect(body.outcome.code).toBe('deadline.expired');
    expect(writeRuns.count).toBe(0);
    expect(calls.beginOrResolve).toBe(0);
    await app.close();
  });

  it('re-check: deadline passes between pre-check and execute → deadline.expired before the side effect', async () => {
    // The clock advances during the request: readable at pre-check (not yet
    // expired), expired by the re-check. A stateful clock models that.
    const deadlineMs = Date.parse('2026-01-01T00:00:30.000Z');
    let calls = 0;
    const advancingNow = () => {
      calls += 1;
      // 1st read (auth) + 2nd (pre-check): before the deadline; later reads: after.
      return calls <= 2 ? deadlineMs - 5_000 : deadlineMs + 5_000;
    };
    const { store, calls: storeCalls } = makeFakeStore();
    const app = makeApp({ invocationStore: store, now: advancingNow });
    const res = await invoke(app, validEnvelope({ toolName: 'write_thing', payload: {} }));
    const body = res.json();
    expect(body.outcome.code).toBe('deadline.expired');
    expect(writeRuns.count).toBe(0);
    // Re-check fires AFTER the pre-check passes but BEFORE the store/side effect.
    expect(storeCalls.beginOrResolve).toBe(0);
    await app.close();
  });
});

// ── F2b: idempotency wrap (side-effecting tools) ─────────────────────────────

describe('F2b idempotency wrap', () => {
  it('started → the tool runs once and the mapped result is completed to the store', async () => {
    const { store, calls } = makeFakeStore({ begin: { kind: 'started', id: 'row-1' } });
    const app = makeApp({ invocationStore: store });
    const res = await invoke(app, validEnvelope({ toolName: 'write_thing', payload: {} }));
    const body = res.json();
    expect(body.outcome.kind).toBe('success');
    expect(writeRuns.count).toBe(1);
    expect(calls.complete).toBe(1);
    // The completed terminal response IS the mapped TradertonToolResultV1.
    expect(calls.completed[0]?.terminalResponse).toMatchObject({
      contractVersion: '1.0',
      requestId: 'req-1',
      outcome: { kind: 'success', payload: { didSideEffect: true } },
    });
    await app.close();
  });

  it('started → a complete() failure still returns the mapped terminal result (no 500, tool ran once)', async () => {
    // A DB blip AFTER the side effect ran: `complete` rejects. The mapped
    // terminal result is authoritative and must reach the caller as a normal
    // envelope, NOT as a thrown/unenveloped 500; and the tool must run once.
    const { store, calls } = makeFakeStore({
      begin: { kind: 'started', id: 'row-1' },
      completeRejects: true,
    });
    const app = makeApp({ invocationStore: store });
    const res = await invoke(app, validEnvelope({ toolName: 'write_thing', payload: {} }));
    const body = res.json();
    // The tool's success envelope is returned — not a raw 500.
    expect(body.outcome.kind).toBe('success');
    expect(body.outcome.payload).toEqual({ didSideEffect: true });
    // The side effect ran exactly once and complete() was attempted once.
    expect(writeRuns.count).toBe(1);
    expect(calls.complete).toBe(1);
    await app.close();
  });

  it('replay → the stored terminal result is returned and the tool is NOT re-run', async () => {
    const stored = {
      contractVersion: '1.0',
      requestId: 'req-1',
      correlationId: 'corr-1',
      outcome: { kind: 'success', payload: { fromReplay: true } },
    };
    const { store, calls } = makeFakeStore({ begin: { kind: 'replay', terminalResponse: stored } });
    const app = makeApp({ invocationStore: store });
    const res = await invoke(app, validEnvelope({ toolName: 'write_thing', payload: {} }));
    expect(res.json()).toEqual(stored);
    expect(writeRuns.count).toBe(0);
    expect(calls.complete).toBe(0);
    await app.close();
  });

  it('in_progress → the in-progress status shape, tool NOT run', async () => {
    const { store, calls } = makeFakeStore({ begin: { kind: 'in_progress' } });
    const app = makeApp({ invocationStore: store });
    const res = await invoke(app, validEnvelope({ toolName: 'write_thing', payload: {} }));
    expect(res.json()).toEqual({
      contractVersion: '1.0',
      requestId: 'req-1',
      correlationId: 'corr-1',
      state: 'in_progress',
    });
    expect(writeRuns.count).toBe(0);
    expect(calls.complete).toBe(0);
    await app.close();
  });

  it('conflict → validation.invalid_payload', async () => {
    const { store } = makeFakeStore({ begin: { kind: 'conflict' } });
    const app = makeApp({ invocationStore: store });
    const res = await invoke(app, validEnvelope({ toolName: 'write_thing', payload: {} }));
    const body = res.json();
    expect(body.outcome.code).toBe('validation.invalid_payload');
    expect(writeRuns.count).toBe(0);
    await app.close();
  });

  it('read-only tools BYPASS the store entirely', async () => {
    const { store, calls } = makeFakeStore();
    const app = makeApp({ invocationStore: store });
    const res = await invoke(app, validEnvelope()); // echo_read, category read-config
    expect(res.json().outcome.kind).toBe('success');
    expect(calls.beginOrResolve).toBe(0);
    expect(calls.complete).toBe(0);
    await app.close();
  });
});

// ── F2b: the status endpoint (never executes a tool) ─────────────────────────

const STATUS_BASE = '/internal/v1/invocations/';

function signStatusHeaders(
  requestId: string,
  opts: { secret?: string; consumerId?: string; keyId?: string } = {},
): Record<string, string> {
  const timestamp = '2026-01-01T00:00:00.000Z';
  const path = `${STATUS_BASE}${requestId}`;
  // GET has no body → hash empty bytes.
  const bodyHash = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
  const canonical = `GET\n${path}\n${timestamp}\n${bodyHash}`;
  const sig = 'sha256=' + createHmac('sha256', opts.secret ?? SECRET).update(canonical).digest('hex');
  return {
    'content-type': 'application/json',
    'x-traderton-consumer-id': opts.consumerId ?? CONSUMER_ID,
    'x-traderton-key-id': opts.keyId ?? KEY_ID,
    'x-traderton-timestamp': timestamp,
    'x-traderton-signature': sig,
    'x-request-deadline-at': '2026-01-01T00:00:30.000Z',
  };
}

async function getStatus(app: ReturnType<typeof makeApp>, requestId: string) {
  return app.inject({
    method: 'GET',
    url: `${STATUS_BASE}${requestId}`,
    headers: signStatusHeaders(requestId),
  });
}

describe('F2b status endpoint', () => {
  it('in_progress row → in-progress status shape, no tool run', async () => {
    const { store } = makeFakeStore({
      findRow: { requestId: 'req-9', correlationId: 'corr-9', state: 'in_progress', terminalResponse: null },
    });
    const app = makeApp({ invocationStore: store });
    const res = await getStatus(app, 'req-9');
    expect(res.json()).toEqual({
      contractVersion: '1.0',
      requestId: 'req-9',
      correlationId: 'corr-9',
      state: 'in_progress',
    });
    expect(writeRuns.count).toBe(0);
    await app.close();
  });

  it('terminal row → terminal status wrapping the stored result', async () => {
    const stored = {
      contractVersion: '1.0',
      requestId: 'req-9',
      correlationId: 'corr-9',
      outcome: { kind: 'success', payload: { done: true } },
    };
    const { store } = makeFakeStore({
      findRow: { requestId: 'req-9', correlationId: 'corr-9', state: 'terminal', terminalResponse: stored },
    });
    const app = makeApp({ invocationStore: store });
    const res = await getStatus(app, 'req-9');
    expect(res.json()).toEqual({
      contractVersion: '1.0',
      requestId: 'req-9',
      correlationId: 'corr-9',
      state: 'terminal',
      result: stored,
    });
    await app.close();
  });

  it('no row → not_found.resource failure', async () => {
    const { store } = makeFakeStore({ findRow: null });
    const app = makeApp({ invocationStore: store });
    const res = await getStatus(app, 'nope');
    expect(res.json().outcome.code).toBe('not_found.resource');
    await app.close();
  });

  it('rejects an unsigned/wrong-secret status request', async () => {
    const { store } = makeFakeStore({
      findRow: { requestId: 'req-9', correlationId: 'corr-9', state: 'in_progress', terminalResponse: null },
    });
    const app = makeApp({ invocationStore: store });
    const res = await app.inject({
      method: 'GET',
      url: `${STATUS_BASE}req-9`,
      headers: signStatusHeaders('req-9', { secret: 'wrong-secret' }),
    });
    expect(res.json().outcome.code).toBe('authentication.invalid_caller');
    await app.close();
  });
});

// ── F2b: authz Option B (allowedActorTypes) ──────────────────────────────────

describe('F2b authz Option B (allowedActorTypes)', () => {
  it('rejects an actor.type not in the consumer allow-set', async () => {
    const config: BoundaryConfig = {
      clockSkewMs: 30_000,
      idempotencyRetentionHours: 168,
      allowedConsumers: {
        [CONSUMER_ID]: { keyId: KEY_ID, secret: SECRET, allowedActorTypes: ['agent'] },
      },
    };
    const app = makeApp({ config });
    const envelope = validEnvelope({
      subject: { ownerId: 'owner-1', actor: { type: 'bot', id: 'actor-1' } },
    });
    const res = await invoke(app, envelope);
    expect(res.json().outcome.code).toBe('authorization.denied');
    await app.close();
  });

  it('allows an actor.type in the allow-set', async () => {
    const config: BoundaryConfig = {
      clockSkewMs: 30_000,
      idempotencyRetentionHours: 168,
      allowedConsumers: {
        [CONSUMER_ID]: { keyId: KEY_ID, secret: SECRET, allowedActorTypes: ['agent', 'bot'] },
      },
    };
    const app = makeApp({ config });
    const envelope = validEnvelope({
      subject: { ownerId: 'owner-1', actor: { type: 'bot', id: 'actor-1' } },
    });
    const res = await invoke(app, envelope);
    expect(res.json().outcome.kind).toBe('success');
    await app.close();
  });

  it('unset allowedActorTypes allows all four types (back-compat)', async () => {
    const app = makeApp(); // CONFIG has no allowedActorTypes
    for (const type of ['agent', 'bot', 'user', 'system'] as const) {
      const envelope = validEnvelope({
        subject: { ownerId: 'owner-1', actor: { type, id: 'actor-1' } },
      });
      const res = await invoke(app, envelope);
      expect(res.json().outcome.kind).toBe('success');
    }
    await app.close();
  });
});
