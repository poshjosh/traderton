/** Canonical price-candle shape (D2-c). */

export interface PriceCandle {
  timestamp: string; // ISO 8601
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}