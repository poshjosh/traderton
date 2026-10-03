/**
 * Opt-in position marking for `get_agent_positions` (`includeMarks: true`).
 *
 * Pure, injectable helpers that enrich OPEN positions with a current mark price
 * and unrealized P&L. Everything the engine needs is derived from the position
 * row plus a single price lookup per distinct asset. Failures degrade to nulls —
 * a mark is best-effort valuation metadata, never a reason to fail the read.
 */

import { Decimal } from '@traderton/domain';
import { unrealizedPnl, type PositionState } from '@traderton/engine';
import { isOnChainAddress } from './price.js';
import { resolveSwapNetwork } from '../resolve-swap-assets.js';

/**
 * Shared deadline for the whole mark pass. Operational mechanics (not trading
 * policy): it bounds how long the opt-in valuation can block the boundary read.
 * It must stay well under the herobids consumer's boundary read deadline
 * (`DEFAULT_READ_TIMEOUT_MS = 10_000` in herobids `trading.ts`) so a slow or
 * stuck price source yields null marks instead of a timed-out read for the
 * caller. Price lookups that miss the deadline resolve to null.
 */
export const POSITION_MARK_BUDGET_MS = 3_000;

/** The subset of a position row this module reads. */
export interface MarkablePositionRow {
  venue: string;
  symbol: string;
  instrumentId?: string | null;
  side: string;
  size: string;
  entryPrice: string;
  closedAt: Date | null;
}

/** Mark fields added to every row when marks are requested. */
export interface PositionMarkFields {
  markPrice: string | null;
  unrealizedPnl: string | null;
  markedAt: string | null;
}

/** A resolved price-lookup target for a position. */
export interface PriceTarget {
  symbol: string;
  chain: string;
  address?: string;
}

const USD_QUOTES = new Set(['USD', 'USDC', 'USDT']);
/** Perp venues quote in USD even when the symbol carries no explicit quote. */
const USD_IMPLICIT_CHAINS = new Set(['hyperliquid', 'bybit']);

/**
 * Map a position's venue to the price-service chain identifier.
 * Returns null when the venue cannot be routed (unknown venue, or a 1inch
 * position whose chain cannot be resolved from operator config).
 */
function venueToChain(
  venue: string,
  oneInchConfig?: { tokenSafetyNetwork?: string; chainId?: number },
): string | null {
  switch (venue) {
    case 'hyperliquid':
      return 'hyperliquid';
    // The price service supports bybit even though the get_price tool enum does not.
    case 'bybit':
      return 'bybit';
    case 'jupiter':
      return 'solana';
    case '1inch':
      return resolveSwapNetwork('1inch', undefined, oneInchConfig) ?? null;
    default:
      return null;
  }
}

/**
 * Derive the base ticker and quote currency from a position symbol.
 * Splits on the first `-`, `/` or `:` so `BTC-PERP`, `SOL/USDC`, `XYZ-USD` and
 * `BTC/USD:USD` all yield a sensible base + quote.
 */
function splitSymbol(symbol: string): { base: string; quote: string | null } {
  const match = symbol.match(/^([^\-/:]+)[\-/:](.*)$/);
  if (!match) {
    return { base: symbol, quote: null };
  }
  const base = match[1] ?? symbol;
  // The remainder may itself carry further separators (BTC/USD:USD) — the first
  // segment is the quote currency.
  const rest = match[2] ?? '';
  const quoteMatch = rest.match(/^([^\-/:]+)/);
  const quote = quoteMatch?.[1] ?? null;
  return { base, quote: quote && quote.length > 0 ? quote : null };
}

/**
 * Resolve a position row to a concrete price-lookup target, or null when the
 * position cannot be safely marked.
 *
 * Null cases:
 * - unroutable venue (unknown, or unresolvable 1inch chain);
 * - a non-USD quote (the price service returns USD; `entryPrice` is in quote
 *   units, so a non-USD quote would mix numeraires and produce a wrong P&L).
 */
export function toPriceTarget(
  row: MarkablePositionRow,
  oneInchConfig?: { tokenSafetyNetwork?: string; chainId?: number },
): PriceTarget | null {
  const chain = venueToChain(row.venue, oneInchConfig);
  if (!chain) return null;

  // Address-shaped symbol → identity-aware lookup by address.
  if (isOnChainAddress(row.symbol, chain)) {
    return { symbol: row.symbol, chain, address: row.symbol };
  }

  const { base, quote } = splitSymbol(row.symbol);

  // Quote guard: the price service returns USD, so mark only when the entry
  // price is also in USD. Perp venues (hyperliquid/bybit) are implicitly
  // USD-quoted — any symbol suffix (`-PERP`, `-USD`, bare ticker) is a contract
  // label, not a quote currency. For spot/DEX venues the quote must be USD-like,
  // otherwise the USD mark would mix numeraires with a non-USD entry price.
  if (!USD_IMPLICIT_CHAINS.has(chain)) {
    const quoteIsUsd = quote !== null && USD_QUOTES.has(quote.toUpperCase());
    if (!quoteIsUsd) return null;
  }

  return { symbol: base, chain };
}

