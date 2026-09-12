// AUTHORED (Phase 9b item F2b) — the D2 subject→injection resolver in isolation,
// with FAKE db lookups (no Postgres). The resolver's db path is exercised for
// real against Postgres in F2c's integration test; here we prove the mapping
// logic + the two failure modes (ownership mismatch, no venue account).

import { describe, it, expect } from 'vitest';
import {
  resolveSubjectInjection,
  type SubjectResolverPorts,
  type ResolverBotRecord,
  type ResolverVenueAccountRecord,
} from './subject-resolver.js';

const SUBJECT = { ownerId: 'owner-1', actor: { type: 'agent' as const, id: 'actor-1' } };

function ports(overrides: Partial<SubjectResolverPorts> = {}): SubjectResolverPorts {
  return {
    getBotById: async () => null,
    listVenueAccountsByOwner: async () => [],
    ...overrides,
  };
}

const BOT: ResolverBotRecord = {
  ownerId: 'owner-1',
  venueAccountId: 'va-bot',
  config: { venue: 'hyperliquid', execution: { mode: 'shadow' } },
};

describe('resolveSubjectInjection — bot-scoped tool', () => {
  it('derives venueAccountId + venue/venueType/ownerMode from the owned bot row', async () => {
    const res = await resolveSubjectInjection(
      SUBJECT,
      'write-database',
      'adjust_bot_config',
      { botId: 'bot-1' },
      ports({ getBotById: async () => BOT }),
    );
    expect(res).toEqual({
      ok: true,
      injection: {
        ownerId: 'owner-1',
        actorId: 'actor-1',
        ownerMode: 'shadow',
        venue: 'hyperliquid',
        venueType: 'orderbook',
        venueAccountId: 'va-bot',
      },
    });
  });

  it('infers swap venueType for jupiter', async () => {
    const res = await resolveSubjectInjection(
      SUBJECT,
      'write-database',
      'adjust_bot_config',
      { botId: 'bot-1' },
      ports({ getBotById: async () => ({ ...BOT, config: { venue: 'jupiter' } }) }),
    );
    expect(res.ok && res.injection.venueType).toBe('swap');
    expect(res.ok && res.injection.ownerMode).toBe('paper'); // no execution.mode → safe default
  });

  it('rejects a bot owned by someone else with authorization.denied', async () => {
    const res = await resolveSubjectInjection(
      SUBJECT,
      'write-database',
      'adjust_bot_config',
      { botId: 'bot-1' },
      ports({ getBotById: async () => ({ ...BOT, ownerId: 'other-owner' }) }),
    );
    expect(res).toEqual({ ok: false, code: 'authorization.denied', message: 'bot not owned by subject' });
  });

  it('rejects a missing bot with precondition.not_ready', async () => {
    const res = await resolveSubjectInjection(SUBJECT, 'write-database', 'adjust_bot_config', { botId: 'gone' }, ports());
    expect(res.ok).toBe(false);
    expect(!res.ok && res.code).toBe('precondition.not_ready');
  });
});

describe('resolveSubjectInjection — no bot named (per-owner default)', () => {
  const ACCOUNT: ResolverVenueAccountRecord = { id: 'va-default', venue: 'bybit' };

  it('uses the single venue account when exactly one exists', async () => {
    const res = await resolveSubjectInjection(
      SUBJECT,
      'execute-trade',
      'submit_decision',
      {},
      ports({ listVenueAccountsByOwner: async () => [ACCOUNT] }),
    );
    expect(res).toEqual({
      ok: true,
      injection: {
        ownerId: 'owner-1',
        actorId: 'actor-1',
        ownerMode: 'paper',
        venue: 'bybit',
        venueType: 'orderbook',
        venueAccountId: 'va-default',
      },
    });
  });

  it('refuses (precondition.not_ready) when the owner has no venue account', async () => {
    const res = await resolveSubjectInjection(SUBJECT, 'execute-trade', 'submit_decision', {}, ports());
    expect(res).toEqual({ ok: false, code: 'precondition.not_ready', message: 'no venue account for owner' });
  });

  it('refuses when multiple accounts exist and no operator default is configured', async () => {
    const res = await resolveSubjectInjection(
      SUBJECT,
      'execute-trade',
      'submit_decision',
      {},
      ports({
        listVenueAccountsByOwner: async () => [ACCOUNT, { id: 'va-2', venue: 'hyperliquid' }],
      }),
    );
    expect(res.ok).toBe(false);
    expect(!res.ok && res.code).toBe('precondition.not_ready');
  });

  it('uses the operator default when multiple accounts exist and a default is set', async () => {
    const res = await resolveSubjectInjection(
      SUBJECT,
      'execute-trade',
      'submit_decision',
      {},
      ports({
        listVenueAccountsByOwner: async () => [ACCOUNT, { id: 'va-2', venue: 'hyperliquid' }],
        getDefaultVenueAccountId: () => 'va-2',
        getDefaultOwnerMode: () => 'shadow',
      }),
    );
    expect(res).toEqual({
      ok: true,
      injection: {
        ownerId: 'owner-1',
        actorId: 'actor-1',
        ownerMode: 'shadow',
        venue: 'hyperliquid',
        venueType: 'orderbook',
        venueAccountId: 'va-2',
      },
    });
  });
});

