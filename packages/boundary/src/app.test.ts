// AUTHORED (Phase 9b item F1) — the F1 acceptance tests (029 §5). 005 is a fresh
// contract with no copy oracle, so these are authored against the 005 text. They
// exercise the boundary's OWN auth/validation/dispatch end-to-end (via
// `app.inject`, no real network) — those are what's under test, so none is stubbed.

import { describe, it, expect } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import type { TradingToolContext } from '@traderton/domain';
import { ToolRegistry } from '@traderton/worker';
import type { AgentTool, ToolResult } from '@traderton/domain';
import { z } from 'zod';
import { createBoundaryApp } from './app.js';
import type { BoundaryConfig } from './config.js';
import type { DispatchSubject, TradingToolContextFactory } from './dispatcher.js';

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

/** A side-effecting tool — must be rejected by the F1 read-only gate. */
const writeTool: AgentTool<TradingToolContext> = {
  name: 'write_thing',
  description: 'side-effecting (test fixture)',
  parametersSchema: z.object({}),
  parameters: {},
  category: 'execute-trade',
  async execute(): Promise<ToolResult> {
    return { success: true, data: { didSideEffect: true } };
  },
};

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(echoReadTool);
  registry.register(flakyReadTool);
  registry.register(writeTool);
  return registry;
}

const CONTEXT_FACTORY: TradingToolContextFactory = (subject: DispatchSubject) =>
  ({
    agentId: subject.actor.id,
    sessionId: `s:${subject.ownerId}`,
    executionMode: 'paper',
    authorizationMode: 'approval_required',
    redis: {} as TradingToolContext['redis'],
    publishToInbound: async () => {},
  }) satisfies TradingToolContext;

function makeApp(overrides: Partial<Parameters<typeof createBoundaryApp>[0]> = {}) {
  return createBoundaryApp({
    config: CONFIG,
    registry: buildRegistry(),
    contextFactory: CONTEXT_FACTORY,
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

// ── F1 read-only scope gate ──────────────────────────────────────────────────

describe('F1 read-only scope gate', () => {
  it('rejects a side-effecting tool without dispatching it', async () => {
    const app = makeApp();
    const res = await invoke(app, validEnvelope({ toolName: 'write_thing', payload: {} }));
    const body = res.json();
    expect(body.outcome.kind).toBe('failure');
    expect(body.outcome.code).toBe('precondition.not_ready');
    expect(body.outcome.message).toContain('F2');
    // The side effect must NOT have happened.
    expect(body.outcome.payload).toBeUndefined();
    await app.close();
  });
});
