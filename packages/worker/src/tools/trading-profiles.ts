import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  AgentTradingProfileRepository,
  TradingProfileOperationConflictError,
  type Database,
  venueAccounts,
} from '@traderton/db';
import {
  ExecutionDefaultsSchema,
  RiskPostureSchema,
  type AgentRiskDefaultsConfig,
  type AgentTool,
  type ToolResult,
  type TradingToolContext,
} from '@traderton/domain';
import { convertZodToJsonSchema } from './registry.js';

const OperationSchema = z.object({ operationId: z.string().min(1) });
const ChangeOperationSchema = OperationSchema.extend({ actorId: z.string().min(1) });
const ProfileIdentitySchema = z.object({
  actorId: z.string().min(1),
  venueAccountId: z.string().min(1),
});
const ProfileConfigurationSchema = ProfileIdentitySchema.extend({
  capital: z.string().regex(/^\d+(\.\d+)?$/).nullable(),
  riskPosture: RiskPostureSchema.nullable(),
  executionDefaults: ExecutionDefaultsSchema.nullable(),
});
const ForwardSetActionSchema = z.object({
  actionId: z.string().min(1),
  kind: z.literal('set'),
  venueAccountId: z.string().min(1),
  capital: z.string().regex(/^\d+(\.\d+)?$/).nullable(),
  riskPosture: RiskPostureSchema.nullable(),
  executionDefaults: ExecutionDefaultsSchema.nullable(),
});
const ForwardClearActionSchema = z.object({
  actionId: z.string().min(1),
  kind: z.literal('clear'),
  venueAccountId: z.string().min(1),
  capital: z.null(),
  riskPosture: z.null(),
  executionDefaults: z.null(),
});
const ForwardActionSchema = z.discriminatedUnion('kind', [ForwardSetActionSchema, ForwardClearActionSchema]);
const ManifestSchema = z.object({ actions: z.array(ForwardActionSchema).min(1) });
const SetProfileSchema = ProfileConfigurationSchema.merge(OperationSchema).extend({
  actionId: z.string().min(1),
  actions: ManifestSchema.shape.actions.optional(),
});
const ExactProfileOperationSchema = ProfileIdentitySchema.merge(OperationSchema).extend({
  actionId: z.string().min(1),
  actions: ManifestSchema.shape.actions.optional(),
});

function unavailable(message: string, code: string): ToolResult {
  return { success: false, fault: true, error: message, errorCode: code };
}

/**
 * Ceiling fields enforced against operator risk defaults. `riskPosture` numeric
 * ranges are already constrained by `RiskPostureSchema` (0-100 etc.); these
 * ceilings are the ADDITIONAL operator authority layer — a creator may not push
 * a posture field above the operator's ceiling. Traderton is the sole authority
 * (herobids drops its local `validateAgentRiskBounds` pre-check).
 */
const RISK_CEILING_FIELDS = [
  'maxOpenPositions',
  'maxPositionSizePct',
  'stopLossPct',
  'stopLossCooldownMs',
  'maxDrawdownPct',
] as const;

type RiskCeilingField = (typeof RISK_CEILING_FIELDS)[number];

/**
 * Validate a creator `riskPosture` against operator ceilings. Mirrors herobids
 * `validateAgentRiskBounds` semantics: each non-null posture field that exceeds
 * the corresponding operator ceiling is a violation. Returns the first
 * violation; caller turns it into a typed `ToolResult`.
 */
function ceilingViolation(
  riskPosture: NonNullable<z.infer<typeof ProfileConfigurationSchema>['riskPosture']>,
  defaults: AgentRiskDefaultsConfig,
): { field: RiskCeilingField; ceiling: number } | undefined {
  for (const field of RISK_CEILING_FIELDS) {
    const value = riskPosture[field];
    if (value == null) continue;
    if (value > defaults[field]) return { field, ceiling: defaults[field] };
  }
  return undefined;
}

async function repositoryFor(ctx: TradingToolContext): Promise<AgentTradingProfileRepository | ToolResult> {
  if (!ctx.db) return unavailable('Database access not available in this context', 'profile.db_unavailable');
  if (!ctx.ownerId?.trim()) return unavailable('Owner identity not available in this context', 'profile.owner_unavailable');
  return new AgentTradingProfileRepository(ctx.db as Database);
}