describe('resolveSubjectInjection — read-only tools (the read-tool seam)', () => {
  it('short-circuits a read-* category to a minimal injection (ownerId + actorId; empty venue coords)', async () => {
    // A pure market read (e.g. score_candidate) names no bot and needs no venue
    // account. The read-only short-circuit returns identity only; venue coords are
    // empty because reads never invoke the drive target that would consume them.
    const res = await resolveSubjectInjection(
      SUBJECT,
      'read-market-data',
      'score_candidate',
      { symbol: 'BTC' },
      ports(),
    );
    expect(res).toEqual({
      ok: true,
      injection: {
        ownerId: 'owner-1',
        actorId: 'actor-1',
        ownerMode: 'paper',
        venue: '',
        venueType: 'orderbook',
        venueAccountId: '',
      },
    });
  });

  it('succeeds for a read tool even when the owner has NO venue account (write tools fail here)', async () => {
    // Ports return no venue accounts. A write/no-bot tool would fail
    // precondition.not_ready; a read must NOT — it skips the venue-account gate.
    const readRes = await resolveSubjectInjection(
      SUBJECT,
      'read-market-data',
      'score_candidate',
      {},
      ports({ listVenueAccountsByOwner: async () => [] }),
    );
    expect(readRes.ok).toBe(true);

    // Contrast: the same empty-accounts ports fail for a non-read, no-bot tool.
    const writeRes = await resolveSubjectInjection(
      SUBJECT,
      'execute-trade',
      'submit_decision',
      {},
      ports({ listVenueAccountsByOwner: async () => [] }),
    );
    expect(writeRes.ok).toBe(false);
    if (!writeRes.ok) {
      expect(writeRes.code).toBe('precondition.not_ready');
    }
  });

  it('does NOT consult the bot row for a read tool even if the payload names a botId', async () => {
    // A read categorized read-* short-circuits before any bot lookup. Prove the
    // bot port is never called (identity comes from the signed subject, and read
    // tools enforce their own ownership by ctx.agentId downstream).
    let botLookupCalls = 0;
    const res = await resolveSubjectInjection(
      SUBJECT,
      'read-database',
      'get_bot_status',
      { botId: 'bot-1' },
      ports({
        getBotById: async () => {
          botLookupCalls += 1;
          return BOT;
        },
      }),
    );
    expect(res.ok).toBe(true);
    expect(botLookupCalls).toBe(0);
  });
});

describe('resolveSubjectInjection — owner-scoped provisioning tools (the provisioning seam)', () => {
  // provision_venue_account / deprovision_venue_account are write-database tools
  // that need only ownerId; they must NOT require a pre-existing venue account
  // (provision creates the FIRST one — requiring one is a chicken-and-egg deadlock).
  for (const toolName of ['provision_venue_account', 'deprovision_venue_account']) {
    it(`short-circuits ${toolName} to a minimal injection even with NO venue account`, async () => {
      let listCalls = 0;
      let botCalls = 0;
      const res = await resolveSubjectInjection(
        SUBJECT,
        'write-database',
        toolName,
        { venue: 'hyperliquid', label: 'x', secrets: {} },
        ports({
          listVenueAccountsByOwner: async () => { listCalls += 1; return []; },
          getBotById: async () => { botCalls += 1; return null; },
        }),
      );
      expect(res).toEqual({
        ok: true,
        injection: {
          ownerId: 'owner-1',
          actorId: 'actor-1',
          ownerMode: 'paper',
          venue: '',
          venueType: 'orderbook',
          venueAccountId: '',
        },
      });
      // The short-circuit must not consult the venue-account or bot ports.
      expect(listCalls).toBe(0);
      expect(botCalls).toBe(0);
    });
  }

  it('a NON-provisioning write-database tool still requires a venue account', async () => {
    // Guard: the seam is name-scoped, not category-wide — other write-database
    // tools (e.g. create_bot with no bot yet) still hit the default-account path.
    const res = await resolveSubjectInjection(
      SUBJECT,
      'write-database',
      'create_bot',
      {},
      ports({ listVenueAccountsByOwner: async () => [] }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('precondition.not_ready');
  });
});
