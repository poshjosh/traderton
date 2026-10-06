import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  AgentTradingProfileRepository,
  TradingProfileOperationConflictError,
  type Database,
  venueAccounts,
} from '@traderton/db';
import {
  CreatorStrategySchema,
  ExecutionDefaultsSchema,
  RiskPostureSchema,
  ScanModeSchema,
  StrictTechnicalConfigSchema,
  SWAP_VENUES,
  StrategyResolutionError,
  TechnicalConfigSchema,
  TokenSafetyConfigSchema,
  resolveActiveStrategy,
  type AgentRiskDefaultsConfig,
  type AgentTool,
  type CreatorStrategy,
  type ScanMode,
  type SupportedTokenSafetyNetwork,
  type TechnicalConfig,
  type ToolResult,
  type TradingToolContext,
} from '@traderton/domain';
import { resolveSwapNetwork } from '../resolve-swap-assets.js';
import { validateSwapScannerConfig } from '../swap-startup-validation.js';
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
  // Creator inputs (004 ownership rule). Absent = unchanged; explicit null = clear.
  scanMode: ScanModeSchema.nullable().optional(),
  creatorStrategy: CreatorStrategySchema.nullable().optional(),
});
const ForwardClearActionSchema = z.object({
  actionId: z.string().min(1),
  kind: z.literal('clear'),
  venueAccountId: z.string().min(1),
  capital: z.null(),
  riskPosture: z.null(),
  executionDefaults: z.null(),
  scanMode: z.null().default(null),
  creatorStrategy: z.null().default(null),
});
const ForwardActionSchema = z.discriminatedUnion('kind', [ForwardSetActionSchema, ForwardClearActionSchema]);
const ManifestSchema = z.object({ actions: z.array(ForwardActionSchema).min(1) });
const SetProfileSchema = ProfileConfigurationSchema.merge(OperationSchema).extend({
  actionId: z.string().min(1),
  // Optional creator inputs; absent = unchanged (old callers keep working).
  scanMode: ScanModeSchema.nullish().describe(
    "The creator-chosen scan mode: 'scanner_gated' or 'mixed', or null for no scan loop.",
  ),
  creatorStrategy: CreatorStrategySchema.nullish().describe(
    'The creator-chosen strategy: exactly one of { presetKey, styleTier } or { customTechnical }.',
  ),
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

function venueTypeFor(venue: string): 'orderbook' | 'swap' {
  return (SWAP_VENUES as readonly string[]).includes(venue) ? 'swap' : 'orderbook';
}

function scanValidationError(message: string, errorCode: string): ToolResult {
  return { success: false, fault: false, error: message, errorCode };
}

/**
 * Read the operator canonical-token map from the resolved market-data config,
 * if present. Returns undefined when absent — `validateSwapScannerConfig` then
 * fails closed with a `swap.no_canonical_tokens` error.
 */
function canonicalTokensFrom(
  marketDataConfig: Record<string, unknown> | undefined,
): Partial<Record<SupportedTokenSafetyNetwork, Record<string, { address: string; name: string; aliases: string[] }>>> | undefined {
  const tokenSafety = (marketDataConfig as { tokenSafety?: unknown } | undefined)?.tokenSafety;
  if (tokenSafety == null) return undefined;
  const parsed = TokenSafetyConfigSchema.safeParse(tokenSafety);
  return parsed.success ? parsed.data.canonicalTokens : undefined;
}

/**
 * Validate the scan configuration at the boundary, applied to the RESOLVED
 * technical config (004 ownership rule + source parse rules). Runs BEFORE any
 * DB write. Returns a typed `validation.*`/`swap.*` ToolResult on failure, or
 * undefined on success.
 *
 * - `scanner_gated`: reject when no strategy is given (neither a new
 *   `creatorStrategy` nor a stored `activeStrategy`); otherwise parse the
 *   resolved technical config strictly then leniently; a swap venue additionally
 *   runs `validateSwapScannerConfig` against the binding network resolved the
 *   same way the runtime scan wiring resolves it (`resolveSwapNetwork` with the
 *   operator 1inch config — see `wireScanDeps` in composition/decision-intake.ts).
 *   `filters.networks` is a creator scan filter, NOT the network source.
 * - `mixed`: lenient parse only.
 * - absent `scanMode` with no scan loop: nothing to validate.
 */
function validateScanConfiguration(params: {
  scanMode: ScanMode | null;
  creatorStrategy: CreatorStrategy | null;
  existingActive: TechnicalConfig | null;
  venue: string;
  marketDataConfig: Record<string, unknown> | undefined;
  oneInchConfig: { tokenSafetyNetwork?: string; chainId?: number } | undefined;
}): ToolResult | undefined {
  const { scanMode, creatorStrategy, existingActive, venue } = params;
  if (scanMode == null) return undefined;

  const venueType = venueTypeFor(venue);

  // Resolve the technical config the actor would run: a fresh creator input
  // resolves now; otherwise fall back to the stored active config.
  let resolved: TechnicalConfig | null = existingActive;
  if (creatorStrategy != null) {
    try {
      resolved = resolveActiveStrategy(creatorStrategy, { venue, venueType }, new Date().toISOString()).technical;
    } catch (error) {
      if (error instanceof StrategyResolutionError) return scanValidationError(error.message, error.code);
      throw error;
    }
  }

  if (scanMode === 'mixed') {
    if (resolved == null) return undefined; // mixed mode may run without a technical config
    const lenient = TechnicalConfigSchema.safeParse(resolved);
    if (!lenient.success) {
      return scanValidationError(lenient.error.issues[0]?.message ?? 'Invalid technical config', 'validation.technical_config');
    }
    return undefined;
  }

  // scanner_gated
  if (resolved == null) {
    return scanValidationError(
      'A scanner-gated profile requires a creator strategy (preset or custom technical config).',
      'validation.strategy_required',
    );
  }
  const strict = StrictTechnicalConfigSchema.safeParse(resolved);
  if (!strict.success) {
    return scanValidationError(strict.error.issues[0]?.message ?? 'Incomplete technical config', 'validation.technical_config');
  }
  const lenient = TechnicalConfigSchema.safeParse(resolved);
  if (!lenient.success) {
    return scanValidationError(lenient.error.issues[0]?.message ?? 'Invalid technical config', 'validation.technical_config');
  }
  if (venueType === 'swap') {
    // Binding network comes from the venue + operator config (Jupiter → solana;
    // 1inch → venues.1inch tokenSafetyNetwork/chainId), matching the runtime.
    // validateSwapScannerConfig then checks filters.networks does not exclude it.
    const network = resolveSwapNetwork(venue, undefined, params.oneInchConfig);
    const swap = validateSwapScannerConfig(network, venue, lenient.data, canonicalTokensFrom(params.marketDataConfig));
    if (!swap.ok) return scanValidationError(swap.error.message, swap.error.code);
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
  // Absent (undefined) scan fields mean "unchanged" and are OMITTED from the
  // action object so JSON.stringify matches a manifest entry that also omitted
  // them (validateCurrentAction). An explicit null means "clear".
  const current: z.infer<typeof ForwardSetActionSchema> = {
    actionId: params.actionId,
    kind: 'set' as const,
    venueAccountId: params.venueAccountId,
    capital: params.capital,
    riskPosture: params.riskPosture,
    executionDefaults: params.executionDefaults,
    ...(params.scanMode === undefined ? {} : { scanMode: params.scanMode }),
    ...(params.creatorStrategy === undefined ? {} : { creatorStrategy: params.creatorStrategy }),
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
    scanMode: null,
    creatorStrategy: null,
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

    // Scan-config boundary validation on the RESOLVED technical config, applied
    // per set action BEFORE any DB write. The resolved config and the repo's
    // active_strategy derivation share `resolveActiveStrategy`, so a config
    // accepted here is the one the actor runs.
    const db = ctx.db as Database;
    for (const action of actions) {
      if (action.kind !== 'set') continue;
      // Resolve the EFFECTIVE scan config with the same absent=unchanged /
      // null=clear rule the repository applies, so validation matches what will
      // be persisted. Skip validation entirely when the effective scanMode is
      // non-set (no scan loop to validate).
      const existing = await repo.getByOwnerActorVenueAccount(ctx.ownerId!, params.actorId, action.venueAccountId);
      const effectiveScanMode = action.scanMode === undefined ? (existing?.scanMode ?? null) : action.scanMode;
      if (effectiveScanMode == null) continue;
      const [venueAccount] = await db.select({ venue: venueAccounts.venue }).from(venueAccounts).where(and(
        eq(venueAccounts.id, action.venueAccountId),
        eq(venueAccounts.ownerId, ctx.ownerId!),
      )).limit(1);
      if (!venueAccount) {
        return { success: false, fault: false, error: 'Venue account not owned by signed owner', errorCode: 'authorization.denied' };
      }
      const effectiveCreatorStrategy = action.creatorStrategy === undefined
        ? (existing?.creatorStrategy ?? null)
        : action.creatorStrategy;
      // An explicit null creatorStrategy clears the strategy, so the stored
      // active config no longer backs the scan loop: pass existingActive = null.
      const existingActive = action.creatorStrategy === null
        ? null
        : existing?.activeStrategy?.technical ?? null;
      const invalid = validateScanConfiguration({
        scanMode: effectiveScanMode,
        creatorStrategy: effectiveCreatorStrategy,
        existingActive,
        venue: venueAccount.venue,
        marketDataConfig: ctx.marketDataConfig,
        oneInchConfig: ctx.oneInchPriceChainConfig,
      });
      if (invalid) return invalid;
    }

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