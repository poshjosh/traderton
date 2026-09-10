import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Database = ReturnType<typeof createDatabase>;

interface ClosableDatabaseClient {
  end(options?: { timeout?: number }): Promise<void>;
}

export function createDatabase(connectionString: string) {
  const client = postgres(connectionString);
  return drizzle(client, { schema });
}

export async function closeDatabase(db: Database): Promise<void> {
  await (db as Database & { $client: ClosableDatabaseClient }).$client.end();
}

export * from './schema/index.js';
export { PgJournal } from './journal-pg.js';
export { FillRepository, PositionRepository, ExecutionPlanRepository, OrderRepository, BalanceSnapshotRepository, DecisionRepository, BotRepository } from './repositories.js';
export type { InsertFill, UpsertPosition, InsertExecutionPlan, UpsertOrder, InsertBalanceSnapshot, InsertDecision } from './repositories.js';
export { ReconciliationEventRepository } from './reconciliation-repository.js';
export type { InsertReconciliationEvent, ReconciliationEventQuery } from './reconciliation-repository.js';
export { BacktestingRepository } from './backtesting-repository.js';
export type { InsertDecisionContext, InsertCorpus, InsertMarketEvent } from './backtesting-repository.js';
export { LlmArtifactRepository } from './llm-artifact-repository.js';
export type { InsertLlmArtifact, LlmArtifactSource } from './llm-artifact-repository.js';
export { InstrumentRepository } from './instrument-repository.js';
export type { InstrumentSearchParams, InstrumentRow, UpsertInstrumentRow } from './instrument-repository.js';
export { TokenSafetyOverrideRepository } from './token-safety-override-repository.js';
export type { IssueOverrideParams, TokenSafetyOverrideRow } from './token-safety-override-repository.js';
export { DecisionFailureRepository } from './decision-failure-repository.js';
export type { InsertDecisionFailure, DecisionFailureQuery } from './decision-failure-repository.js';
export { BoundaryInvocationRepository, computeRequestFingerprint } from './boundary-invocation-repository.js';
export type { BeginOrResolveParams, BeginResult, CompleteParams, BoundaryInvocationRow } from './boundary-invocation-repository.js';
// decision-approval-repository / decision_approvals table removed 2026-09-07:
// user-approval lifecycle is a platform/consumer-owned concern, not trading
// (Intentional Divergence — see docs/001 + docs/004). Agents own asking for a
// human approval; on approval they call Traderton's submit_decision. No trading
// code imported the repo.
