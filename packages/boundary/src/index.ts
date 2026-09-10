// @traderton/boundary — the M2 REST consumer boundary (005), F1 shell:
// Fastify app + HMAC auth + envelope/version validation + tools:invoke
// dispatcher over ToolRegistry + health, scoped to read-only tools.

export { createBoundaryApp, type BoundaryAppDeps } from './app.js';
export {
  ToolInvocationDispatcher,
  type DispatcherDeps,
  type DispatchSubject,
  type TradingToolContextFactory,
} from './dispatcher.js';
export {
  authenticateRequest,
  buildCanonicalString,
  type SignedRequest,
  type VerifiedCaller,
} from './auth.js';
export {
  BoundaryConfigSchema,
  AllowedConsumerSchema,
  DEFAULT_CLOCK_SKEW_MS,
  type BoundaryConfig,
  type AllowedConsumer,
} from './config.js';
export {
  CONTRACT_VERSION,
  BOUNDARY_FAILURE_CODES,
  TradertonToolInvocationV1Schema,
  type TradertonToolInvocationV1,
  type TradertonToolResultV1,
  type TradertonBoundaryFailureCode,
} from './contract.js';
export {
  successResult,
  failureResult,
  BoundaryFailure,
  type ResultIdentity,
} from './result.js';
