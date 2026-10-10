/** Watch purpose taxonomy — moved from `trading-protocol.ts` (single source of truth). */
import { z } from 'zod';

export const WATCH_PURPOSE_VALUES = ['entry', 'exit', 'stop_loss', 'take_profit', 'monitor', 'alert'] as const;
export const WatchPurposeEnum = z.enum(WATCH_PURPOSE_VALUES);
export type WatchPurpose = z.infer<typeof WatchPurposeEnum>;