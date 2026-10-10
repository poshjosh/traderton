import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import type { Database } from './index.js';
import {
  PresetAssessmentRepository,
  type InsertAssessmentArtifact,
  type InsertAssessmentRequest,
  type InsertAgentStrategyChange,
} from './preset-assessment-repository.js';
import { marketAssessmentRuns } from './schema/index.js';
import { openTestDb, truncate, type TestDb } from './test-helpers/integration-db.js';

const SKIP = !process.env['DATABASE_URL'];

/**
 * DATABASE_URL-gated integration test (004 preset-assessment data-only, S1).
 * Proves the request bookkeeping (cooldown/cache), the data-only artifact rows,
 * and the strategy-change audit trail. No billing columns.
 */
describe.skipIf(SKIP)('PresetAssessmentRepository (integration)', () => {
  let client: ReturnType<typeof postgres>;
  let db: TestDb;
  let repo: PresetAssessmentRepository;

  beforeAll(() => {
    const handle = openTestDb();
    db = handle.db;
    client = handle.client;
    repo = new PresetAssessmentRepository(db as unknown as Database);
  }, 30_000);

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await truncate(client, 'market_assessment_requests', 'market_assessment_artifacts', 'market_assessment_runs', 'agent_strategy_changes');
  });

  const identity = { instrumentKind: 'orderbook', venueFamily: 'hyperliquid', styleTier: 'standard', symbol: 'BTC' } as const;

  async function seedRun(): Promise<string> {
    const runId = crypto.randomUUID();
    await db.insert(marketAssessmentRuns).values({
      id: runId,
      instrumentKind: 'orderbook',
      venueFamily: 'hyperliquid',
      styleTier: 'standard',
      symbol: 'BTC',
      startedAt: new Date(),
      status: 'completed',
      evidenceRefs: [],
    });
    return runId;
  }

  function buildRequest(overrides: Partial<InsertAssessmentRequest> = {}): InsertAssessmentRequest {
    return {
      id: crypto.randomUUID(),
      ownerId: 'owner-1',
      agentId: 'agent-1',
      instrumentKind: 'orderbook',
      venueFamily: 'hyperliquid',
      styleTier: 'standard',
      symbol: 'BTC',
      identitySnapshot: { instrumentKind: 'orderbook', venueFamily: 'hyperliquid', styleTier: 'standard', symbol: 'BTC' },
      requestGroupKey: crypto.randomUUID(),
      status: 'assessment_completed',
      requestedAt: new Date(),
      ...overrides,
    };
  }

  function buildArtifact(overrides: Partial<InsertAssessmentArtifact> = {}): InsertAssessmentArtifact {
    return {
      id: crypto.randomUUID(),
      instrumentKind: 'orderbook',
      venueFamily: 'hyperliquid',
      styleTier: 'standard',
      symbol: 'BTC',
      identitySnapshot: { instrumentKind: 'orderbook', venueFamily: 'hyperliquid', styleTier: 'standard', symbol: 'BTC' },
      assessmentRunId: crypto.randomUUID(),
      assessedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
      status: 'active',
      allowedPresets: ['momentum', 'range'],
      evidence: { regime: { state: 'available' } },
      presets: [{ presetKey: 'momentum' }],
      currentStrategy: { presetKey: 'momentum' },
      evidenceRefs: ['regime:boundary'],
      ...overrides,
    };
  }

  it('returns the freshest active artifact for an identity', async () => {
    const runId = await seedRun();
    // Two artifacts for the SAME identity: the unique active index allows only
    // one active row, so the older one must be superseded first.
    await repo.insertArtifact(buildArtifact({ assessmentRunId: runId, assessedAt: new Date(Date.now() - 1000), status: 'superseded' }));
    await repo.insertArtifact(buildArtifact({ assessmentRunId: runId, assessedAt: new Date() }));

    const fresh = await repo.findFreshArtifact(identity, new Date());
    expect(fresh).not.toBeNull();
    expect(fresh!.presets).toEqual([{ presetKey: 'momentum' }]);
  });

  it('does not return an expired artifact', async () => {
    const runId = await seedRun();
    await repo.insertArtifact(buildArtifact({ assessmentRunId: runId, expiresAt: new Date(Date.now() - 1000) }));
    const fresh = await repo.findFreshArtifact(identity, new Date());
    expect(fresh).toBeNull();
  });

  it('records the latest completed request for cooldown bookkeeping', async () => {
    await repo.insertRequest(buildRequest({ requestedAt: new Date(Date.now() - 1000) }));
    await repo.insertRequest(buildRequest({ requestedAt: new Date() }));

    const latest = await repo.latestCompletedRequest('agent-1', identity);
    expect(latest).not.toBeNull();
    expect(latest!.status).toBe('assessment_completed');
  });

  it('records and lists strategy changes with the agent reason', async () => {
    const change: InsertAgentStrategyChange = {
      id: crypto.randomUUID(),
      ownerId: 'owner-1',
      actorId: 'agent-1',
      fromStrategy: { presetKey: 'momentum' },
      toStrategy: { presetKey: 'range' },
      artifactId: 'artifact-1',
      reason: 'Range fits the choppy regime',
      state: 'applied',
      appliedAt: new Date(),
    };
    await repo.insertStrategyChange(change);

    const rows = await repo.listStrategyChanges({ ownerId: 'owner-1', actorId: 'agent-1', limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe('Range fits the choppy regime');
    expect(rows[0]!.state).toBe('applied');
  });

  it('returns the latest applied change for cooldown bookkeeping', async () => {
    await repo.insertStrategyChange({
      id: crypto.randomUUID(),
      ownerId: 'owner-1',
      actorId: 'agent-1',
      fromStrategy: null,
      toStrategy: { presetKey: 'momentum' },
      artifactId: 'a1',
      reason: 'x',
      state: 'applied',
      appliedAt: new Date(Date.now() - 1000),
    });
    await repo.insertStrategyChange({
      id: crypto.randomUUID(),
      ownerId: 'owner-1',
      actorId: 'agent-1',
      fromStrategy: { presetKey: 'momentum' },
      toStrategy: { presetKey: 'range' },
      artifactId: 'a2',
      reason: 'y',
      state: 'applied',
      appliedAt: new Date(),
    });

    const latest = await repo.latestAppliedChange('agent-1');
    expect(latest).not.toBeNull();
    expect(latest!.artifactId).toBe('a2');
  });
});