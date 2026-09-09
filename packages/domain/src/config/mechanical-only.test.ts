import { describe, expect, it } from 'vitest';
import { BotConfigSchema, MechanicalStrategySchema } from './schema.js';

// AUTHORED (Phase 9b, item A′ / S-1) — NOT a copied parity test.
//
// This test pins Traderton's mechanical-only bot guarantee at the config boundary
// it owns (decisions 7–9; S-1 option (a), narrow-and-diverge). Traderton bots are
// mechanical-only: the `llm` / `hybrid` decision modes relocate agent-side. The
// copied `StrategySchema` still accepts them (herobids' broad schema, kept verbatim
// — see schema.test.ts); the narrowing lives on `MechanicalStrategySchema`, which
// `BotConfigSchema.strategy` validates against. These assertions make the guarantee
// explicit and regression-proof rather than an emergent property of downstream
// registry rejection. See docs/004-decision-log.md ("Where mechanical-only is …
// enforced") + docs/features/013-9b-authoring-plan.md item A′.

describe('mechanical-only bot boundary (S-1)', () => {
  const validBase = {
    symbol: 'SOL/USDC',
  };

  describe('MechanicalStrategySchema', () => {
    it('accepts mechanical decisionMode', () => {
      const result = MechanicalStrategySchema.safeParse({ type: 'momentum', decisionMode: 'mechanical' });
      expect(result.success).toBe(true);
    });

    it('accepts dca without decisionMode (timer-driven)', () => {
      const result = MechanicalStrategySchema.safeParse({ type: 'dca' });
      expect(result.success).toBe(true);
    });

    it('rejects llm decisionMode', () => {
      const result = MechanicalStrategySchema.safeParse({ type: 'momentum', decisionMode: 'llm' });
      expect(result.success).toBe(false);
    });

    it('rejects hybrid decisionMode', () => {
      const result = MechanicalStrategySchema.safeParse({ type: 'momentum', decisionMode: 'hybrid' });
      expect(result.success).toBe(false);
    });

    it('still requires decisionMode for non-DCA strategies', () => {
      const result = MechanicalStrategySchema.safeParse({ type: 'momentum' });
      expect(result.success).toBe(false);
    });
  });

  describe('BotConfigSchema (the bot-creation boundary)', () => {
    it('accepts a mechanical bot config', () => {
      const result = BotConfigSchema.safeParse({
        ...validBase,
        strategy: { type: 'momentum', decisionMode: 'mechanical' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts a dca bot config', () => {
      const result = BotConfigSchema.safeParse({
        ...validBase,
        strategy: { type: 'dca' },
      });
      expect(result.success).toBe(true);
    });

    it('rejects an llm bot config (mechanical-only)', () => {
      const result = BotConfigSchema.safeParse({
        ...validBase,
        strategy: { type: 'momentum', decisionMode: 'llm' },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes('decisionMode'))).toBe(true);
      }
    });

    it('rejects a hybrid bot config (mechanical-only)', () => {
      const result = BotConfigSchema.safeParse({
        ...validBase,
        strategy: { type: 'momentum', decisionMode: 'hybrid' },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes('decisionMode'))).toBe(true);
      }
    });
  });
});
