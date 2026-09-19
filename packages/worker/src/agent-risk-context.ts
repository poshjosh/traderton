// AUTHORED (A3) — the single RiskSource seam for the boundary's riskContractOps.
//
// COPY-NEVER-AUTHOR: the ops + risk-contract math are copied from the source
// runtime (herobids `apps/worker/src/agent.ts buildRiskContractOps()` +
// `agent-risk-limits.ts`, whose traderton twin already lives in
// `agent-risk-limits.ts`); only the SOURCE BINDING is authored here.
//
// A3 source = the consumer-injected payload spec (`capital`/`riskPosture`/
// `riskOverrides` — the same fields the consumer already threads on
// `submit_decision`). B1 swaps the RiskSource implementation for the profile
// store; the ops, math, tools, and tests survive unchanged.
//
// The `RiskSource` seam is the ACCEPTANCE CRITERION (A3 plan §DECISION): the ops
// read `{ capital, riskPosture, riskOverrides }` through ONE narrow interface —
// never ad-hoc payload fields.

import {
  validateRiskOverride,
  type AgentRiskDefaultsConfig,
  type AgentRiskOverrides,
  type ResolvedAgentRiskContract,
  resolveAgentRiskContract,
  type ResolvedAgentRiskProfile,
  type RiskPosture,
} from '@traderton/domain';
import { extractCeilings, extractCreatorInput, resolveProfile } from './agent-risk-limits.js';

/**
 * The single RiskSource seam — the ops read the invocation's risk context
 * through THIS interface and nothing else. A3 binds it to the per-call payload
 * spec; B1 reimplements it against the profile store (one-adapter swap).
 */
export interface RiskSource {
  capital: string | null;
  riskPosture: RiskPosture | null;
  riskOverrides: AgentRiskOverrides;
}

/**
 * True when the source carries NO risk context at all — the consumer sent no
 * spec on this invocation. The boundary then degrades (typed precondition on
 * `get_risk_limits`; `get_account_summary` keeps its graceful warnings shape).
 */
export function riskSourceIsEmpty(source: RiskSource): boolean {
  return source.capital == null && source.riskPosture == null
    && Object.keys(source.riskOverrides ?? {}).length === 0;
}

export interface BuildRiskContractOpsOptions {
  /** Operator risk defaults (ceilings + profile defaults) — traderton-owned config. */
  agentRiskDefaults: AgentRiskDefaultsConfig;
  /** The invocation's risk context, read through the single seam. */
  source: RiskSource;
  setRiskOverrides?: (overrides: AgentRiskOverrides) => Promise<void>;
}

/**
 * Build the source-agnostic `riskContractOps` over a `RiskSource`.
 *
 * Copied from herobids `buildRiskContractOps()` with the durable
 * `agentRepo.getRiskOverrides/setRiskOverrides` calls REMOVED — under A3 the
 * overrides live in the per-call spec, so `adjustOverrides` has no durable write
 * home (it fails closed; see the adjust_risk_limits tool) and `getProfile` is
 * served from the same seam.
 */
export function buildRiskContractOpsFromRiskSource(
  options: BuildRiskContractOpsOptions,
): NonNullable<import('@traderton/domain').TradingToolContext['riskContractOps']> {
  const { agentRiskDefaults, source } = options;
  const ceilings = extractCeilings(agentRiskDefaults);
  let overrides = source.riskOverrides ?? {};

  return {
    async getContract(): Promise<ResolvedAgentRiskContract> {
      const creatorInput = extractCreatorInput({
        capital: source.capital,
        riskPosture: source.riskPosture,
      });
      // resolveAgentRiskContract with hasCapital gating maxPositionSizePct
      // enforcement — identical to the source runtime's math.
      return resolveAgentRiskContract(creatorInput, ceilings, overrides, {
        hasCapital: source.capital != null,
      });
    },

    async adjustOverrides(proposedChanges: Record<string, number | null>): Promise<{ ok: boolean; error?: string; contract?: ResolvedAgentRiskContract }> {
      if (!options.setRiskOverrides) return { ok: false, error: 'risk override store unavailable' };
      const contract = await this.getContract();
      const next = { ...overrides };
      for (const [field, value] of Object.entries(proposedChanges)) {
        const error = validateRiskOverride(field as keyof ResolvedAgentRiskContract, contract, value);
        if (error) return { ok: false, error };
        if (value == null) delete next[field as keyof AgentRiskOverrides];
        else next[field as keyof AgentRiskOverrides] = value;
      }
      await options.setRiskOverrides(next);
      overrides = next;
      return { ok: true, contract: await this.getContract() };
    },

    async getProfile(): Promise<ResolvedAgentRiskProfile> {
      return resolveProfile(
        {
          capital: source.capital,
          riskPosture: source.riskPosture,
        },
        agentRiskDefaults,
        overrides,
      );
    },
  };
}

// validateRiskOverride is part of the copied ops' adjust path in the source
// runtime; kept referenced here so the contract stays import-complete once B1
// reactivates the write path.
export { validateRiskOverride };
