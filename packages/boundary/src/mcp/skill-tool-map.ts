// AUTHORED (Phase 4 T2) — the Traderton-owned map from a skills.sh skill ref to
// the Traderton tool names that skill exposes, plus the neutral `_meta` key the
// MCP `tools/list` carries so a consumer can tell which skill a tool belongs to.
//
// This is Traderton's single source of truth for the skill→tool association. It
// replaces the removed herobids-generated descriptor (ADR 017 §5, D26). The refs
// are the published skills in `github.com/traderton/skills` (D11); the tool names
// are exactly the Traderton worker tool-registry names.
//
// NON-GOAL (Traderton 005 non-goal 2): no consumer-specific skill semantics. The
// `_meta` key is deliberately neutral — it names neither herobids nor Traderton.

/**
 * The neutral `_meta` key under which each `tools/list` entry declares the skill
 * ref(s) it belongs to. Phase 4 ruling P4-1: the MCP Skills extension (SEP-2640,
 * `io.modelcontextprotocol/skills`) defines skill-resource `_meta` keys but NO
 * tool→skill linking key, so this uses the neutral Agent Skills vocabulary. The
 * value is an array of refs in `owner/repo/skill` form.
 */
export const SKILL_REFS_META_KEY = 'io.agentskills/skillRefs';

/**
 * Map from skills.sh skill ref (`owner/repo/skill`, D11) to the Traderton tool
 * names that skill exposes. The sets are the Phase 4 T0.7 tool-name parity table
 * (recorded 2026-10-04): every name here is a real Traderton worker-registry tool
 * name, so a consumer's visible set = (these names) ∩ (its own registry).
 *
 * `assess_strategy_preset` and `change_strategy_preset` are intentionally ABSENT
 * from `crypto-trading`: their executor lives in herobids, not Traderton (T0.7
 * case 4, large — NOT MOVED), so Traderton does not list them.
 */
export const SKILL_TOOL_MAP: Readonly<Record<string, readonly string[]>> = {
  'traderton/skills/crypto-trading': [
    'get_market_overview',
    'check_regime',
    'get_price',
    'get_funding_rates',
    'search_tokens',
    'discover_tokens',
    'get_risk_limits',
    'get_account_summary',
    'get_analytics',
    'list_positions',
    'watch_token',
    'list_watches',
    'remove_watch',
    'resolve_watch',
    'check_watches',
    'find_instrument',
    'submit_decision',
    'adjust_risk_limits',
  ],
  'traderton/skills/crypto-bot-management': [
    'create_bot',
    'stop_bot',
    'start_bot',
    'adjust_bot_config',
    'list_bots',
    'get_bot_status',
    'get_analytics',
    'list_positions',
    'resolve_bot',
  ],
  'traderton/skills/crypto-risk-monitoring': [
    'list_positions',
    'get_analytics',
    'get_price',
    'watch_token',
    'list_watches',
    'remove_watch',
    'resolve_watch',
    'check_watches',
    'get_risk_limits',
    'get_account_summary',
    'adjust_risk_limits',
  ],
};

/**
 * Invert {@link SKILL_TOOL_MAP} to a tool-name → sorted skill-refs map. A tool
 * that belongs to several skills (e.g. `get_analytics`, `list_positions`) carries
 * all of its refs. Tools not referenced by any skill are absent (no `_meta`).
 */
export function buildToolSkillRefs(
  skillToolMap: Readonly<Record<string, readonly string[]>> = SKILL_TOOL_MAP,
): ReadonlyMap<string, readonly string[]> {
  const byTool = new Map<string, string[]>();
  for (const [ref, toolNames] of Object.entries(skillToolMap)) {
    for (const toolName of toolNames) {
      const existing = byTool.get(toolName);
      if (existing) {
        if (!existing.includes(ref)) existing.push(ref);
      } else {
        byTool.set(toolName, [ref]);
      }
    }
  }
  for (const refs of byTool.values()) refs.sort();
  return byTool;
}
