import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index.js';
import type { Database } from './index.js';
import {
  BoundaryInvocationRepository,
  computeRequestFingerprint,
  type BeginOrResolveParams,
} from './boundary-invocation-repository.js';
import { openTestDb, truncate, type TestDb } from './test-helpers/integration-db.js';

const SKIP = !process.env['DATABASE_URL'];

/**
 * DATABASE_URL-gated integration test (F2a). Skips locally, runs against real
 * Postgres when DATABASE_URL is set — matching the item-E
 * `bot-limit.integration.test.ts` pattern.
 *
 * Proves the copy-adapted idempotency flow re-keyed to the 005 four-tuple: fresh
 * key → started; same key + same fingerprint while in_progress → in_progress;
 * same key + same fingerprint after complete → replay; different fingerprint →
 * conflict; the four-tuple is the key; and (the real proof, like item E) N
 * concurrent begins for one key → exactly ONE started, the advisory lock
 * serializing the rest.
 */
describe.skipIf(SKIP)('BoundaryInvocationRepository idempotency (integration)', () => {
  let client: ReturnType<typeof postgres>;
  let db: TestDb;
  let repo: BoundaryInvocationRepository;

  const RETENTION_MS = 168 * 60 * 60 * 1000; // 005 default (a VALUE, passed in)

  function params(overrides: Partial<BeginOrResolveParams> = {}): BeginOrResolveParams {
    const consumerId = overrides.consumerId ?? 'consumerA';
    const ownerId = overrides.ownerId ?? 'owner-1';
    const toolName = overrides.toolName ?? 'place_order';
    const payload = { symbol: 'BTC', side: 'buy', qty: 1 };
    return {
      consumerId,
      ownerId,
      toolName,
      idempotencyKey: overrides.idempotencyKey ?? 'idem-1',
      requestFingerprint:
        overrides.requestFingerprint ??
        computeRequestFingerprint({ consumerId, ownerId, toolName, payload }),
      requestId: overrides.requestId ?? 'req-1',
      correlationId: overrides.correlationId ?? 'corr-1',
      retentionMs: overrides.retentionMs ?? RETENTION_MS,
    };
  }

  async function countRows(): Promise<number> {
    const rows = await client.unsafe(`SELECT id FROM boundary_invocations`);
    return rows.length;
  }

  beforeAll(() => {
    const handle = openTestDb();
    db = handle.db;
    client = handle.client;
    repo = new BoundaryInvocationRepository(db as unknown as Database);
  }, 30_000);

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await truncate(client, 'boundary_invocations');
  });

  it('fresh key → started (inserts one in_progress row)', async () => {
    const result = await repo.beginOrResolve(params());
    expect(result.kind).toBe('started');
    expect(await countRows()).toBe(1);
    const [row] = await client.unsafe(`SELECT state FROM boundary_invocations`);
    expect(row['state']).toBe('in_progress');
  });

  it('same key + same fingerprint while in_progress → in_progress (no duplicate row)', async () => {
    await repo.beginOrResolve(params());
    const again = await repo.beginOrResolve(params());
    expect(again.kind).toBe('in_progress');
    expect(await countRows()).toBe(1);
  });

  it('same key + same fingerprint after complete → replay with stored terminalResponse', async () => {
    await repo.beginOrResolve(params());
    const terminal = { contractVersion: '1.0', requestId: 'req-1', outcome: { kind: 'success' } };
    await repo.complete({
      consumerId: 'consumerA',
      ownerId: 'owner-1',
      toolName: 'place_order',
      idempotencyKey: 'idem-1',
      terminalResponse: terminal,
    });

    const replay = await repo.beginOrResolve(params());
    expect(replay.kind).toBe('replay');
    if (replay.kind === 'replay') {
      expect(replay.terminalResponse).toEqual(terminal);
    }
    expect(await countRows()).toBe(1);
  });

  it('same key + different fingerprint → conflict', async () => {
    await repo.beginOrResolve(params());
    const conflict = await repo.beginOrResolve(
      params({ requestFingerprint: 'a-different-fingerprint' }),
    );
    expect(conflict.kind).toBe('conflict');
    expect(await countRows()).toBe(1);
  });

  it('the four-tuple is the key — differing in any one field is a DISTINCT row', async () => {
    await repo.beginOrResolve(params());
    // Each of these differs in exactly one tuple field → all distinct, all started.
    expect((await repo.beginOrResolve(params({ consumerId: 'consumerB' }))).kind).toBe('started');
    expect((await repo.beginOrResolve(params({ ownerId: 'owner-2' }))).kind).toBe('started');
    expect((await repo.beginOrResolve(params({ toolName: 'cancel_order' }))).kind).toBe('started');
    expect((await repo.beginOrResolve(params({ idempotencyKey: 'idem-2' }))).kind).toBe('started');
    expect(await countRows()).toBe(5);
  });

  it('N concurrent beginOrResolve for one key → exactly ONE started, one row', async () => {
    // This case needs its OWN multi-connection pool. The shared openTestDb()
    // helper uses postgres(url, { max: 1 }) — a SINGLE connection — so N
    // Promise.all'd transactions would serialize at the pool and the test would
    // pass even with the advisory lock removed, proving nothing about
    // cross-connection serialization. We do NOT change the shared helper (item E
    // and other integration tests depend on its {max:1} shape); instead we open a
    // pool with max = n here so the N beginOrResolve calls genuinely run on
    // distinct connections concurrently, forcing pg_advisory_xact_lock to be the
    // thing that serializes them.
    const n = 12;
    const url = process.env['DATABASE_URL']!;
    const concurrentClient = postgres(url, { max: n });
    try {
      const concurrentDb = drizzle(concurrentClient, { schema });
      const concurrentRepo = new BoundaryInvocationRepository(
        concurrentDb as unknown as Database,
      );
      const results = await Promise.all(
        Array.from({ length: n }, () => concurrentRepo.beginOrResolve(params())),
      );
      const started = results.filter((r) => r.kind === 'started').length;
      const inProgress = results.filter((r) => r.kind === 'in_progress').length;
      expect(started).toBe(1);
      expect(inProgress).toBe(n - 1);
      expect(await countRows()).toBe(1);
    } finally {
      // Close the extra connections so the suite doesn't leak them.
      await concurrentClient.end();
    }
  }, 30_000);

  it('findByRequestId returns the row for a known requestId', async () => {
    await repo.beginOrResolve(params({ requestId: 'req-lookup' }));
    const row = await repo.findByRequestId('req-lookup');
    expect(row).not.toBeNull();
    expect(row?.requestId).toBe('req-lookup');
    expect(await repo.findByRequestId('nope')).toBeNull();
  });
});
