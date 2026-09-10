// @traderton/boundary — the M2 REST consumer boundary (005), F1 shell:
// Fastify app + HMAC auth + envelope/version validation + tools:invoke
// dispatcher over ToolRegistry + health, scoped to read-only tools.

export { createBoundaryApp, type BoundaryAppDeps } from './app.js';
export {
  ToolInvocationDispatcher,
  type DispatcherDeps,
  type DispatchSubject,
  type ContextFactoryRequest,
  type TradingToolContextFactory,
  type BoundaryInvocationStore,
  type ComputeRequestFingerprint,
} from './dispatcher.js';
export {
  resolveSubjectInjection,
  type SubjectResolution,
  type ResolvedInjection,
  type ResolverBotRecord,
  type ResolverVenueAccountRecord,
  type SubjectResolverPorts,
  type ResolverSubject,
} from './subject-resolver.js';
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
  DEFAULT_IDEMPOTENCY_RETENTION_HOURS,
  ACTOR_TYPES,
  type BoundaryConfig,
  type AllowedConsumer,
} from './config.js';
export {
  CONTRACT_VERSION,
  BOUNDARY_FAILURE_CODES,
  TradertonToolInvocationV1Schema,
  type TradertonToolInvocationV1,
  type TradertonToolResultV1,
  type TradertonToolInvocationStatusV1,
  type TradertonInvokeResponseV1,
  type TradertonBoundaryFailureCode,
} from './contract.js';
export {
  successResult,
  failureResult,
  inProgressStatus,
  terminalStatus,
  BoundaryFailure,
  type ResultIdentity,
} from './result.js';
export {
  signRequest,
  signInvoke,
  signStatus,
  type SigningIdentity,
  type SignRequestInput,
  type SignedHeaders,
} from './dev/sign.js';
