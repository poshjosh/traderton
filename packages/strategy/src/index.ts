export { scoreCandidate, scanCandidates } from './scan-engine.js';
export type { CandidateContext, ScoredSignal, ScanConfig, IndicatorConfig } from './scan-engine.js';
// Re-export shared identity types from @traderton/domain so consumers that
// previously imported ScannerCandleTarget from @traderton/strategy aren't broken.
export type { ScannerCandleTarget, SwapExecutionIdentity } from '@traderton/domain';
export { MechanicalStrategy } from './mechanical-strategy.js';
export { DcaStrategy, DcaParamsSchema } from './dca-strategy.js';
export type { DcaParams } from './dca-strategy.js';
