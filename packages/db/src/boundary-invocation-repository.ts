import crypto, { createHash } from 'node:crypto';
import { eq, and, sql } from 'drizzle-orm';
import type { Database } from './index.js';
import { boundaryInvocations } from './schema/index.js';

/**
 * The M2 REST idempotency store (005 §Deadlines, Retries, And Idempotency).
 *
 * COPY-ADAPT (decision D1): the fingerprint + advisory-lock/dedupe flow is
 * copy-adapted from the herobids oracle — NOT authored fresh:
 *  - `computeRequestFingerprint` mirrors herobids
 *    `computeInstantiateRequestHash` (apps/api/src/services/blueprint-idempotency.ts):
 *    a deterministic SHA-256 over a recursively key-sorted normalized object
 *    (arrays preserve order).
 *  - `beginOrResolve` mirrors the fork-route transaction
 *    (apps/api/src/routes/blueprints.ts, ~L1134): advisory-lock → look up the
 *    existing row → same fingerprint → replay the stored response; different
 *    fingerprint → conflict; no row → persist + proceed. Re-keyed to the 005
 *    four-tuple.
 *
 * The advisory lock follows the item-E precedent (`BotRepository`,
 * repositories.ts): `pg_advisory_xact_lock(<CLASS_INT>, hashtext(<text>))` inside
 * `this.db.transaction`. `MAXBOTS_LOCK_CLASS = 17` is taken; this uses class 18.
 *
 * AUTHORED on top (005 deltas; herobids is synchronous replay-or-conflict with no
 * in-flight state): the four-tuple key, the `in_progress` → `terminal` transition
 * (`complete`), terminal-response storage, `expiresAt` from a caller-supplied
 * retention window, and the "same key + still running → in_progress" path.
 */

/** Recursively sort object keys for deterministic serialization. Arrays keep order. */
function sortKeysDeep(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj).sort();
  for (const key of keys) {
    const value = obj[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      sorted[key] = sortKeysDeep(value as Record<string, unknown>);
    } else {
      sorted[key] = value;
    }
  }
  return sorted;
}

/**
 * Compute the deterministic request fingerprint for idempotency comparison
 * (copy-adapted from herobids `computeInstantiateRequestHash`). Two requests with
 * the same subject + toolName + payload produce the same fingerprint regardless
 * of object-key ordering. requestId / correlationId / timestamps are deliberately
 * excluded — they legitimately differ across retries of the same logical request.
 */
export function computeRequestFingerprint(input: {
  consumerId: string;
  ownerId: string;
  toolName: string;
  payload: unknown;
}): string {
  const normalized: Record<string, unknown> = {
    consumerId: input.consumerId,
    ownerId: input.ownerId,
    toolName: input.toolName,
    payload: input.payload ?? null,
  };

  const json = JSON.stringify(normalized, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return sortKeysDeep(value as Record<string, unknown>);
    }
    return value;
  });

  return createHash('sha256').update(json, 'utf-8').digest('hex');
}

export interface BeginOrResolveParams {
  consumerId: string;
  ownerId: string;
  toolName: string;
  idempotencyKey: string;
  requestFingerprint: string;
  requestId: string;
  correlationId: string;
  /** Retention window in ms — a VALUE passed in (005: never hard-coded). */
  retentionMs: number;
}

export type BeginResult =
  | { kind: 'started'; id: string }
  | { kind: 'in_progress' }
  | { kind: 'replay'; terminalResponse: Record<string, unknown> | null }
  | { kind: 'conflict' };

export interface CompleteParams {
  consumerId: string;
  ownerId: string;
  toolName: string;
  idempotencyKey: string;
  terminalResponse: Record<string, unknown>;
}

export type BoundaryInvocationRow = typeof boundaryInvocations.$inferSelect;

export class BoundaryInvocationRepository {
  constructor(private readonly db: Database) {}

  /**
   * Advisory-lock class id reserved for the per-key boundary idempotency
   * serialization. `MAXBOTS_LOCK_CLASS = 17` (BotRepository) is taken; this uses
   * a distinct reserved int so the two-int
   * `pg_advisory_xact_lock(classId, hashtext(key))` form does not collide.
   */
  private static readonly BOUNDARY_LOCK_CLASS = 18;

