// Trading-drive message-type constants (Phase 9b item D — AUTHORED).
//
// herobids carried a single coherent agent+trading enum, `AGENT_MESSAGE_TYPES`,
// in the platform `agent-protocol.ts` (deleted in Phase 1). Traderton's
// drive-path tools (`tools/trading.ts`, `tools/bots.ts`) reference exactly three
// of its members. Rather than request a herobids source-fix to carve a 3-member
// subset (a full release cycle for three strings — see 013 §6 / 020 §3.1), we
// author the 3-constant subset here.
//
// The three string VALUES are copied VERBATIM from herobids
// `packages/domain/src/agent-protocol.ts` so the wire vocabulary is identical —
// this mirrors the copy, it does not re-author it. `BOT_QUERY` exists only for
// vocabulary fidelity; no drive target routes it (locked decision, 013 §6.1).
export const AGENT_MESSAGE_TYPES = {
  DECISION_SUBMIT: 'agent.decision.submit',
  MANAGE_BOT: 'agent.manage_bot',
  BOT_QUERY: 'agent.bot.query',
} as const;