async function authorizeIdentity(
  ctx: TradingToolContext,
  identity: z.infer<typeof ProfileIdentitySchema>,
): Promise<ToolResult | undefined> {
  if (identity.actorId !== ctx.agentId) {
    return { success: false, fault: false, error: 'Profile actor does not match signed agent subject', errorCode: 'authorization.denied' };
  }
  const db = ctx.db as Database;
  const [account] = await db.select({ id: venueAccounts.id }).from(venueAccounts).where(and(
    eq(venueAccounts.id, identity.venueAccountId),
    eq(venueAccounts.ownerId, ctx.ownerId!),
  )).limit(1);
  if (!account) {
    return { success: false, fault: false, error: 'Venue account not owned by signed owner', errorCode: 'authorization.denied' };
  }
  return undefined;
}

async function authorizeActions(
  ctx: TradingToolContext,
  actorId: string,
  actions: z.infer<typeof ForwardActionSchema>[],
): Promise<ToolResult | undefined> {
  for (const action of actions) {
    const denied = await authorizeIdentity(ctx, { actorId, venueAccountId: action.venueAccountId });
    if (denied) return denied;
  }
  return undefined;
}

function setActions(params: z.infer<typeof SetProfileSchema>): z.infer<typeof ForwardActionSchema>[] {
  const current = {
    actionId: params.actionId,
    kind: 'set' as const,
    venueAccountId: params.venueAccountId,
    capital: params.capital,
    riskPosture: params.riskPosture,
    executionDefaults: params.executionDefaults,
  };
  return validateCurrentAction(params.actions ?? [current], current);
}

function clearActions(params: z.infer<typeof ExactProfileOperationSchema>): z.infer<typeof ForwardActionSchema>[] {
  const current = {
    actionId: params.actionId,
    kind: 'clear' as const,
    venueAccountId: params.venueAccountId,
    capital: null,
    riskPosture: null,
    executionDefaults: null,
  };
  return validateCurrentAction(params.actions ?? [current], current);
}

function validateCurrentAction(
  actions: z.infer<typeof ForwardActionSchema>[],
  current: z.infer<typeof ForwardActionSchema>,
): z.infer<typeof ForwardActionSchema>[] {
  const matching = actions.find((action) => action.actionId === current.actionId);
  if (!matching || JSON.stringify(matching) !== JSON.stringify(current)) {
    throw new Error('The request action must be present and identical in the operation manifest');
  }
  return actions;
}

const setAgentTradingProfileTool: AgentTool<TradingToolContext> = {
  name: 'set_agent_trading_profile',
  ownerScopedNoVenue: true,
  category: 'write-database',
  description: 'Replace the complete Traderton-owned trading profile for the signed agent and one owned venue account.',
  parametersSchema: SetProfileSchema,
  parameters: convertZodToJsonSchema(SetProfileSchema),
  async execute(rawParams: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const params = SetProfileSchema.parse(rawParams);
    // Enforce operator ceilings on creator riskPosture BEFORE any DB write.
    // Fail closed: missing operator defaults = platform config gap (fault).
    const defaults = ctx.operatorRiskDefaults;
    if (!defaults) {
      return unavailable('Operator risk defaults not configured in this context', 'risk_defaults.unavailable');
    }
    if (params.riskPosture != null) {
      const violation = ceilingViolation(params.riskPosture, defaults);
      if (violation) {
        return {
          success: false,
          fault: false,
          error: `${violation.field} cannot exceed the operator ceiling of ${violation.ceiling}`,
          errorCode: 'validation.risk_ceiling',
        };
      }
    }
    const repo = await repositoryFor(ctx);
    if ('success' in repo) return repo;
    const actions = setActions(params);
    const denied = await authorizeActions(ctx, params.actorId, actions);
    if (denied) return denied;
    try {
      const revisions = await repo.applyOperation({ ownerId: ctx.ownerId!, actorId: params.actorId, operationId: params.operationId, actions });
      return { success: true, data: { operationId: params.operationId, revision: revisions.get(params.actionId)?.toString() ?? null } };
    } catch (error) {
      if (error instanceof TradingProfileOperationConflictError) return unavailable(error.message, 'profile.operation_conflict');
      throw error;
    }
  },
};

