// AUTHORED (Phase 3 T2.2, TC4) — the MCP idempotency verification against the
// REAL store/stack, the MCP sibling of boundary.verification.integration.test.ts.
//
// DATABASE_URL + REDIS_URL gated (skips locally without them). The REAL official
// `@modelcontextprotocol/client` drives the REAL `createBoundaryApp` (listening on
// an ephemeral port, MCP mounted) through a signing fetch that reuses the committed
// dev signer. The create_bot side effect runs in PAPER mode via the REAL
// `createDriveTarget` + the item-E `tryCreateBotWithLimit`, with a STUBBED
// `enqueueLifecycle` (no actor start → no venue drive). It authors NO trading
// behaviour — it asserts ALREADY-BUILT idempotency over the MCP transport.

import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { TradingToolContext } from '@traderton/domain';
import { ToolRegistry } from '@traderton/worker';
import { createDriveTarget, botManagementTools } from '@traderton/worker';
import {
  BoundaryInvocationRepository,
  BotRepository,
  computeRequestFingerprint,
  createDatabase,
  closeDatabase,
  type Database,
} from '@traderton/db';
import type { FastifyInstance } from 'fastify';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createBoundaryApp } from './app.js';
import type { BoundaryConfig } from './config.js';
import type { TradingToolContextFactory } from './dispatcher.js';
import { signInvoke, signRequest, type SigningIdentity } from './dev/sign.js';
import { MCP_PATH } from './mcp/constants.js';

const SKIP = !process.env['DATABASE_URL'] || !process.env['REDIS_URL'];

const CONSUMER_ID = 'consumerA';
const KEY_ID = 'current';
const SECRET = 'test-signing-secret';
const IDENTITY: SigningIdentity = { consumerId: CONSUMER_ID, keyId: KEY_ID, secret: SECRET };

const INVOKE_PATH = '/internal/v1/tools:invoke';

const CONFIG: BoundaryConfig = {
  clockSkewMs: 30_000,
  idempotencyRetentionHours: 168,
  allowedConsumers: { [CONSUMER_ID]: { keyId: KEY_ID, secret: SECRET } },
};

const OWNER_ID = 'owner-mcp-verif';
const VENUE_ACCOUNT_ID = 'va-mcp-verif';
const ACTOR_ID = 'actor-mcp-verif';
const MAX_BOTS = 5;

interface EnvelopeMeta {
  contractVersion: string;
  requestId: string;
  idempotencyKey: string;
  correlationId: string;
  issuedAt: string;
  deadlineAt: string;
  caller: { consumerId: string; keyId: string };
  subject: { ownerId: string; actor: { type: string; id: string } };
}

