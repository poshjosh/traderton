/** Persisted runtime risk overrides — only fields the agent has actively changed (C1.6). */
import { z } from 'zod';

export const AgentRiskOverridesSchema = z.object({
  maxOpenPositions: z.number().min(1).optional(),
  maxPositionSizePct: z.number().min(0).max(100).optional(),
  stopLossPct: z.number().min(0).max(100).optional(),
  stopLossCooldownMs: z.number().min(0).optional(),
  maxDrawdownPct: z.number().min(0).max(100).optional(),
}).strict();
export type AgentRiskOverrides = z.infer<typeof AgentRiskOverridesSchema>;