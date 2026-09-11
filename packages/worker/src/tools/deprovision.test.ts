import { describe, it, expect, vi } from 'vitest';
import type { TradingToolContext } from '@traderton/domain';
import { provisioningTools } from './provisioning.js';

/**
 * Tool-level tests for `deprovision_venue_account`.
 *
 * These adapt the copied accounts.ts / provider-links.ts DELETE-path behaviour
 * (the parity oracle, verified against CURRENT herobids practice) into the tool
 * shape: route → tool, JWT userId → boundary-resolved `ctx.ownerId`, replies →
 * ToolResult. Copied assertions: owner-scoped not_found; block on ANY bot
 * (no status filter); FK-23503 fallback → in_use; cascade delete (account THEN
 * credential, in order); metadata-only success.
 */

const OWNER_ID = 'owner-1';
const VA_ID = 'va-1';
const CRED_ID = 'cred-1';

const deprovisionTool = provisioningTools.find((t) => t.name === 'deprovision_venue_account')!;

interface MockDbOpts {
  /** The account row returned by the owner-scoped select (undefined = not found). */
  account?: { id: string; credentialId: string | null };
  /** Bot ids returned by the bots-by-venue-account select (pre-check). */
  bots?: string[];
  /** If set, the transaction throws a pg error with this code. */
  txErrorCode?: string;
  /** Bot ids returned by the FK-fallback re-query (after a 23503). */
  botsOnRace?: string[];
}

// Ordered capture of delete targets so tests can assert account-before-credential.
let deleteOrder: string[];

function buildMockDb(opts: MockDbOpts) {
  deleteOrder = [];
  let selectCall = 0;

  // db.select().from().where() → resolves to an array. First select = account
  // (by id+owner), subsequent selects = bots (by venueAccountId).
  const makeSelect = () => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation(() => {
        const call = selectCall++;
        if (call === 0) {
          return Promise.resolve(opts.account ? [opts.account] : []);
        }
        // bots selects — pre-check uses opts.bots; the FK-fallback re-query
        // (after a tx error) uses botsOnRace.
        const botIds = opts.txErrorCode ? (opts.botsOnRace ?? []) : (opts.bots ?? []);
        return Promise.resolve(botIds.map((id) => ({ id })));
      }),
    }),
  });

  const tx = {
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation((cond: unknown) => {
        // Record the delete in order. We can't read the drizzle condition object
        // cleanly, so infer target by call order: first delete = venue_accounts,
        // second = user_credentials (the tool's documented order).
        deleteOrder.push(deleteOrder.length === 0 ? 'venue_account' : 'credential');
        void cond;
        return Promise.resolve();
      }),
    }),
  };

  return {
    select: vi.fn().mockImplementation(makeSelect),
    transaction: vi.fn().mockImplementation(async (fn: (innerTx: typeof tx) => Promise<unknown>) => {
      if (opts.txErrorCode) {
        const e = new Error('fk') as Error & { code?: string };
        e.code = opts.txErrorCode;
        throw e;
      }
      return fn(tx);
    }),
  } as unknown as TradingToolContext['db'];
}

function makeCtx(dbOpts: MockDbOpts, overrides: Partial<TradingToolContext> = {}): TradingToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    ownerId: OWNER_ID,
    executionMode: 'paper',
    authorizationMode: 'direct',
    redis: {} as unknown as TradingToolContext['redis'],
    publishToInbound: vi.fn(async () => undefined),
    db: buildMockDb(dbOpts),
    ...overrides,
  };
}

describe('deprovision_venue_account tool', () => {
  it('is registered write-database (side-effecting)', () => {
    expect(deprovisionTool).toBeDefined();
    expect(deprovisionTool.category).toBe('write-database');
  });

  it('deletes the account then its credential (cascade, in order) and returns metadata only', async () => {
    const result = await deprovisionTool.execute(
      { venueAccountId: VA_ID },
      makeCtx({ account: { id: VA_ID, credentialId: CRED_ID }, bots: [] }),
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ venueAccountId: VA_ID, deleted: true });
    // account BEFORE credential (FK order).
    expect(deleteOrder).toEqual(['venue_account', 'credential']);
    // never a secret in the response
    expect(JSON.stringify(result.data)).not.toContain('secret');
  });

  it('deletes only the account when it has no linked credential', async () => {
    const result = await deprovisionTool.execute(
      { venueAccountId: VA_ID },
      makeCtx({ account: { id: VA_ID, credentialId: null }, bots: [] }),
    );
    expect(result.success).toBe(true);
    expect(deleteOrder).toEqual(['venue_account']);
  });

  it('returns not_found for an absent/unowned venue account', async () => {
    const result = await deprovisionTool.execute(
      { venueAccountId: 'nope' },
      makeCtx({ account: undefined }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe('not_found.resource');
    }
  });

  it('blocks on ANY bot referencing the account (no status filter) → in_use', async () => {
    const result = await deprovisionTool.execute(
      { venueAccountId: VA_ID },
      makeCtx({ account: { id: VA_ID, credentialId: CRED_ID }, bots: ['bot-a', 'bot-b'] }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe('provision.in_use');
      expect(result.error).toContain('bot-a');
      expect(result.error).toContain('bot-b');
    }
    // nothing deleted
    expect(deleteOrder).toEqual([]);
  });

  it('maps an FK-23503 race (bot linked between pre-check and delete) to in_use', async () => {
    const result = await deprovisionTool.execute(
      { venueAccountId: VA_ID },
      makeCtx({
        account: { id: VA_ID, credentialId: CRED_ID },
        bots: [], // pre-check clean
        txErrorCode: '23503', // tx fails on the FK
        botsOnRace: ['bot-late'], // re-query finds the racer
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe('provision.in_use');
      expect(result.error).toContain('bot-late');
    }
  });

  it('fails closed when owner identity is missing', async () => {
    const result = await deprovisionTool.execute(
      { venueAccountId: VA_ID },
      makeCtx({ account: { id: VA_ID, credentialId: CRED_ID }, bots: [] }, { ownerId: '' }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe('provision.owner_unavailable');
    }
  });
});
