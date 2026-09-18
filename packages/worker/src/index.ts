export {
  createTradingRuntime,
  type TradingRuntime,
  type TradingRuntimePorts,
  type DriveTargetInjection,
} from './composition/create-trading-runtime.js';

export {
  createDriveTarget,
  handleManageBot,
  type PublishToInbound,
  type DriveTargetDeps,
  type DriveBotRepo,
  type DriveBotRecord,
  type BotLimitSeam,
  type DriveReplyRedis,
} from './composition/drive-target.js';

export {
  submitDecision,
  constructAndRegisterAgentActor,
  stopAndDeregisterAgentActor,
  type DecisionSubmitInput,
  type DecisionSubmitResult,
  type AgentActorSpec,
  type AgentActorRuntimeDeps,
  type ActorRegistryHooks,
} from './composition/decision-intake.js';

export type { ExecutionActor, IntakeResult, IntakeRejection, IntakeRejectionCode } from './execution-actor.js';

// The operator-config loader — re-exported so the M2 REST boundary
// (@traderton/boundary, Phase 9b item F2b) can load the same `AppConfig` its
// `createTradingRuntime(ports)` requires. No behaviour is authored by this
// re-export; it only widens the package's public surface.
export { loadConfig } from './config.js';

// The venue-aware scanner candle fetcher (orderbook→Binance, swap→GeckoTerminal).
// Exported so the boundary composition root can surface it onto the read-tool
// context (score_candidate fetches candles behind the boundary — legal-isolation).
export { createScannerCandleFetcher, createScannerCandleFetcherFromConfig, createScannerPoolResolverFromConfig } from './scanner-candle-fetcher.js';

// Credential encryption seam — re-exported so the M2 REST boundary
// (@traderton/boundary) can verify credential custody (encrypt-at-rest) in its
// L3-P1 provision_venue_account tests. No behaviour authored by the re-export.
export { encryptCredential, decryptCredential, getEncryptionKey } from './crypto.js';

// Structured logger factory — re-exported so the M2 REST boundary can log
// internally with the SAME pino factory the worker uses (pretty/JSON by
// LOG_FORMAT). No behaviour authored by the re-export.
export { createLogger } from './logger.js';

// Tool surface — the copied trading tools + the ToolRegistry dispatch target.
// Re-exported so the M2 REST boundary (@traderton/boundary, Phase 9b item F) can
// assemble a registry and dispatch to the copied tools. No behaviour is authored
// by this re-export; it only widens the package's public surface.
export {
  accountTools,
  analyticsTools,
  botManagementTools,
  instrumentTools,
  marketDataTools,
  priceTools,
  provisioningTools,
  resolverTools,
  riskLimitsTools,
  schemaTools,
  strategyTools,
  tradingTools,
  watchTools,
  ToolRegistry,
  convertZodToJsonSchema,
} from './tools/index.js';
