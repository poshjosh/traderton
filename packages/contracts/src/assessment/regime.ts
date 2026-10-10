/** Regime classification result (regime & volatility shape group, C1.5). */
import { z } from 'zod';

export interface RegimeResult {
  pass: boolean;
  reasons: string[];
  details: {
    benchmarkSymbol: string;
    currentPrice: number;
    emaFast: number;
    emaSlow: number;
    emaTrend: number;
    emaAlignment: 'bullish' | 'bearish';
    adxValue: number;
    choppy: boolean;
    vwap: number;
    priceAboveVwap: boolean;
    marketStructure: 'higherHighs' | 'lowerHighs' | 'mixed';
  };
}

export const RegimeResultSchema = z.object({
  pass: z.boolean(),
  reasons: z.array(z.string()),
  details: z.object({
    benchmarkSymbol: z.string(),
    currentPrice: z.number(),
    emaFast: z.number(),
    emaSlow: z.number(),
    emaTrend: z.number(),
    emaAlignment: z.enum(['bullish', 'bearish']),
    adxValue: z.number(),
    choppy: z.boolean(),
    vwap: z.number(),
    priceAboveVwap: z.boolean(),
    marketStructure: z.enum(['higherHighs', 'lowerHighs', 'mixed']),
  }),
});