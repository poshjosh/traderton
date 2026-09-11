// AUTHORED (L3-P1) — boundary-level acceptance tests for the
// `provision_venue_account` side-effecting tool. Exercises a signed
// `tools:invoke` end-to-end (via `app.inject`, no real network): the request is
// HMAC-authenticated, dispatched through the idempotency wrap (the tool is
// side-effecting), and the tool writes `user_credentials` + `venue_accounts`
// (encrypted) via an injected fake db, returning `{ venueAccountId }`.
//
// Proves the L3-P1 contract at the boundary: secret validation → invalid_payload;
// a good invoke → both rows created (owner-keyed, encrypted) + metadata-only
// result; the plaintext secret NEVER appears in the result envelope.

import { describe, it, expect, beforeEach } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import type { TradingToolContext } from '@traderton/domain';
import { ToolRegistry, provisioningTools, decryptCredential } from '@traderton/worker';
import { createBoundaryApp } from './app.js';
import type { BoundaryConfig } from './config.js';
import type {
  TradingToolContextFactory,
  BoundaryInvocationStore,
  ComputeRequestFingerprint,
} from './dispatcher.js';

const CONSUMER_ID = 'consumerA';
const KEY_ID = 'current';
const SECRET = 'test-signing-secret';
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const INVOKE_PATH = '/internal/v1/tools:invoke';
const OWNER_ID = 'owner-1';
const ENCRYPTION_KEY = 'a'.repeat(64);

const CONFIG: BoundaryConfig = {
  clockSkewMs: 30_000,
  allowedConsumers: { [CONSUMER_ID]: { keyId: KEY_ID, secret: SECRET } },
};

// Captured inserts from the fake db.
let credentialInsert: Record<string, unknown> | undefined;
let venueAccountInsert: Record<string, unknown> | undefined;
// Ordered capture of every insert's values, in call order — lets tests assert
// the credential→venue_account INSERT ORDER (FK ON DELETE RESTRICT requires it).
let insertOrder: Array<Record<string, unknown>>;

function buildFakeDb(): TradingToolContext['db'] {
  credentialInsert = undefined;
  venueAccountInsert = undefined;
  insertOrder = [];
  let n = 0;
  const tx = {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        insertOrder.push(v);
        if (n === 0) credentialInsert = v;
        else venueAccountInsert = v;
        n++;
        return Promise.resolve();
      },
    }),
  };
  return {
    transaction: async (fn: (innerTx: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as TradingToolContext['db'];
}

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of provisioningTools) registry.register(tool);
  return registry;
}

const CONTEXT_FACTORY: TradingToolContextFactory = (request) =>
  ({
    agentId: request.actor.id,
    sessionId: `s:${request.ownerId}`,
    ownerId: request.ownerId,
    executionMode: 'paper',
    authorizationMode: 'direct',
    redis: {} as TradingToolContext['redis'],
    publishToInbound: async () => {},
    db: buildFakeDb(),
  }) satisfies TradingToolContext;

function makeFakeStore() {
  const calls = { beginOrResolve: 0, complete: 0 };
  const store: BoundaryInvocationStore = {
    async beginOrResolve() {
      calls.beginOrResolve += 1;
      return { kind: 'started', id: 'row-1' };
    },
    async complete() {
      calls.complete += 1;
    },
    async findByRequestId() {
      return null;
    },
  };
  return { store, calls };
}

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
    subject: { ownerId: OWNER_ID, actor: { type: 'agent', id: 'actor-1' } },
    toolName: 'provision_venue_account',
    payload: { venue: 'hyperliquid', label: 'prod', secrets: {} },
    ...overrides,
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

async function invoke(app: ReturnType<typeof makeApp>, envelope: Envelope) {
  const rawBody = JSON.stringify(envelope);
  return app.inject({ method: 'POST', url: INVOKE_PATH, headers: signHeaders(rawBody), payload: rawBody });
}

describe('provision_venue_account boundary invoke', () => {
  beforeEach(() => {
    process.env['CREDENTIAL_ENCRYPTION_KEY'] = ENCRYPTION_KEY;
  });

  it('a signed invoke creates encrypted rows and returns { venueAccountId } (metadata only)', async () => {
    const { store, calls } = makeFakeStore();
    const app = makeApp({ invocationStore: store });
    const secrets = { apiKey: 'secret-key', secret: 'secret-value', walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
    const res = await invoke(
      app,
      validEnvelope({ payload: { venue: 'hyperliquid', label: 'prod', secrets } }),
    );

    const body = res.json();
    expect(body.outcome.kind).toBe('success');
    expect(body.outcome.payload.venueAccountId).toBeDefined();
    expect(body.outcome.payload.venue).toBe('hyperliquid');
    expect(body.outcome.payload.label).toBe('prod');

    // Side-effecting → went through the idempotency store once.
    expect(calls.beginOrResolve).toBe(1);
    expect(calls.complete).toBe(1);

    // INSERT ORDER: the credential row MUST be inserted before the venue-account
    // row — the FK (venue_accounts.credentialId → user_credentials, ON DELETE
    // RESTRICT) requires the referenced credential to exist first. Assert the
    // first insert carries the credential fields and the second references it.
    expect(insertOrder).toHaveLength(2);
    const [firstInsert, secondInsert] = insertOrder;
    expect(firstInsert?.encryptedData).toBeDefined();
    expect(firstInsert?.encryptionMeta).toBeDefined();
    expect(secondInsert?.credentialId).toBe(firstInsert?.id);
    expect(secondInsert?.encryptedData).toBeUndefined();

    // Both rows owner-keyed + linked; credential stored encrypted.
    expect(credentialInsert?.ownerId).toBe(OWNER_ID);
    expect(venueAccountInsert?.ownerId).toBe(OWNER_ID);
    expect(venueAccountInsert?.credentialId).toBe(credentialInsert?.id);
    const encrypted = credentialInsert?.encryptedData as string;
    expect(encrypted).not.toContain('secret-key');
    expect(JSON.parse(decryptCredential(encrypted, ENCRYPTION_KEY))).toEqual(secrets);

    // The plaintext secret NEVER appears in the result envelope.
    const envelopeStr = JSON.stringify(body);
    expect(envelopeStr).not.toContain('secret-key');
    expect(envelopeStr).not.toContain('secret-value');

    await app.close();
  });

  it('a bad venue secret → validation.invalid_payload (no rows written)', async () => {
    const app = makeApp();
    const res = await invoke(
      app,
      validEnvelope({ payload: { venue: 'hyperliquid', label: 'prod', secrets: { apiKey: 'k', secret: 's', walletAddress: '' } } }),
    );
    const body = res.json();
    expect(body.outcome.kind).toBe('failure');
    expect(body.outcome.code).toBe('validation.invalid_payload');
    expect(credentialInsert).toBeUndefined();
    expect(venueAccountInsert).toBeUndefined();
    await app.close();
  });

  it('is registered as a side-effecting tool (not read-only)', () => {
    const registry = buildRegistry();
    expect(registry.getReadOnlyToolNames()).not.toContain('provision_venue_account');
    expect(registry.has('provision_venue_account')).toBe(true);
  });
});