function futureDeadline(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

function meta(overrides: Partial<EnvelopeMeta> = {}): EnvelopeMeta {
  return {
    contractVersion: '1.0',
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
    correlationId: 'corr-1',
    issuedAt: new Date().toISOString(),
    deadlineAt: futureDeadline(),
    caller: { consumerId: CONSUMER_ID, keyId: KEY_ID },
    subject: { ownerId: OWNER_ID, actor: { type: 'agent', id: ACTOR_ID } },
    ...overrides,
  };
}

function paperBotConfig(): Record<string, unknown> {
  return {
    symbol: 'BTC-USDC',
    strategy: { type: 'momentum', decisionMode: 'mechanical' },
    execution: { mode: 'paper' },
  };
}

/** The REST invocation envelope that mirrors an MCP tools/call's name/arguments/_meta. */
function restEnvelope(m: EnvelopeMeta, toolName: string, payload: unknown): Record<string, unknown> {
  return { ...m, toolName, payload };
}

describe.skipIf(SKIP)('boundary MCP idempotency verification (integration)', () => {
  let db: Database;
  let sql: { unsafe: (query: string, params?: unknown[]) => Promise<unknown[]> };
  let invocationStore: BoundaryInvocationRepository;
  let botRepo: BotRepository;
  let enqueued: Array<{ command: string; botId: string }>;
  let app: FastifyInstance;
  let baseUrl: URL;

  beforeAll(async () => {
    const url = process.env['DATABASE_URL']!;
    db = createDatabase(url);
    sql = (db as unknown as { $client: typeof sql }).$client;
    invocationStore = new BoundaryInvocationRepository(db);
    botRepo = new BotRepository(db);

    const registry = new ToolRegistry();
    for (const tool of botManagementTools) registry.register(tool);

    const contextFactory: TradingToolContextFactory = (request): TradingToolContext => {
      const publishToInbound = createDriveTarget({
        runtime: {
          async enqueueLifecycle(command: string, botId: string): Promise<void> {
            enqueued.push({ command, botId });
          },
        } as unknown as Parameters<typeof createDriveTarget>[0]['runtime'],
        submitDecision: async () => ({ ok: true }) as unknown as Awaited<
          ReturnType<Parameters<typeof createDriveTarget>[0]['submitDecision']>
        >,
        botRepo: botRepo as unknown as Parameters<typeof createDriveTarget>[0]['botRepo'],
        redis: {
          async lpush() {
            return 1;
          },
          async expire() {
            return 1;
          },
        },
        botLimit: {
          tryCreateBotWithLimit: (spec) => botRepo.tryCreateBotWithLimit({ ...spec, maxBots: MAX_BOTS }),
          tryMarkBotRunningWithLimit: (spec) =>
            botRepo.tryMarkBotRunningWithLimit({ ...spec, maxBots: MAX_BOTS }),
        },
        ownerId: request.ownerId,
        actorId: request.actor.id,
        ownerMode: 'paper',
        venue: 'hyperliquid',
        venueType: 'orderbook',
        venueAccountId: VENUE_ACCOUNT_ID,
      });

      return {
        agentId: request.actor.id,
        sessionId: `boundary:${request.ownerId}`,
        executionMode: 'paper',
        authorizationMode: 'direct',
        redis: {} as TradingToolContext['redis'],
        publishToInbound,
        botRepo: botRepo as unknown as TradingToolContext['botRepo'],
        ownerId: request.ownerId,
        db: db as unknown as TradingToolContext['db'],
      } satisfies TradingToolContext;
    };

    app = createBoundaryApp({
      config: CONFIG,
      registry,
      contextFactory,
      invocationStore,
      computeRequestFingerprint,
      retentionMs: 168 * 60 * 60 * 1000,
      mcp: { tools: [] },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    baseUrl = new URL(`http://127.0.0.1:${address.port}${MCP_PATH}`);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await closeDatabase(db);
  });

  beforeEach(async () => {
    enqueued = [];
    await sql.unsafe(`TRUNCATE bots, venue_accounts, boundary_invocations CASCADE`);
    await sql.unsafe(
      `INSERT INTO venue_accounts (id, owner_id, venue, label) VALUES ($1, $2, $3, $4)`,
      [VENUE_ACCOUNT_ID, OWNER_ID, 'hyperliquid', 'label-verif'],
    );
  });

  /** A signing fetch for the SDK client: signs over the exact body bytes with the MCP path. */
  function signingFetch(deadlineAt: string): typeof fetch {
    return async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body;
      if (body !== undefined && body !== null && typeof body !== 'string') {
        throw new TypeError('non-string MCP request body');
      }
      const rawBody = Buffer.from(body ?? '', 'utf8');
      const signed = signRequest(IDENTITY, { method, path: MCP_PATH, rawBody, deadlineAt });
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(signed)) headers.set(name, value);
      return fetch(url, { ...init, headers, body });
    };
  }

  /** Run one MCP tools/call and return the structuredContent (the 005 response). */
  async function mcpCall(
    m: EnvelopeMeta,
    toolName: string,
    args: unknown,
  ): Promise<{ structuredContent: unknown; isError?: boolean }> {
    const client = new Client({ name: 'mcp-verif', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(baseUrl, { fetch: signingFetch(m.deadlineAt) });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: toolName, arguments: args as Record<string, unknown>, _meta: m });
      return { structuredContent: result.structuredContent, isError: result.isError as boolean | undefined };
    } finally {
      await client.close();
    }
  }

  async function restInvoke(m: EnvelopeMeta, toolName: string, payload: unknown) {
    const envelope = restEnvelope(m, toolName, payload);
    const { headers, rawBody } = signInvoke(IDENTITY, INVOKE_PATH, envelope as { deadlineAt: string });
    return app.inject({ method: 'POST', url: INVOKE_PATH, headers, payload: rawBody });
  }

  async function countBots(): Promise<number> {
    const rows = await sql.unsafe(`SELECT id FROM bots WHERE owner_id = $1`, [OWNER_ID]);
    return rows.length;
  }

  async function countInvocations(): Promise<number> {
    const rows = await sql.unsafe(`SELECT id FROM boundary_invocations`);
    return rows.length;
  }

  it('the same signed create_bot over MCP twice persists exactly one bot row and one invocation', async () => {
    const m = meta();
    const first = await mcpCall(m, 'create_bot', { config: paperBotConfig() });
    expect(first.isError).toBeUndefined();
    expect(first.structuredContent).toMatchObject({ outcome: { kind: 'success' } });

    // Exact same envelope (same requestId + idempotencyKey + payload) → replay.
    const second = await mcpCall(m, 'create_bot', { config: paperBotConfig() });
    expect(second.isError).toBeUndefined();
    expect(second.structuredContent).toMatchObject({ outcome: { kind: 'success' } });

    expect(await countBots()).toBe(1);
    expect(await countInvocations()).toBe(1);
    expect(enqueued.filter((e) => e.command === 'start').length).toBe(1);
  });

  it('reusing the key with a changed payload over MCP returns validation.invalid_payload with no second bot row', async () => {
    const key = `idem-fixed-${Math.random().toString(36).slice(2)}`;
    const first = await mcpCall(meta({ idempotencyKey: key }), 'create_bot', { config: paperBotConfig() });
    expect(first.structuredContent).toMatchObject({ outcome: { kind: 'success' } });
    expect(await countBots()).toBe(1);

    const changed = { config: { ...paperBotConfig(), symbol: 'ETH-USDC' } };
    const second = await mcpCall(meta({ idempotencyKey: key }), 'create_bot', changed);
    expect(second.isError).toBe(true);
    expect(second.structuredContent).toMatchObject({
      outcome: { kind: 'failure', code: 'validation.invalid_payload' },
    });
    expect(await countBots()).toBe(1);
  });

  it('a key first used over REST replays over MCP without a second execution', async () => {
    const m = meta();
    const rest = await restInvoke(m, 'create_bot', { config: paperBotConfig() });
    expect(rest.json().outcome.kind).toBe('success');
    expect(await countBots()).toBe(1);
    expect(await countInvocations()).toBe(1);

    // Same requestId + idempotencyKey + payload, now over MCP → stored replay.
    const mcp = await mcpCall(m, 'create_bot', { config: paperBotConfig() });
    expect(mcp.isError).toBeUndefined();
    expect(mcp.structuredContent).toMatchObject({ requestId: m.requestId, outcome: { kind: 'success' } });

    // No second bot row and no second invocation — the MCP call replayed.
    expect(await countBots()).toBe(1);
    expect(await countInvocations()).toBe(1);
    expect(enqueued.filter((e) => e.command === 'start').length).toBe(1);
  });

  it('an already-past deadline over MCP returns deadline.expired and persists nothing', async () => {
    const pastDeadline = new Date(Date.now() - 5_000).toISOString();
    const result = await mcpCall(meta({ deadlineAt: pastDeadline }), 'create_bot', {
      config: paperBotConfig(),
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      outcome: { kind: 'failure', code: 'deadline.expired' },
    });
    expect(await countBots()).toBe(0);
    expect(await countInvocations()).toBe(0);
  });
});
