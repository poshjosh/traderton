export {
  createTradingRuntime,
  type TradingRuntime,
  type TradingRuntimePorts,
} from './composition/create-trading-runtime.js';

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
