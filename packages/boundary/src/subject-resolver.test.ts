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
      { botId: 'bot-1' },
      ports({ getBotById: async () => ({ ...BOT, ownerId: 'other-owner' }) }),
    );
    expect(res).toEqual({ ok: false, code: 'authorization.denied', message: 'bot not owned by subject' });
  });

  it('rejects a missing bot with precondition.not_ready', async () => {
    const res = await resolveSubjectInjection(SUBJECT, 'write-database', { botId: 'gone' }, ports());
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
    const res = await resolveSubjectInjection(SUBJECT, 'execute-trade', {}, ports());
    expect(res).toEqual({ ok: false, code: 'precondition.not_ready', message: 'no venue account for owner' });
  });

  it('refuses when multiple accounts exist and no operator default is configured', async () => {
    const res = await resolveSubjectInjection(
      SUBJECT,
      'execute-trade',
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