  /** Stable lock key over the four-tuple (serializes concurrent retries of one key). */
  private static lockKey(p: {
    consumerId: string;
    ownerId: string;
    toolName: string;
    idempotencyKey: string;
  }): string {
    return `${p.consumerId}:${p.ownerId}:${p.toolName}:${p.idempotencyKey}`;
  }

  /**
   * The copy-adapted core (mirrors the herobids fork-route transaction, re-keyed).
   * Run inside ONE transaction under a per-key advisory lock:
   *  - no row            → insert `in_progress`, return `started` (caller executes);
   *  - different fp      → `conflict` (caller maps to validation.invalid_payload);
   *  - same fp, running  → `in_progress` (caller returns the in-progress status);
   *  - same fp, terminal → `replay` with the stored terminal response.
   */
  async beginOrResolve(params: BeginOrResolveParams): Promise<BeginResult> {
    return this.db.transaction(async (tx) => {
      // Serialize concurrent retries of the same key. Copied from the herobids
      // fork route (advisory lock per (userId, idempotencyKey)) and the item-E
      // precedent (two-int form). `_xact_` auto-releases at commit/rollback.
      // Without this, two concurrent transactions under READ COMMITTED both see
      // "no row" and both insert, racing the unique index.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${BoundaryInvocationRepository.BOUNDARY_LOCK_CLASS}, hashtext(${BoundaryInvocationRepository.lockKey(params)}))`,
      );

      const [existing] = await tx
        .select()
        .from(boundaryInvocations)
        .where(
          and(
            eq(boundaryInvocations.consumerId, params.consumerId),
            eq(boundaryInvocations.ownerId, params.ownerId),
            eq(boundaryInvocations.toolName, params.toolName),
            eq(boundaryInvocations.idempotencyKey, params.idempotencyKey),
          ),
        )
        .limit(1);

      if (existing) {
        if (existing.requestFingerprint !== params.requestFingerprint) {
          return { kind: 'conflict' as const };
        }
        if (existing.state === 'terminal') {
          return { kind: 'replay' as const, terminalResponse: existing.terminalResponse };
        }
        // same fingerprint, still in_progress → no second side effect.
        return { kind: 'in_progress' as const };
      }

      const id = crypto.randomUUID();
      const now = new Date();
      await tx.insert(boundaryInvocations).values({
        id,
        consumerId: params.consumerId,
        ownerId: params.ownerId,
        toolName: params.toolName,
        idempotencyKey: params.idempotencyKey,
        requestFingerprint: params.requestFingerprint,
        requestId: params.requestId,
        correlationId: params.correlationId,
        state: 'in_progress',
        terminalResponse: null,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + params.retentionMs),
      });

      return { kind: 'started' as const, id };
    });
  }

  /**
   * Transition an in-flight row to terminal, storing the mapped result (the
   * AUTHORED delta — herobids had no in-flight → terminal transition). Keyed by
   * the four-tuple.
   */
  async complete(params: CompleteParams): Promise<void> {
    await this.db
      .update(boundaryInvocations)
      .set({
        state: 'terminal',
        terminalResponse: params.terminalResponse,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(boundaryInvocations.consumerId, params.consumerId),
          eq(boundaryInvocations.ownerId, params.ownerId),
          eq(boundaryInvocations.toolName, params.toolName),
          eq(boundaryInvocations.idempotencyKey, params.idempotencyKey),
          // Guard: only an in_progress row transitions to terminal — completing
          // an already-terminal row is a no-op, making complete idempotent and
          // preventing a double-complete from overwriting the stored response.
          eq(boundaryInvocations.state, 'in_progress'),
        ),
      );
  }

  /** Look up an invocation by requestId — feeds the F2b status endpoint. */
  async findByRequestId(requestId: string): Promise<BoundaryInvocationRow | null> {
    const [row] = await this.db
      .select()
      .from(boundaryInvocations)
      .where(eq(boundaryInvocations.requestId, requestId))
      .limit(1);
    return row ?? null;
  }
}