/** Minimal price-service shape this module needs. */
export interface MarkPriceService {
  getPrice(symbol: string, chain: string, address?: string): Promise<{
    ok: boolean;
    data?: { priceUsd: number; source: string; fetchedAt: string; stale: boolean };
    error?: { code: string; message: string };
  }>;
}

export interface MarkOpenPositionsDeps {
  priceService?: MarkPriceService;
  oneInchConfig?: { tokenSafetyNetwork?: string; chainId?: number };
  budgetMs: number;
  /**
   * Request-time clock, injected for determinism/testability. `markedAt` is the
   * price source's `fetchedAt` (true mark freshness), so `now` is not currently
   * read when a mark succeeds; it is kept on the contract as the caller's
   * reference instant for the pass.
   */
  now: Date;
}

interface MarkLookupResult {
  priceUsd: number;
  fetchedAt: string;
}

const nullMarks: PositionMarkFields = { markPrice: null, unrealizedPnl: null, markedAt: null };

function targetKey(target: PriceTarget): string {
  return `${target.chain}:${target.symbol}:${target.address ?? ''}`;
}

/**
 * Enrich every row with mark fields. Open, non-flat rows are marked (best
 * effort); closed or flat rows always get nulls.
 *
 * - Lookups are deduped by `chain:symbol:address` and run in parallel, each
 *   raced against ONE shared deadline (`budgetMs`). Late or failed lookups → null.
 * - Unrealized P&L is computed via the engine `unrealizedPnl` from Decimal
 *   size/entryPrice and the USD mark price.
 * - No `priceService` → every row gets nulls.
 */
export async function markOpenPositions<T extends MarkablePositionRow>(
  rows: T[],
  deps: MarkOpenPositionsDeps,
): Promise<Array<T & PositionMarkFields>> {
  const { priceService, oneInchConfig, budgetMs } = deps;

  if (!priceService) {
    return rows.map((row) => ({ ...row, ...nullMarks }));
  }

  // Resolve a target per open, non-flat row.
  const targets = new Map<number, PriceTarget>();
  for (const [index, row] of rows.entries()) {
    if (row.closedAt !== null || row.side === 'flat') continue;
    const target = toPriceTarget(row, oneInchConfig);
    if (target) targets.set(index, target);
  }

  if (targets.size === 0) {
    return rows.map((row) => ({ ...row, ...nullMarks }));
  }

  // One shared deadline for the whole pass. Each lookup races it independently;
  // the timer is never a dangling handle because it resolves (to null) itself.
  const deadline = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), budgetMs).unref?.();
  });

  // Dedupe lookups by target identity.
  const uniqueTargets = new Map<string, PriceTarget>();
  for (const target of targets.values()) {
    uniqueTargets.set(targetKey(target), target);
  }

  const lookups = new Map<string, Promise<MarkLookupResult | null>>();
  for (const [key, target] of uniqueTargets) {
    const fetch = priceService
      .getPrice(target.symbol, target.chain, target.address)
      .then((result): MarkLookupResult | null => {
        if (!result?.ok || !result.data || typeof result.data.priceUsd !== 'number') {
          return null;
        }
        return { priceUsd: result.data.priceUsd, fetchedAt: result.data.fetchedAt };
      })
      .catch(() => null);
    lookups.set(key, Promise.race([fetch, deadline]));
  }

  const resolved = new Map<string, MarkLookupResult | null>();
  await Promise.all(
    [...lookups].map(async ([key, promise]) => {
      resolved.set(key, await promise);
    }),
  );

  return rows.map((row, index) => {
    const target = targets.get(index);
    if (!target) return { ...row, ...nullMarks };

    const lookup = resolved.get(targetKey(target));
    if (!lookup) return { ...row, ...nullMarks };

    const position: PositionState = {
      venue: row.venue,
      symbol: row.symbol,
      side: row.side as PositionState['side'],
      size: new Decimal(row.size),
      entryPrice: new Decimal(row.entryPrice),
      realizedPnl: new Decimal(0),
      ...(row.instrumentId ? { instrumentId: row.instrumentId } : {}),
    };

    const markPrice = new Decimal(String(lookup.priceUsd));
    const pnl = unrealizedPnl(position, markPrice);

    return {
      ...row,
      markPrice: markPrice.toFixed(),
      // Unrounded — herobids rounds for display.
      unrealizedPnl: pnl.toFixed(),
      // Mark freshness is the price source's fetch time, not request time.
      markedAt: lookup.fetchedAt,
    };
  });
}
