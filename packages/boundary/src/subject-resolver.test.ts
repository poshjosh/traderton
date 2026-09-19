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
import { buildResolverPorts, type ResolverPortsDeps } from './resolver-ports.js';
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
        getDefaultVenueAccountId: async () => 'va-2',
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

// ── A4: the wired default ports ─────────────────────────────────────────────
// The boundary composition root (resolver-ports.ts) implements
// getDefaultOwnerMode as the static operator knob `execution.defaultOwnerMode`
// and getDefaultVenueAccountId as the owner's OLDEST account by created_at
// (no is_default column in the verified schema — deterministic pick, id
// tiebreak). These tests pin the RESOLVER's consumption of those ports and the
// ports' own policy (buildResolverPorts, with a fake db).

describe('resolveSubjectInjection — wired getDefaultOwnerMode (A4 semantics)', () => {
  function makePorts(mode: 'paper' | 'shadow' | 'live'): SubjectResolverPorts {
    return ports({
      listVenueAccountsByOwner: async () => [{ id: 'va-1', venue: 'hyperliquid' }],
      getDefaultOwnerMode: () => mode,
    });
  }

  it('agent subject: ownerMode = the port value, NOT the safe fallback paper', async () => {
    const res = await resolveSubjectInjection(
      SUBJECT,
      false,
      {}, // no bot, no payload venueAccountId → no-bot path
      makePorts('shadow'),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.injection.ownerMode).toBe('shadow');
  });

  it('agent subject: mode applies even when the payload requests a lower mode (ceiling semantics)', async () => {
    const res = await resolveSubjectInjection(
      SUBJECT,
      false,
      { config: { execution: { mode: 'paper' } } },
      makePorts('live'),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.injection.ownerMode).toBe('live');
  });

  it('agent subject: injected executionMode is authoritative over the port (Option A)', async () => {
    // The consumer stamps the agent's REAL mode post-LLM; it must win over the
    // static operator default so a shadow agent on a paper-default operator can
    // still author shadow bots (swap-venue fix).
    const res = await resolveSubjectInjection(
      SUBJECT,
      false,
      { config: { execution: { mode: 'shadow' } }, executionMode: 'shadow' },
      makePorts('paper'),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.injection.ownerMode).toBe('shadow');
  });

  it('agent subject: invalid injected executionMode is ignored (falls back to port)', async () => {
    const res = await resolveSubjectInjection(
      SUBJECT,
      false,
      { executionMode: 'garbage' } as unknown as Record<string, unknown>,
      makePorts('paper'),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.injection.ownerMode).toBe('paper');
  });

  it('agent subject: absent injected mode falls back to the port (back-compat)', async () => {
    const res = await resolveSubjectInjection(
      SUBJECT,
      false,
      { config: { execution: { mode: 'paper' } } },
      makePorts('shadow'),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.injection.ownerMode).toBe('shadow');
  });

  it('agent subject: absent port still falls back to safe paper', async () => {
    const res = await resolveSubjectInjection(SUBJECT, false, {}, ports({
      listVenueAccountsByOwner: async () => [{ id: 'va-1', venue: 'hyperliquid' }],
    }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.injection.ownerMode).toBe('paper');
  });

  it('user subject: unaffected by the port — requested payload mode is authoritative', async () => {
    const res = await resolveSubjectInjection(
      { ownerId: 'owner-1', actor: { type: 'user', id: 'user-1' } },
      false,
      { config: { execution: { mode: 'shadow' } } },
      makePorts('paper'),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.injection.ownerMode).toBe('shadow');
  });
});

describe('buildResolverPorts — default venue account policy (oldest by created_at)', () => {
  /** Minimal fake over the drizzle select/from/where/orderBy/limit chain the port uses.
   *  `result` is what limit() resolves to (the fake db is not a real query engine —
   *  the chain shape is what matters; real SQL correctness is exercised by the
   *  integration suite). */
  function fakeDbResolving(result: Array<{ id: string }>): ResolverPortsDeps['db'] {
    return {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => Promise.resolve(result),
            }),
          }),
        }),
      }),
    } as unknown as ResolverPortsDeps['db'];
  }

  function wiredWith(db: ResolverPortsDeps['db'], mode: 'paper' | 'shadow' | 'live' = 'shadow') {
    return buildResolverPorts({
      db,
      appConfig: { execution: { defaultOwnerMode: mode } } as ResolverPortsDeps['appConfig'],
      getBotById: async () => null,
    });
  }

  it('returns the id the (oldest-first) db query yields', async () => {
    // The production port orders by created_at ASC, id ASC and takes limit 1;
    // the fake stands in for the engine and returns the "oldest" row.
    const portsWired = wiredWith(fakeDbResolving([{ id: 'va-old' }]));
    await expect(portsWired.getDefaultVenueAccountId!('owner-1')).resolves.toBe('va-old');
  });

  it('getDefaultOwnerMode returns the operator knob value', () => {
    const portsWired = wiredWith(fakeDbResolving([]), 'live');
    expect(portsWired.getDefaultOwnerMode!('owner-1')).toBe('live');
  });

  it('getDefaultVenueAccountId resolves undefined when the owner has no accounts', async () => {
    const portsWired = wiredWith(fakeDbResolving([]));
    await expect(portsWired.getDefaultVenueAccountId!('owner-1')).resolves.toBeUndefined();
  });
});

describe('resolveSubjectInjection — skipVenueResolution short-circuit', () => {
  it('short-circuits to a minimal injection (ownerId + actorId; empty venue coords)', async () => {
    const res = await resolveSubjectInjection(SUBJECT, true, { symbol: 'BTC' }, ports());
    expect(res).toEqual({ ok: true, injection: MINIMAL_INJECTION });
  });

  // A3: the risk spec rides the read calls too (get_risk_limits /
  // get_account_summary are read-only → the skip path) — the resolver must
  // extract it onto the injection so the context factory binds the ops via the
  // single RiskSource seam.
  it('attaches the agentRiskSpec on the skip path when the payload carries the spec', async () => {
    const res = await resolveSubjectInjection(
      SUBJECT,
      true,
      {
        capital: '1000',
        riskPosture: { maxOpenPositions: 3 },
        riskOverrides: { maxDrawdownPct: 5 },
      },
      ports(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.injection.agentRiskSpec).toEqual({
        capital: '1000',
        riskPosture: { maxOpenPositions: 3 },
        riskOverrides: { maxDrawdownPct: 5 },
      });
    }
  });

  it('omits agentRiskSpec on the skip path when the payload carries none', async () => {
    const res = await resolveSubjectInjection(SUBJECT, true, {}, ports());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.injection.agentRiskSpec).toBeUndefined();
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
