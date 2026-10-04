import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import type { Database } from './index.js';
import {
  AgentScanRepository,
  type InsertScanCandidate,
  type InsertScanMetric,
} from './agent-scan-repository.js';
import { openTestDb, truncate, type TestDb } from './test-helpers/integration-db.js';

const SKIP = !process.env['DATABASE_URL'];

/**
 * DATABASE_URL-gated integration test (E1-T T3). Skips locally, runs against real
 * Postgres when DATABASE_URL is set — matching the consumer-notification /
 * journal integration patterns. Proves the bulk candidate insert + single metrics
 * insert, and the batched `scannedAt`-keyed retention delete on BOTH scan tables.
 *
 * NOTE: `agent_scan_candidates` has NO foreign key in Traderton (soft-keyed
 * agent_id), so — unlike herobids — no agents row is seeded.
 */
describe.skipIf(SKIP)('AgentScanRepository (integration)', () => {
  let client: ReturnType<typeof postgres>;
  let db: TestDb;
  let repo: AgentScanRepository;

  beforeAll(() => {
    const handle = openTestDb();
    db = handle.db;
    client = handle.client;
    // TestDb and Database are structurally identical (same drizzle(client, {schema}));
    // the cast is safe — only needed because they originate from different call sites.
    repo = new AgentScanRepository(db as unknown as Database);
  }, 30_000);

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await truncate(client, 'agent_scan_candidates', 'agent_scan_metrics');
  });

  function buildCandidate(overrides: Partial<InsertScanCandidate> = {}): InsertScanCandidate {
    return {
      id: crypto.randomUUID(),
      agentId: 'agent-1',
      scannedAt: new Date().toISOString(),
      scanVersion: 'ts-standard-v1',
      activePresetKey: 'momentum',
      presetBehaviorVersion: 'ts-standard-v1',
      instrumentKind: 'orderbook',
      venueFamily: 'hyperliquid',
      styleTier: 'standard',
      symbol: 'BTC',
      rawCandidateId: 'BTC',
      resolutionStatus: 'resolved',
      candidateRank: 1,
      scanScope: 'hyperliquid_standard',
      signalFacts: { signalType: 'entry_candidate', indication: 'bullish', strength: 0.8 },
      confidence: 0.8,
      regimeBucket: 'favorable',
      disposition: 'entry_candidate',
      ...overrides,
    };
  }

  function buildMetric(overrides: Partial<InsertScanMetric> = {}): InsertScanMetric {
    return {
      agentId: 'agent-1',
      presetKey: 'momentum',
      presetBehaviorVersion: 'ts-standard-v1',
      venueFamily: 'hyperliquid',
      styleTier: 'standard',
      scanScope: { discovered: 10, scored: 5, signals: 1 },
      scannedAt: new Date().toISOString(),
      candidatesDiscovered: 10,
      candidatesScored: 5,
      signalsGenerated: 1,
      scanHealth: 'healthy_signals',
      topConfidence: 0.8,
      regimeBucket: 'favorable',
      ...overrides,
    };
  }

  /** Backdate scanned_at on candidate rows so retention can be exercised deterministically. */
  async function setCandidateScannedAt(agentId: string, scannedAt: Date): Promise<void> {
    await client.unsafe(
      `UPDATE agent_scan_candidates SET scanned_at = $1 WHERE agent_id = $2`,
      [scannedAt.toISOString(), agentId],
    );
  }

  /** Backdate scanned_at on metrics rows so retention can be exercised deterministically. */
  async function setMetricScannedAt(agentId: string, scannedAt: Date): Promise<void> {
    await client.unsafe(
      `UPDATE agent_scan_metrics SET scanned_at = $1 WHERE agent_id = $2`,
      [scannedAt.toISOString(), agentId],
    );
  }

  it('inserts scored candidates and a metrics row', async () => {
    const candidates = [
      buildCandidate({ candidateRank: 1, symbol: 'BTC', rawCandidateId: 'BTC', confidence: 0.9 }),
      buildCandidate({ candidateRank: 2, symbol: 'ETH', rawCandidateId: 'ETH', confidence: 0.7, volatilityFact: 0.42 }),
    ];
    await repo.insertCandidates(candidates);
    await repo.insertMetrics(buildMetric({ topConfidence: 0.9 }));

    const candRows = await client.unsafe(
      `SELECT id, agent_id, symbol, candidate_rank, confidence, volatility_fact, signal_facts, scan_scope FROM agent_scan_candidates ORDER BY candidate_rank`,
    );
    expect(candRows).toHaveLength(2);
    expect(candRows[0]!['symbol']).toBe('BTC');
    // numeric column round-trips as a string in postgres-js.
    expect(Number(candRows[0]!['confidence'])).toBeCloseTo(0.9);
    expect(candRows[1]!['symbol']).toBe('ETH');
    expect(Number(candRows[1]!['volatility_fact'])).toBeCloseTo(0.42);
    // jsonb signal_facts preserved.
    expect((candRows[0]!['signal_facts'] as { signalType: string }).signalType).toBe('entry_candidate');
    // scan_scope is a text column on candidates.
    expect(candRows[0]!['scan_scope']).toBe('hyperliquid_standard');

    const metricRows = await client.unsafe(
      `SELECT id, agent_id, candidates_discovered, candidates_scored, signals_generated, scan_health, top_confidence, scan_scope FROM agent_scan_metrics`,
    );
    expect(metricRows).toHaveLength(1);
    // id is generated by the repo (metrics input carries none).
    expect(typeof metricRows[0]!['id']).toBe('string');
    expect(metricRows[0]!['candidates_discovered']).toBe(10);
    expect(metricRows[0]!['scan_health']).toBe('healthy_signals');
    expect(Number(metricRows[0]!['top_confidence'])).toBeCloseTo(0.9);
    // scan_scope is jsonb on metrics.
    expect((metricRows[0]!['scan_scope'] as { discovered: number }).discovered).toBe(10);
  });

  it('empty candidate batch inserts nothing', async () => {
    await repo.insertCandidates([]);
    const rows = await client.unsafe(`SELECT id FROM agent_scan_candidates`);
    expect(rows).toHaveLength(0);
  });

  it('deletes scan rows older than the cutoff in batches, for both tables', async () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    // 5 old + 3 recent candidate rows for distinct agents so backdating is targetable.
    for (let i = 0; i < 5; i++) {
      await repo.insertCandidates([buildCandidate({ agentId: `old-${i}`, rawCandidateId: `R-${i}` })]);
      await setCandidateScannedAt(`old-${i}`, new Date(now - 10 * dayMs));
    }
    for (let i = 0; i < 3; i++) {
      await repo.insertCandidates([buildCandidate({ agentId: `new-${i}`, rawCandidateId: `R-${i}` })]);
      await setCandidateScannedAt(`new-${i}`, new Date(now - 60 * 60 * 1000));
    }

    // 4 old + 2 recent metrics rows.
    for (let i = 0; i < 4; i++) {
      await repo.insertMetrics(buildMetric({ agentId: `mold-${i}` }));
      await setMetricScannedAt(`mold-${i}`, new Date(now - 10 * dayMs));
    }
    for (let i = 0; i < 2; i++) {
      await repo.insertMetrics(buildMetric({ agentId: `mnew-${i}` }));
      await setMetricScannedAt(`mnew-${i}`, new Date(now - 60 * 60 * 1000));
    }

    const cutoff = new Date(now - dayMs); // 1 day ago → only the 10-day-old rows qualify

    // batchSize 2 forces multiple batches (5 old candidates → 2 + 2 + 1).
    const deletedCandidates = await repo.deleteCandidatesOlderThan(cutoff, 2);
    expect(deletedCandidates).toBe(5);
    const deletedMetrics = await repo.deleteMetricsOlderThan(cutoff, 2);
    expect(deletedMetrics).toBe(4);

    const remainingCandidates = await client.unsafe(`SELECT agent_id FROM agent_scan_candidates`);
    expect(remainingCandidates).toHaveLength(3);
    expect(remainingCandidates.every((r) => (r['agent_id'] as string).startsWith('new-'))).toBe(true);

    const remainingMetrics = await client.unsafe(`SELECT agent_id FROM agent_scan_metrics`);
    expect(remainingMetrics).toHaveLength(2);
    expect(remainingMetrics.every((r) => (r['agent_id'] as string).startsWith('mnew-'))).toBe(true);

    // Deleting again is a no-op (nothing older than the cutoff remains).
    expect(await repo.deleteCandidatesOlderThan(cutoff, 2)).toBe(0);
    expect(await repo.deleteMetricsOlderThan(cutoff, 2)).toBe(0);
  });
});
