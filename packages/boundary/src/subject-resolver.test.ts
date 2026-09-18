// AUTHORED (F2b; updated L3-Rx) — the D2 subject→injection resolver in isolation,
// with FAKE db lookups (no Postgres). The resolver's db path is exercised for
// real against Postgres in F2c's integration test; here we prove the mapping
// logic + the failure modes (ownership mismatch, no venue account) + the
// venue-resolution short-circuit.
//
// L3-Rx: the resolver now takes a resolved `skipVenueResolution` boolean instead
// of (category, toolName). The caller (bin.ts) computes it from
// `isReadOnlyCategory(category) || tool.ownerScopedNoVenue`. So here:
//   skipVenueResolution = false  → the tool NEEDS venue resolution (bot / default)
//   skipVenueResolution = true   → short-circuit (read-only OR owner-scoped write)

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

const MINIMAL_INJECTION = {
  ownerId: 'owner-1',
  actorId: 'actor-1',
  ownerMode: 'paper',
  venue: '',
  venueType: 'orderbook',
  venueAccountId: '',
};

describe('resolveSubjectInjection — needs venue resolution, bot-scoped tool', () => {
  it('derives venueAccountId + venue/venueType/ownerMode from the owned bot row', async () => {
    const res = await resolveSubjectInjection(
      SUBJECT,
      false,
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
      false,
      { botId: 'bot-1' },
      ports({ getBotById: async () => ({ ...BOT, config: { venue: 'jupiter' } }) }),
    );
    expect(res.ok && res.injection.venueType).toBe('swap');
    expect(res.ok && res.injection.ownerMode).toBe('paper'); // no execution.mode → safe default
  });

  it('rejects a bot owned by someone else with authorization.denied', async () => {
    const res = await resolveSubjectInjection(
      SUBJECT,
      false,
      { botId: 'bot-1' },
      ports({ getBotById: async () => ({ ...BOT, ownerId: 'other-owner' }) }),
    );
    expect(res).toEqual({ ok: false, code: 'authorization.denied', message: 'bot not owned by subject' });
  });

  it('rejects a missing bot with precondition.not_ready', async () => {
    const res = await resolveSubjectInjection(SUBJECT, false, { botId: 'gone' }, ports());
    expect(res.ok).toBe(false);
    expect(!res.ok && res.code).toBe('precondition.not_ready');
  });
});

