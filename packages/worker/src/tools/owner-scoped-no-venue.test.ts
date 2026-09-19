// AUTHORED (L3-Rx) — pins the `ownerScopedNoVenue` flag across the tool catalog.
//
// The boundary subject-resolver skips venue resolution for read-only tools OR
// tools that declare `ownerScopedNoVenue: true` (owner-scoped writes that drive
// no executor). This test is the guard that (a) the non-drive side-effecting
// tools carry the flag, and (b) the drive-path tools do NOT — so a future tool
// cannot silently land in the wrong bucket.

import { describe, it, expect } from 'vitest';
import type { AgentTool, TradingToolContext } from '@traderton/domain';
import { provisioningTools } from './provisioning.js';
import { riskLimitsTools } from './risk-limits.js';
import { tradingProfileTools } from './trading-profiles.js';
import { watchTools } from './watch.js';
import { botManagementTools } from './bots.js';
import { tradingTools } from './trading.js';

function byName(tools: AgentTool<TradingToolContext>[], name: string): AgentTool<TradingToolContext> {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

describe('ownerScopedNoVenue flag', () => {
  // Owner-scoped writes that drive NO executor → must skip venue resolution.
  const flagged: Array<[AgentTool<TradingToolContext>[], string]> = [
    [provisioningTools, 'provision_venue_account'],
    [provisioningTools, 'deprovision_venue_account'],
    [tradingProfileTools, 'set_agent_trading_profile'],
    [tradingProfileTools, 'clear_agent_trading_profile'],
    [tradingProfileTools, 'get_agent_trading_profile'],
    [tradingProfileTools, 'finalize_agent_trading_profile_change'],
    [tradingProfileTools, 'rollback_agent_trading_profile_change'],
    [tradingProfileTools, 'resume_agent_trading_profile_change'],
    [riskLimitsTools, 'adjust_risk_limits'],
    [watchTools, 'watch_token'],
    [watchTools, 'remove_watch'],
    [watchTools, 'check_watches'],
    // delete_bot is an owner-scoped write that drives no executor (deletes the row
    // directly via botRepo) — it skips venue resolution like deprovision (Wave A1).
    [botManagementTools, 'delete_bot'],
    // instantiate_bot is an owner-scoped write that drives no executor (inserts a
    // stopped bot directly via botRepo; venue/venueType come from the payload
    // config) — it skips venue resolution like delete_bot (c4.9d-FG).
    [botManagementTools, 'instantiate_bot'],
  ];

  for (const [tools, name] of flagged) {
    it(`${name} declares ownerScopedNoVenue: true`, () => {
      expect(byName(tools, name).ownerScopedNoVenue).toBe(true);
    });
  }

  // Drive-path tools (use ctx.publishToInbound) → must NOT skip venue resolution.
  const driveTools: Array<[AgentTool<TradingToolContext>[], string]> = [
    [tradingTools, 'submit_decision'],
    [botManagementTools, 'create_bot'],
    [botManagementTools, 'start_bot'],
    [botManagementTools, 'stop_bot'],
    [botManagementTools, 'adjust_bot_config'],
  ];

  for (const [tools, name] of driveTools) {
    it(`${name} does NOT set ownerScopedNoVenue (needs venue resolution)`, () => {
      expect(byName(tools, name).ownerScopedNoVenue ?? false).toBe(false);
    });
  }
});