const clearAgentTradingProfileTool: AgentTool<TradingToolContext> = {
  name: 'clear_agent_trading_profile',
  ownerScopedNoVenue: true,
  category: 'write-database',
  description: 'Clear the exact signed-agent trading profile for one owned venue account.',
  parametersSchema: ExactProfileOperationSchema,
  parameters: convertZodToJsonSchema(ExactProfileOperationSchema),
  async execute(rawParams: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const params = ExactProfileOperationSchema.parse(rawParams);
    const repo = await repositoryFor(ctx);
    if ('success' in repo) return repo;
    const actions = clearActions(params);
    const denied = await authorizeActions(ctx, params.actorId, actions);
    if (denied) return denied;
    try {
      const revisions = await repo.applyOperation({ ownerId: ctx.ownerId!, actorId: params.actorId, operationId: params.operationId, actions });
      return { success: true, data: { operationId: params.operationId, revision: revisions.get(params.actionId)?.toString() ?? null } };
    } catch (error) {
      if (error instanceof TradingProfileOperationConflictError) return unavailable(error.message, 'profile.operation_conflict');
      throw error;
    }
  },
};

const getAgentTradingProfileTool: AgentTool<TradingToolContext> = {
  name: 'get_agent_trading_profile',
  ownerScopedNoVenue: true,
  category: 'read-database',
  description: 'Read the exact signed-agent trading profile for one owned venue account.',
  parametersSchema: ProfileIdentitySchema,
  parameters: convertZodToJsonSchema(ProfileIdentitySchema),
  async execute(rawParams: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const params = ProfileIdentitySchema.parse(rawParams);
    const repo = await repositoryFor(ctx);
    if ('success' in repo) return repo;
    const denied = await authorizeIdentity(ctx, params);
    if (denied) return denied;
    const profile = await repo.getByOwnerActorVenueAccount(ctx.ownerId!, params.actorId, params.venueAccountId);
    if (!profile) return { success: false, fault: false, error: 'Trading profile not found', errorCode: 'not_found.resource' };
    return { success: true, data: { ...profile, revision: profile.revision.toString() } };
  },
};

function changeTool(name: 'finalize_agent_trading_profile_change' | 'rollback_agent_trading_profile_change' | 'resume_agent_trading_profile_change'): AgentTool<TradingToolContext> {
  return {
    name,
    ownerScopedNoVenue: true,
    category: 'write-database',
    description: `${name.startsWith('finalize') ? 'Finalize' : name.startsWith('rollback') ? 'Roll back' : 'Resume'} a durable Traderton trading-profile change.`,
    parametersSchema: ChangeOperationSchema,
    parameters: convertZodToJsonSchema(ChangeOperationSchema),
    async execute(rawParams: unknown, ctx: TradingToolContext): Promise<ToolResult> {
      const { operationId, actorId } = ChangeOperationSchema.parse(rawParams);
      const repo = await repositoryFor(ctx);
      if ('success' in repo) return repo;
      if (actorId !== ctx.agentId) {
        return { success: false, fault: false, error: 'Profile actor does not match signed agent subject', errorCode: 'authorization.denied' };
      }
      if (name.startsWith('finalize')) await repo.finalizeChange(ctx.ownerId!, actorId, operationId);
      else if (name.startsWith('rollback')) await repo.rollbackChange(ctx.ownerId!, actorId, operationId);
      else await repo.resumeOperation(ctx.ownerId!, actorId, operationId);
      return { success: true, data: { operationId } };
    },
  };
}

const getOperatorDefaultsTool: AgentTool<TradingToolContext> = {
  name: 'get_operator_defaults',
  ownerScopedNoVenue: true,
  category: 'read-config',
  description: 'Read the operator-configured risk defaults (17-field agentRiskDefaults block). Traderton is the sole authority for these defaults; creator risk posture writes are ceiling-enforced against them.',
  parametersSchema: z.object({}),
  parameters: convertZodToJsonSchema(z.object({})),
  async execute(_rawParams: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    if (!ctx.operatorRiskDefaults) {
      return unavailable('Operator risk defaults not configured in this context', 'risk_defaults.unavailable');
    }
    return { success: true, data: ctx.operatorRiskDefaults };
  },
};

export const tradingProfileTools: AgentTool<TradingToolContext>[] = [
  getOperatorDefaultsTool,
  setAgentTradingProfileTool,
  clearAgentTradingProfileTool,
  getAgentTradingProfileTool,
  changeTool('finalize_agent_trading_profile_change'),
  changeTool('rollback_agent_trading_profile_change'),
  changeTool('resume_agent_trading_profile_change'),
];