describe('resolveSubjectInjection — needs venue resolution, no bot named (per-owner default)', () => {
  const ACCOUNT: ResolverVenueAccountRecord = { id: 'va-default', venue: 'bybit' };

  it('uses the single venue account when exactly one exists', async () => {
    const res = await resolveSubjectInjection(
      SUBJECT,
      false,
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
    const res = await resolveSubjectInjection(SUBJECT, false, {}, ports());
    expect(res).toEqual({ ok: false, code: 'precondition.not_ready', message: 'no venue account for owner' });
  });

  it('refuses when multiple accounts exist and no operator default is configured', async () => {
    const res = await resolveSubjectInjection(
      SUBJECT,
      false,
      {},
      ports({
        listVenueAccountsByOwner: async () => [ACCOUNT, { id: 'va-2', venue: 'hyperliquid' }],
      }),
    );
    expect(res.ok).toBe(false);
    expect(!res.ok && res.code).toBe('precondition.not_ready');
  });

  // Bug 2026-09-17 #001 regression: a payload-supplied venueAccountId MUST win
  // deterministically over the per-owner default path — even when the owner has
  // MULTIPLE accounts and no operator default (which would otherwise refuse
  // "ambiguous"). This is the L3c contract: herobids resolves the connection→
  // account mapping and threads the id as a payload arg; the dispatcher's Zod
  // parse previously stripped it (schema gap), so this path never fired and
  // every submit_decision fell through to the ambiguous refusal.
  it('honours a payload-supplied venueAccountId even when the owner has multiple accounts and no default', async () => {
    const res = await resolveSubjectInjection(
      SUBJECT,
      false,
      { venueAccountId: 'va-1' },
      ports({
        listVenueAccountsByOwner: async () => [
          { id: 'va-1', venue: 'hyperliquid' },
          { id: 'va-2', venue: '1inch' },
        ],
        // getDefaultVenueAccountId deliberately NOT wired — the supplied hint
        // must be sufficient on its own.
      }),
    );
    expect(res).toEqual({
      ok: true,
      injection: {
        ownerId: 'owner-1',
        actorId: 'actor-1',
        ownerMode: 'paper',
        venue: 'hyperliquid',
        venueType: 'orderbook',
        venueAccountId: 'va-1',
      },
    });
  });

  // Consumer-injected agent risk context (capital/riskPosture/riskOverrides):
  // carried through onto the injection when present; absent cleanly when not.
  describe('resolveSubjectInjection — agentRiskSpec extraction', () => {
    const ACCOUNTS = [
      { id: 'va-1', venue: 'hyperliquid' },
      { id: 'va-2', venue: '1inch' },
    ];

    it('carries capital + riskPosture + riskOverrides onto the injection when present', async () => {
      const res = await resolveSubjectInjection(
        SUBJECT,
        false,
        {
          venueAccountId: 'va-1',
          capital: '1000.00000000',
          riskPosture: { maxDrawdownPct: 5, dailyMaxLossPct: 3 },
          riskOverrides: { maxOpenPositions: 4 },
        },
        ports({ listVenueAccountsByOwner: async () => ACCOUNTS }),
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.injection.agentRiskSpec).toEqual({
          capital: '1000.00000000',
          riskPosture: { maxDrawdownPct: 5, dailyMaxLossPct: 3 },
          riskOverrides: { maxOpenPositions: 4 },
        });
      }
    });

    it('omits agentRiskSpec entirely when no risk fields are present (back-compat)', async () => {
      const res = await resolveSubjectInjection(
        SUBJECT,
        false,
        { venueAccountId: 'va-1' },
        ports({ listVenueAccountsByOwner: async () => ACCOUNTS }),
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.injection.agentRiskSpec).toBeUndefined();
    });

    it('drops non-numeric override values (defensive — the Zod schema already enforces them)', async () => {
      const res = await resolveSubjectInjection(
        SUBJECT,
        false,
        { venueAccountId: 'va-1', riskOverrides: { maxOpenPositions: 4, junk: 'x' } },
        ports({ listVenueAccountsByOwner: async () => ACCOUNTS }),
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.injection.agentRiskSpec?.riskOverrides).toEqual({ maxOpenPositions: 4 });
      }
    });

    it('omits agentRiskSpec when only non-numeric overrides are present', async () => {
      const res = await resolveSubjectInjection(
        SUBJECT,
        false,
        { venueAccountId: 'va-1', riskOverrides: { junk: 'x' } },
        ports({ listVenueAccountsByOwner: async () => ACCOUNTS }),
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.injection.agentRiskSpec).toBeUndefined();
    });
  });

  it('uses the operator default when multiple accounts exist and a default is set', async () => {
    const res = await resolveSubjectInjection(
      SUBJECT,
      false,
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

describe('resolveSubjectInjection — skipVenueResolution short-circuit', () => {
  it('short-circuits to a minimal injection (ownerId + actorId; empty venue coords)', async () => {
    const res = await resolveSubjectInjection(SUBJECT, true, { symbol: 'BTC' }, ports());
    expect(res).toEqual({ ok: true, injection: MINIMAL_INJECTION });
  });

  it('short-circuits even when the owner has NO venue account (would fail if resolution ran)', async () => {
    // The whole point: provision_venue_account / adjust_risk_limits / watch tools
    // must succeed with zero venue accounts. Contrast a resolution-needing tool.
    const skipRes = await resolveSubjectInjection(
      SUBJECT,
      true,
      { venue: 'hyperliquid', label: 'x', secrets: {} },
      ports({ listVenueAccountsByOwner: async () => [] }),
    );
    expect(skipRes.ok).toBe(true);

    const needRes = await resolveSubjectInjection(
      SUBJECT,
      false,
      {},
      ports({ listVenueAccountsByOwner: async () => [] }),
    );
    expect(needRes.ok).toBe(false);
    if (!needRes.ok) expect(needRes.code).toBe('precondition.not_ready');
  });

  it('does NOT consult the bot or venue-account ports when skipping (even if payload names a botId)', async () => {
    let botCalls = 0;
    let listCalls = 0;
    const res = await resolveSubjectInjection(
      SUBJECT,
      true,
      { botId: 'bot-1' },
      ports({
        getBotById: async () => { botCalls += 1; return BOT; },
        listVenueAccountsByOwner: async () => { listCalls += 1; return []; },
      }),
    );
    expect(res.ok).toBe(true);
    expect(botCalls).toBe(0);
    expect(listCalls).toBe(0);
  });
});
