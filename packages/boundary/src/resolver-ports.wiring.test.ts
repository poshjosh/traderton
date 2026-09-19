// AUTHORED (A4) — boundary-level test: an agent-subject no-bot invocation
// (submit_decision) constructs the actor context with the WIRED operator
// default owner mode (execution.defaultOwnerMode), NOT the old hardcoded
// 'paper' fallback. Proves the resolverPorts wiring end-to-end through the
// signed tools:invoke envelope → context factory → injection.ownerMode.
//
// The ports' db reads are faked at the Database surface (no Postgres); the
// signing/idempotency/dispatch layers are the real boundary code paths, same
// harness as app.test.ts.

import { describe, it, expect, beforeEach } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import type { TradingToolContext, ToolCategory } from '@traderton/domain';
import type { AgentTool, ToolResult } from '@traderton/domain';
import { ToolRegistry } from '@traderton/worker';
import { createBoundaryApp } from './app.js';
import type { BoundaryConfig } from './config.js';
import type {
  TradingToolContextFactory,
  BoundaryInvocationStore,
  ComputeRequestFingerprint,
} from './dispatcher.js';
import { resolveSubjectInjection } from './subject-resolver.js';
import { buildResolverPorts } from './resolver-ports.js';

const CONSUMER_ID = 'consumerA';
const KEY_ID = 'current';
const SECRET = 'test-signing-secret';
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const INVOKE_PATH = '/internal/v1/tools:invoke';
const OWNER_ID = 'owner-1';
const AGENT_ID = 'agent-1';

const CONFIG: BoundaryConfig = {
  clockSkewMs: 30_000,
  allowedConsumers: { [CONSUMER_ID]: { keyId: KEY_ID, secret: SECRET } },
};

/** A shadow-configured operator setup — the case the old wiring got wrong. */
const APP_CONFIG = {
  execution: { defaultOwnerMode: 'shadow' },
} as unknown as Parameters<typeof buildResolverPorts>[0]['appConfig'];

/** Fake db: the owner has exactly one venue account (the single-account path). */
function fakeDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          then: (resolve: (v: unknown) => void) =>
            resolve([{ id: 'va-1', venue: 'hyperliquid' }]),
        }),
      }),
    }),
  } as unknown as Parameters<typeof buildResolverPorts>[0]['db'];
}

const capturedModes: string[] = [];

beforeEach(() => {
  capturedModes.length = 0;
});

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  // Stand-in for submit_decision: same no-bot shape (no botId), side-effecting
  // (drives venue resolution + the injection), records the execution mode the
  // context was constructed with.
  const probeTool: AgentTool<TradingToolContext> = {
    name: 'submit_decision',
    description: 'test stand-in for submit_decision',
    parametersSchema: z.object({ decision: z.string() }),
    parameters: {},
    category: 'execute-trade' as ToolCategory,
    async execute(_params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
      capturedModes.push(ctx.executionMode);
      return { success: true, data: { executionMode: ctx.executionMode } };
    },
  };
  registry.register(probeTool);
  return registry;
}

const CONTEXT_FACTORY: TradingToolContextFactory = async (request) => {
  const resolverPorts = buildResolverPorts({
    db: fakeDb(),
    appConfig: APP_CONFIG,
    getBotById: async () => null,
  });
  const resolution = await resolveSubjectInjection(
    { ownerId: request.ownerId, actor: request.actor },
    false,
    request.payload,
    resolverPorts,
  );
  if (!resolution.ok) {
    throw new Error(`subject resolution failed: ${resolution.code}: ${resolution.message}`);
  }
  return {
    agentId: request.actor.id,
    sessionId: `boundary:${request.ownerId}`,
    ownerId: request.ownerId,
    executionMode: resolution.injection.ownerMode,
    authorizationMode: 'direct',
    redis: {} as TradingToolContext['redis'],
    publishToInbound: async () => {},
    botRepo: {} as TradingToolContext['botRepo'],
    db: {} as TradingToolContext['db'],
  } satisfies TradingToolContext;
};

function makeFakeStore() {
  const store: BoundaryInvocationStore = {
    async beginOrResolve() {
      return { kind: 'started', id: 'row-1' };
    },
    async complete() {},
    async findByRequestId() {
      return null;
    },
  };
  return store;
}

const FAKE_FINGERPRINT: ComputeRequestFingerprint = (input) =>
  `fp:${input.consumerId}:${input.ownerId}:${input.toolName}`;

function makeApp() {
  return createBoundaryApp({
    config: CONFIG,
    registry: buildRegistry(),
    contextFactory: CONTEXT_FACTORY,
    invocationStore: makeFakeStore(),
    computeRequestFingerprint: FAKE_FINGERPRINT,
    retentionMs: 168 * 60 * 60 * 1000,
    now: () => NOW,
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

function validEnvelope(): Envelope {
  return {
    contractVersion: '1.0',
    requestId: 'req-1',
    idempotencyKey: 'idem-1',
    correlationId: 'corr-1',
    issuedAt: '2026-01-01T00:00:00.000Z',
    deadlineAt: '2026-01-01T00:00:30.000Z',
    caller: { consumerId: CONSUMER_ID, keyId: KEY_ID },
    subject: { ownerId: OWNER_ID, actor: { type: 'agent', id: AGENT_ID } },
    toolName: 'submit_decision',
    payload: { decision: 'enter_long' },
  };
}

function signHeaders(rawBody: string): Record<string, string> {
  const timestamp = '2026-01-01T00:00:00.000Z';
  const bodyHash = createHash('sha256').update(Buffer.from(rawBody, 'utf8')).digest('hex');
  const canonical = `POST\n${INVOKE_PATH}\n${timestamp}\n${bodyHash}`;
  const sig = 'sha256=' + createHmac('sha256', SECRET).update(canonical).digest('hex');
  return {
    'content-type': 'application/json',
    'x-traderton-consumer-id': CONSUMER_ID,
    'x-traderton-key-id': KEY_ID,
    'x-traderton-timestamp': timestamp,
    'x-traderton-signature': sig,
    'x-request-deadline-at': '2026-01-01T00:00:30.000Z',
  };
}

describe('boundary agent-subject submit_decision uses the wired default owner mode (A4)', () => {
  it('constructs the context with executionMode = shadow (operator default), not paper', async () => {
    const app = makeApp();
    const rawBody = JSON.stringify(validEnvelope());
    const res = await app.inject({
      method: 'POST',
      url: INVOKE_PATH,
      headers: signHeaders(rawBody),
      payload: rawBody,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { outcome?: { kind?: string; payload?: { executionMode?: string } } };
    expect(body.outcome?.kind).toBe('success');
    expect(body.outcome?.payload?.executionMode).toBe('shadow');
    expect(capturedModes).toEqual(['shadow']);
    await app.close();
  });
});
