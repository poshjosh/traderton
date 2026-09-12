import { describe, it, expect } from 'vitest';
import { CANDLE_PROVIDERS } from './candle-registry.js';

for (const [key, provider] of Object.entries(CANDLE_PROVIDERS)) {
  describe(`${key}.resolveSymbol`, () => {
    it('handles bare ticker', () => {
      expect(provider.resolveSymbol('BTC')).toBe('BTCUSDT');
    });

    it('handles lowercase', () => {
      expect(provider.resolveSymbol('btc')).toBe('BTCUSDT');
    });

    it('handles slash pair with USD', () => {
      expect(provider.resolveSymbol('BTC/USD')).toBe('BTCUSDT');
    });

    it('handles slash pair with USDT', () => {
      expect(provider.resolveSymbol('BTC/USDT')).toBe('BTCUSDT');
    });

    it('handles dash-perp', () => {
      expect(provider.resolveSymbol('BTC-PERP')).toBe('BTCUSDT');
    });

    it('handles already-concatenated symbol', () => {
      expect(provider.resolveSymbol('BTCUSDT')).toBe('BTCUSDT');
    });

    it('handles SOL', () => {
      expect(provider.resolveSymbol('SOL')).toBe('SOLUSDT');
    });

    it('has required fields', () => {
      expect(provider.id).toBe(key);
      expect(provider.symbolFormatHint).toBeTruthy();
      expect(provider.resolveSymbol).toBeTypeOf('function');
      expect(provider.fetchCandles).toBeTypeOf('function');
      expect(provider.fetchCandlesWithMeta).toBeTypeOf('function');
    });

    it('fetchCandlesWithMeta surfaces provider + freshness meta', async () => {
      const registry = {
        binance: {
          candles: async () => ({
            data: [{ t: 1 }],
            meta: { freshness: { source: 'cache' as const, fetchedAt: '', ageMs: 5000, ttlMs: 0, isStale: true, expiresAt: '' } },
          }),
        },
      };
      const res = await provider.fetchCandlesWithMeta(registry, 'BTC');
      expect(res.candles).toHaveLength(1);
      expect(res.freshness).toEqual({ provider: key, source: 'cache', ageMs: 5000, isStale: true });
    });

    it('fetchCandlesWithMeta returns null freshness when meta is absent', async () => {
      const registry = { binance: { candles: async () => ({ data: [] }) } };
      const res = await provider.fetchCandlesWithMeta(registry, 'BTC');
      expect(res.freshness).toBeNull();
    });
  });
}
