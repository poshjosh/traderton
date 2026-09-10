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
  resolverTools,
  riskLimitsTools,
  schemaTools,
  tradingTools,
  watchTools,
  ToolRegistry,
  convertZodToJsonSchema,
} from './tools/index.js';
