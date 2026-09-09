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
