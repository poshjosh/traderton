// AUTHORED (Phase 9b item F2c) — the 7 REQUIRED-VERIFICATION tests
// (005 §"Required Verification"), wired against the REAL store/stack.
//
// DATABASE_URL + REDIS_URL gated (skip locally without them — the item-E / F2a
// integration pattern). Tests 1–6 drive the REAL boundary via `app.inject`
// against `createBoundaryApp` wired to a REAL Postgres-backed
// `BoundaryInvocationRepository` + a REAL `BotRepository`. Test 7 needs the
// docker-compose stack (see docker-compose.yml + scripts/shell/tests/run-integration.sh) and
// is skipped unless BOUNDARY_BASE_URL points at a running boundary.
//
// F2c authors NO trading behaviour — these assert ALREADY-BUILT behaviour. The
// side-effecting test (#4) drives create_bot in PAPER mode; its downstream effect
// is exactly ONE persisted bot row via the item-E `tryCreateBotWithLimit`. It
// NEVER drives a live venue: the runtime's `enqueueLifecycle` (the actor start
// job) is stubbed to a no-op spy, so only the create+persist path runs.
//
// All signed calls use the committed dev signing helper (src/dev/sign.ts) — the
// same `buildCanonicalString` the verifier uses, so the signed bytes cannot drift.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { TradingToolContext, ToolResult, AgentTool } from '@traderton/domain';
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
import { z } from 'zod';
import { createBoundaryApp } from './app.js';
import type { BoundaryConfig } from './config.js';
import type { TradingToolContextFactory } from './dispatcher.js';
import { signInvoke, signRequest, type SigningIdentity } from './dev/sign.js';

const SKIP = !process.env['DATABASE_URL'] || !process.env['REDIS_URL'];

// ── Fixtures ────────────────────────────────────────────────────────────────

const CONSUMER_ID = 'consumerA';
const KEY_ID = 'current';
const SECRET = 'test-signing-secret';
const IDENTITY: SigningIdentity = { consumerId: CONSUMER_ID, keyId: KEY_ID, secret: SECRET };

const INVOKE_PATH = '/internal/v1/tools:invoke';
const STATUS_BASE = '/internal/v1/invocations/';

const CONFIG: BoundaryConfig = {
  clockSkewMs: 30_000,
  idempotencyRetentionHours: 168,
  allowedConsumers: { [CONSUMER_ID]: { keyId: KEY_ID, secret: SECRET } },
};

const OWNER_ID = 'owner-verif';
const VENUE_ACCOUNT_ID = 'va-verif';
const ACTOR_ID = 'actor-verif';
const MAX_BOTS = 5;

// A deterministic read-only tool for the "valid signed read-only call succeeds"
// assertion (test #1). Registered alongside the real trading tools; it needs no
// live data, so the happy path is unambiguous.
const echoReadTool: AgentTool<TradingToolContext> = {
  name: 'echo_read',
  description: 'read-only echo (verification fixture)',
  parametersSchema: z.object({ value: z.string() }),
  parameters: {},
  category: 'read-config',
  async execute(params: unknown): Promise<ToolResult> {
    const { value } = params as { value: string };
    return { success: true, data: { echoed: value } };
  },
};

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

/** A far-future deadline so requests are live unless a test overrides it. */
function futureDeadline(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

function validEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    contractVersion: '1.0',
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
    correlationId: 'corr-1',
    issuedAt: new Date().toISOString(),
    deadlineAt: futureDeadline(),
    caller: { consumerId: CONSUMER_ID, keyId: KEY_ID },
    subject: { ownerId: OWNER_ID, actor: { type: 'agent', id: ACTOR_ID } },
    toolName: 'echo_read',
    payload: { value: 'hi' },
    ...overrides,
  };
}

/** A valid PAPER-mode bot config for create_bot (venue/venueType injected). */
function paperBotConfig(): Record<string, unknown> {
  return {
    symbol: 'BTC-USDC',
    strategy: { type: 'momentum', decisionMode: 'mechanical' },
    execution: { mode: 'paper' },
  };
}

