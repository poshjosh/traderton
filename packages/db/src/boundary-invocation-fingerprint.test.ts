import { describe, it, expect } from 'vitest';
import { computeRequestFingerprint } from './boundary-invocation-repository.js';

/**
 * Unit test for the copy-adapted request fingerprint (no DB). Mirrors the
 * herobids `computeInstantiateRequestHash` guarantees: deterministic SHA-256 over
 * a recursively key-sorted object — same logical request → same hash, reordered
 * keys → same hash, changed payload → different hash. requestId/correlationId are
 * NOT part of the fingerprint (they differ across retries of the same request).
 */
describe('computeRequestFingerprint (copy-adapted from herobids)', () => {
  const base = {
    consumerId: 'consumerA',
    ownerId: 'owner-1',
    toolName: 'place_order',
    payload: { symbol: 'BTC', side: 'buy', qty: 1 },
  };

  it('same logical request → same hash', () => {
    expect(computeRequestFingerprint(base)).toBe(computeRequestFingerprint({ ...base }));
  });

  it('reordered object keys in the payload → same hash', () => {
    const reordered = {
      consumerId: 'consumerA',
      ownerId: 'owner-1',
      toolName: 'place_order',
      payload: { qty: 1, side: 'buy', symbol: 'BTC' },
    };
    expect(computeRequestFingerprint(reordered)).toBe(computeRequestFingerprint(base));
  });

  it('reordered keys in a NESTED object → same hash (recursive sort)', () => {
    const a = { ...base, payload: { a: { x: 1, y: 2 }, b: 3 } };
    const b = { ...base, payload: { b: 3, a: { y: 2, x: 1 } } };
    expect(computeRequestFingerprint(a)).toBe(computeRequestFingerprint(b));
  });

  it('changed payload → different hash', () => {
    const changed = { ...base, payload: { symbol: 'BTC', side: 'sell', qty: 1 } };
    expect(computeRequestFingerprint(changed)).not.toBe(computeRequestFingerprint(base));
  });

  it('different toolName / owner / consumer → different hash', () => {
    expect(computeRequestFingerprint({ ...base, toolName: 'cancel_order' })).not.toBe(
      computeRequestFingerprint(base),
    );
    expect(computeRequestFingerprint({ ...base, ownerId: 'owner-2' })).not.toBe(
      computeRequestFingerprint(base),
    );
    expect(computeRequestFingerprint({ ...base, consumerId: 'consumerB' })).not.toBe(
      computeRequestFingerprint(base),
    );
  });

  it('array order is significant (preserved, not sorted)', () => {
    const a = { ...base, payload: { legs: [1, 2, 3] } };
    const b = { ...base, payload: { legs: [3, 2, 1] } };
    expect(computeRequestFingerprint(a)).not.toBe(computeRequestFingerprint(b));
  });
});
