import type { IdGenerator } from '@traderton/engine';
import type { OrderId, FillId } from '@traderton/domain';

/**
 * idGen — relocated VERBATIM from herobids apps/worker/src/index.ts:463–468
 * (Phase 9b item B, locked decision 013 §4.1c). herobids has no discrete
 * id-gen file; it was an inline module-level object literal. This is a
 * verbatim relocation of that literal (trading scaffolding), not authoring.
 *
 * Note: the "UUIDv7" intent in the herobids comment is aspirational; the
 * implementation is `crypto.randomUUID()` — kept as-is per 013 §4.1c.
 */
export function createIdGen(): IdGenerator & { planId(): string; decisionId(): string } {
  // ID generator using UUIDv7 (crypto.randomUUID as fallback)
  const idGen: IdGenerator & { planId(): string; decisionId(): string } = {
    orderId: () => crypto.randomUUID() as OrderId,
    fillId: () => crypto.randomUUID() as FillId,
    planId: () => crypto.randomUUID(),
    decisionId: () => crypto.randomUUID(),
  };
  return idGen;
}