describe.skipIf(SKIP)('boundary 005 required verification (integration)', () => {
  let db: Database;
  /** The underlying postgres-js client for raw truncate/seed/count SQL. */
  let sql: { unsafe: (query: string, params?: unknown[]) => Promise<unknown[]> };
  let invocationStore: BoundaryInvocationRepository;
  let botRepo: BotRepository;
  /** Records enqueued start jobs so we can prove NO venue drive happened. */
  let enqueued: Array<{ command: string; botId: string }>;

  beforeAll(() => {
    const url = process.env['DATABASE_URL']!;
    db = createDatabase(url);
    // postgres-js is reachable via the drizzle client's `$client` (same handle
    // `closeDatabase` closes) — avoids a direct `postgres` import the boundary
    // package does not depend on.
    sql = (db as unknown as { $client: typeof sql }).$client;
    invocationStore = new BoundaryInvocationRepository(db);
    botRepo = new BotRepository(db);
  }, 30_000);

  afterAll(async () => {
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

  /**
   * Build the boundary app wired to the REAL store + a REAL context factory. The
   * factory routes create_bot's `publishToInbound` through the REAL
   * `createDriveTarget` (real BotConfig validation + real item-E
   * `tryCreateBotWithLimit`/`tryMarkBotRunningWithLimit` against the real DB), with
   * a STUBBED `enqueueLifecycle` (no actor start → no venue drive). Read-only tools
   * get the same context but never touch the drive path.
   */
  function buildApp(overrides: { now?: () => number } = {}) {
    const registry = new ToolRegistry();
    registry.register(echoReadTool);
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
          tryCreateBotWithLimit: (spec) =>
            botRepo.tryCreateBotWithLimit({ ...spec, maxBots: MAX_BOTS }),
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
        authorizationMode: 'approval_required',
        redis: {} as TradingToolContext['redis'],
        publishToInbound,
        botRepo: botRepo as unknown as TradingToolContext['botRepo'],
        // Owner scope + raw db handle for owner-scoped tools (instantiate_bot's
        // owner-narrow venue-account check + insertStoppedBot). create_bot ignores
        // these — it drives the publishToInbound path.
        ownerId: request.ownerId,
        db: db as unknown as TradingToolContext['db'],
      } satisfies TradingToolContext;
    };

    return createBoundaryApp({
      config: CONFIG,
      registry,
      contextFactory,
      invocationStore,
      computeRequestFingerprint,
      retentionMs: 168 * 60 * 60 * 1000,
      ...(overrides.now ? { now: overrides.now } : {}),
    });
  }

  async function invoke(
    app: ReturnType<typeof buildApp>,
    envelope: Envelope,
    opts: { timestamp?: string; badSignature?: boolean } = {},
  ) {
    const { headers, rawBody } = signInvoke(IDENTITY, INVOKE_PATH, envelope, {
      ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
    });
    if (opts.badSignature) headers['x-traderton-signature'] = 'sha256=deadbeef';
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

  // ── 005 item 1: signed-call authentication ─────────────────────────────────
  // "valid signed calls succeed; invalid/expired/replayed/unauthorized signatures
  //  fail BEFORE execution."
  describe('1. signature verification (before execution)', () => {
    it('a valid signed read-only call succeeds', async () => {
      const app = buildApp();
      const res = await invoke(app, validEnvelope());
      const body = res.json();
      expect(body.outcome.kind).toBe('success');
      expect(body.outcome.payload).toEqual({ echoed: 'hi' });
      await app.close();
    });

    it('a bad signature fails as authentication.invalid_caller (tool never runs)', async () => {
      const app = buildApp();
      const res = await invoke(app, validEnvelope(), { badSignature: true });
      expect(res.json().outcome.code).toBe('authentication.invalid_caller');
      await app.close();
    });

    it('a wrong consumer fails as authentication.invalid_caller', async () => {
      const app = buildApp();
      // Sign with a consumer the config does not know.
      const badIdentity: SigningIdentity = { ...IDENTITY, consumerId: 'nope' };
      const { headers, rawBody } = signInvoke(badIdentity, INVOKE_PATH, validEnvelope());
      const res = await app.inject({ method: 'POST', url: INVOKE_PATH, headers, payload: rawBody });
      expect(res.json().outcome.code).toBe('authentication.invalid_caller');
      await app.close();
    });

    it('an out-of-skew timestamp fails as authentication.invalid_caller', async () => {
      const app = buildApp();
      const res = await invoke(app, validEnvelope(), {
        timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
      });
      expect(res.json().outcome.code).toBe('authentication.invalid_caller');
      await app.close();
    });

    it('a replayed capture outside the skew window fails (clock advanced past the window)', async () => {
      const capturedTs = new Date().toISOString();
      // The app's clock is 60s ahead — a signature valid at capture is now stale.
      const app = buildApp({ now: () => Date.now() + 60_000 });
      const res = await invoke(app, validEnvelope(), { timestamp: capturedTs });
      expect(res.json().outcome.code).toBe('authentication.invalid_caller');
      await app.close();
    });
  });

  // ── 005 item 2: envelope / payload validation ──────────────────────────────
  describe('2. malformed envelopes and payloads → typed validation failures', () => {
    it('an unknown outer key → validation.invalid_payload', async () => {
      const app = buildApp();
      const envelope = { ...validEnvelope(), unexpected: true } as unknown as Envelope;
      const res = await invoke(app, envelope);
      expect(res.json().outcome.code).toBe('validation.invalid_payload');
      await app.close();
    });

    it('a non-JSON body → validation.invalid_payload', async () => {
      const app = buildApp();
      // The signature must be over the EXACT (malformed) bytes so auth passes and
      // the JSON-parse failure is what's under test — sign the raw body directly.
      const malformed = '{not json';
      const deadlineAt = futureDeadline();
      const headers = signRequest(IDENTITY, {
        method: 'POST',
        path: INVOKE_PATH,
        rawBody: Buffer.from(malformed, 'utf8'),
        deadlineAt,
      });
      const res = await app.inject({
        method: 'POST',
        url: INVOKE_PATH,
        headers,
        payload: malformed,
      });
      expect(res.json().outcome.code).toBe('validation.invalid_payload');
      await app.close();
    });

    it('a bad payload → validation.invalid_payload', async () => {
      const app = buildApp();
      const res = await invoke(app, validEnvelope({ payload: { value: 42 } }));
      expect(res.json().outcome.code).toBe('validation.invalid_payload');
      await app.close();
    });

    it('an unsupported contractVersion → contract.unsupported_version', async () => {
      const app = buildApp();
      const res = await invoke(app, validEnvelope({ contractVersion: '2.0' }));
      expect(res.json().outcome.code).toBe('contract.unsupported_version');
      await app.close();
    });
  });

  // ── 005 item 3: deadline expiry prevents side effects ──────────────────────
  describe('3. deadline expiry prevents side effects', () => {
    it('an already-past deadline → deadline.expired and NO bot row is persisted', async () => {
      const app = buildApp();
      const pastDeadline = new Date(Date.now() - 5_000).toISOString();
      const res = await invoke(
        app,
        validEnvelope({
          toolName: 'create_bot',
          payload: { config: paperBotConfig() },
          deadlineAt: pastDeadline,
        }),
      );
      expect(res.json().outcome.code).toBe('deadline.expired');
      expect(await countBots()).toBe(0);
      expect(await countInvocations()).toBe(0);
      await app.close();
    });
  });

  // ── 005 item 4: idempotent retry → ONE invocation + ONE downstream effect ──
  // The KEY test. create_bot (paper) — downstream effect is exactly ONE persisted
  // bot row via the item-E tryCreateBotWithLimit. Fire the SAME signed request
  // twice (same requestId + idempotencyKey); assert exactly ONE boundary_invocations
  // row AND exactly ONE bot row (the second call replays the stored terminal result).
  describe('4. retry with same key → one persisted invocation + one downstream effect', () => {
    it('firing the same signed create_bot twice persists exactly ONE bot row and ONE invocation', async () => {
      const app = buildApp();
      const envelope = validEnvelope({
        toolName: 'create_bot',
        payload: { config: paperBotConfig() },
      });

      const first = await invoke(app, envelope);
      expect(first.json().outcome.kind).toBe('success');

      // Exact same envelope (same requestId + idempotencyKey + payload) → replay.
      const second = await invoke(app, envelope);
      // The second returns the stored terminal result (success), NOT a new run.
      expect(second.json().outcome.kind).toBe('success');

      expect(await countBots()).toBe(1);
      expect(await countInvocations()).toBe(1);
      // The create path enqueued exactly one start job (the first run only).
      expect(enqueued.filter((e) => e.command === 'start').length).toBe(1);
      await app.close();
    });

    // c4.9d-FG: the same idempotency proof for instantiate_bot (stopped-create).
    // Downstream effect is exactly ONE persisted STOPPED bot row via
    // insertStoppedBot with the caller-supplied actorId. A same-key retry replays
    // the stored terminal result → ONE bot row + ONE invocation, NO second insert,
    // and (critically) NO start job (stopped-create has no start step).
    it('firing the same signed instantiate_bot twice persists exactly ONE stopped bot row and ONE invocation', async () => {
      const app = buildApp();
      const actorId = `actor-${Math.random().toString(36).slice(2)}`;
      const envelope = validEnvelope({
        toolName: 'instantiate_bot',
        payload: {
          actorId,
          venueAccountId: VENUE_ACCOUNT_ID,
          config: {
            symbol: 'BTC-USDC',
            strategy: { type: 'momentum', decisionMode: 'mechanical' },
            execution: { mode: 'paper' },
            venue: 'hyperliquid',
            venueType: 'orderbook',
          },
          blueprintId: 'bp-verif',
          blueprintRevisionId: 'rev-verif',
          configSnapshot: { source: 'verif' },
        },
      });

      const first = await invoke(app, envelope);
      const firstBody = first.json();
      expect(firstBody.outcome.kind).toBe('success');
      expect(firstBody.outcome.payload).toMatchObject({ botId: actorId, status: 'stopped' });

      // Same envelope → replay of the stored terminal result (no second insert).
      const second = await invoke(app, envelope);
      expect(second.json().outcome.kind).toBe('success');

      expect(await countBots()).toBe(1);
      expect(await countInvocations()).toBe(1);
      // Stopped-create never enqueues a start job.
      expect(enqueued.filter((e) => e.command === 'start').length).toBe(0);
      await app.close();
    });
  });

  // ── 005 item 5: same key + different payload → rejected ────────────────────
  describe('5. a different payload with the same key is rejected', () => {
    it('reusing the key with a changed payload → validation.invalid_payload, no second effect', async () => {
      const app = buildApp();
      const key = `idem-fixed-${Math.random().toString(36).slice(2)}`;
      const first = await invoke(
        app,
        validEnvelope({
          idempotencyKey: key,
          toolName: 'create_bot',
          payload: { config: paperBotConfig() },
        }),
      );
      expect(first.json().outcome.kind).toBe('success');
      expect(await countBots()).toBe(1);

      // Same key, DIFFERENT payload → fingerprint conflict.
      const conflictConfig = { ...paperBotConfig(), symbol: 'ETH-USDC' };
      const second = await invoke(
        app,
        validEnvelope({
          idempotencyKey: key,
          toolName: 'create_bot',
          payload: { config: conflictConfig },
        }),
      );
      expect(second.json().outcome.code).toBe('validation.invalid_payload');
      // No second bot row — the conflict is rejected before any effect.
      expect(await countBots()).toBe(1);
      await app.close();
    });
  });

  // ── 005 item 6: readiness failure blocks new traffic without hidden fallback ─
  // Modelled at the boundary level: when the trading context cannot be assembled
  // (a store/dependency unavailable), the side-effecting tool must NOT run and the
  // boundary returns precondition.not_ready — there is NO silent fallback that
  // executes the side effect anyway.
  describe('6. readiness failure blocks new traffic without hidden fallback', () => {
    it('a context factory that cannot assemble → precondition.not_ready, no side effect', async () => {
      const registry = new ToolRegistry();
      for (const tool of botManagementTools) registry.register(tool);

      // A factory that fails to assemble the trading context (models a down dep).
      const failingFactory: TradingToolContextFactory = () => {
        throw new Error('trading context dependency unavailable');
      };

      const app = createBoundaryApp({
        config: CONFIG,
        registry,
        contextFactory: failingFactory,
        invocationStore,
        computeRequestFingerprint,
        retentionMs: 168 * 60 * 60 * 1000,
      });

      const res = await invoke(
        app,
        validEnvelope({ toolName: 'create_bot', payload: { config: paperBotConfig() } }),
      );
      expect(res.json().outcome.code).toBe('precondition.not_ready');
      // No hidden fallback executed a side effect.
      expect(await countBots()).toBe(0);
      await app.close();
    });
  });

  // ── 005 item 7: compose/staging startup reaches a healthy /health/ready ─────
  // This is the one test that needs the actual compose stack. It is skipped
  // unless BOUNDARY_BASE_URL points at a running boundary (the runner brings the
  // stack up first). See scripts/shell/tests/run-integration.sh + docker-compose.yml.
  describe('7. compose startup reaches a healthy /health/ready', () => {
    const BASE_URL = process.env['BOUNDARY_BASE_URL'];
    it.skipIf(!BASE_URL)('the running boundary serves /health/ready', async () => {
      const res = await fetch(`${BASE_URL}/health/ready`);
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe('ready');
    });
  });
});
