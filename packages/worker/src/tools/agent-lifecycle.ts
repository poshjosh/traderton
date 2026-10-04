import { z } from 'zod';
import type { AgentTool, ToolResult, TradingToolContext } from '@traderton/domain';
import { convertZodToJsonSchema } from './registry.js';

// --- Agent-actor lifecycle tools (Wave E / E1-T T5) ─────────────────────────
//
// CONSUMER-ONLY (RESOLVED human ruling, 2026-10-04): `start_agent_actor` and
// `stop_agent_actor` are called by the consumer's session manager (herobids'
// onSessionActive / onSessionStopped / onAgentCrashed), NOT by an agent. They are
// registered in the boundary tool registry (so the consumer can invoke them) but
// are deliberately ABSENT from every `SKILL_TOOL_MAP` skill set, so they never
// appear in any agent-facing `tools/list` (the same mechanism that keeps
// scan_consumer_notifications / scan_trade_events consumer-only). They carry no
// `get_schema` entry for the same reason — surfacing a schema would advertise them.
//
// Both are agent-subject, owner-scoped, actor = the agent itself (ctx.agentId /
// ctx.ownerId). The real effects — upserting run state, stopping+deregistering
// the actor, evicting the ensure cache, and cascading the agent's bots — live
// behind the boundary-built `ctx.agentActorLifecycle` port (ports-carry-values),
// which closes over the request's resolved venue coordinates + the runtime +
// the ensure + the repos. The tools stay thin: guard the port, call it, map the
// result. Idempotency is natural (upsert running / stop-stays-stopped), so these
// `write-database` tools declare no per-tool dedup — the boundary's 005
// `boundary_invocations` layer handles retry dedup transparently.

// --- start_agent_actor ---

const StartAgentActorParamsSchema = z.object({});

const startAgentActorTool: AgentTool<TradingToolContext> = {
  name: 'start_agent_actor',
  // Venue-resolving (NOT ownerScopedNoVenue): the boundary context factory's
  // ensure constructs + STARTS the actor BEFORE this tool runs, exactly like
  // submit_decision. This tool then records the durable run-state intent with the
  // resolved coordinates the ensure used.
  description:
    'Record that an agent actor should be running and start it. Consumer-only — called by the session manager when a session activates. The actor is constructed and started by the boundary before this persists the running intent.',
  parametersSchema: StartAgentActorParamsSchema,
  parameters: convertZodToJsonSchema(StartAgentActorParamsSchema),
  category: 'write-database',
  async execute(_params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    if (!ctx.agentActorLifecycle) {
      return { success: false, error: 'agent-actor lifecycle not available in this context', fault: false };
    }

    // Idempotent: repeated calls upsert the same running row; the actor is already
    // ensured (constructed + started) by the boundary before we get here.
    await ctx.agentActorLifecycle.recordRunning();

    return {
      success: true,
      data: { ok: true, actorId: ctx.agentId, desiredState: 'running' },
    };
  },
};

// --- stop_agent_actor ---

const StopAgentActorParamsSchema = z.object({});

const stopAgentActorTool: AgentTool<TradingToolContext> = {
  name: 'stop_agent_actor',
  // Owner-scoped write that drives no executor (it stops one). No venue
  // resolution needed — the actor to stop is resolved from the registry by
  // ctx.agentId, and the run row is keyed on (ownerId, actorId). Marking it
  // ownerScopedNoVenue avoids a spurious precondition.not_ready when the agent
  // has no resolvable default venue account at stop time.
  ownerScopedNoVenue: true,
  description:
    'Stop an agent actor, mark it stopped, and cascade-stop the agent\'s running bots. Consumer-only — called by the session manager when a session stops, an agent crashes, or an agent is deleted. Returns the ids of the bots that were stopped.',
  parametersSchema: StopAgentActorParamsSchema,
  parameters: convertZodToJsonSchema(StopAgentActorParamsSchema),
  category: 'write-database',
  async execute(_params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    if (!ctx.agentActorLifecycle) {
      return { success: false, error: 'agent-actor lifecycle not available in this context', fault: false };
    }

    // Idempotent: marks stopped (stays stopped on repeat), stops + deregisters the
    // actor, evicts the ensure cache, and cascade-stops the agent's running bots
    // (best-effort per bot). A stopped agent/bot stays stopped on a repeat call.
    const { stoppedBots } = await ctx.agentActorLifecycle.stop();

    return {
      success: true,
      data: { ok: true, actorId: ctx.agentId, stoppedBots },
    };
  },
};

export const agentLifecycleTools: AgentTool[] = [
  startAgentActorTool,
  stopAgentActorTool,
];
