import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import type { CreatorStrategy } from '@traderton/domain';
import type { Database } from './index.js';
import {
  AgentTradingProfileRepository,
  TradingProfileOperationConflictError,
} from './agent-trading-profile-repository.js';
import { venueAccounts } from './schema/index.js';
import { openTestDb, truncate, type TestDb } from './test-helpers/integration-db.js';

const SKIP = !process.env['DATABASE_URL'];

describe.skipIf(SKIP)('AgentTradingProfileRepository (integration)', () => {
  let client: ReturnType<typeof postgres>;
  let db: TestDb;
  let repo: AgentTradingProfileRepository;

  // A forward action. Scan fields follow the T1 encoding: a key ABSENT from
  // `extra` is OMITTED (meaning "unchanged"); an explicit value (including null,
  // meaning "clear") is passed through. A `clear` action carries explicit nulls.
  const action = (
    actionId: string,
    venueAccountId: string,
    capital: string | null,
    kind: 'set' | 'clear' = 'set',
    extra: { scanMode?: 'scanner_gated' | 'mixed' | null; creatorStrategy?: CreatorStrategy | null } = {},
  ) => ({
    actionId,
    kind,
    venueAccountId,
    capital,
    riskPosture: null,
    executionDefaults: kind === 'set' ? { mode: 'paper' as const } : null,
    ...(kind === 'clear'
      ? { scanMode: null, creatorStrategy: null }
      : {
          ...('scanMode' in extra ? { scanMode: extra.scanMode } : {}),
          ...('creatorStrategy' in extra ? { creatorStrategy: extra.creatorStrategy } : {}),
        }),
  });

  const seedVenueAccount = async (id: string, ownerId: string, venue = 'hyperliquid') =>
    db.insert(venueAccounts).values({ id, ownerId, venue, label: `${venue} test` }).onConflictDoNothing();

  beforeAll(() => {
    const handle = openTestDb();
    client = handle.client;
    db = handle.db;
    repo = new AgentTradingProfileRepository(db as unknown as Database);
  });

  afterAll(async () => client.end());

  beforeEach(async () => truncate(client, 'agent_trading_profile_changes', 'agent_trading_profiles', 'venue_accounts'));

  it('isolates profiles by both signed owner and actor when they share a venue account', async () => {
    await repo.applyOperation({ ownerId: 'owner-a', actorId: 'agent-a', operationId: 'op-a', actions: [action('a', 'venue-1', '100')] });
    await repo.applyOperation({ ownerId: 'owner-a', actorId: 'agent-b', operationId: 'op-b', actions: [action('b', 'venue-1', '200')] });
    await repo.applyOperation({ ownerId: 'owner-b', actorId: 'agent-a', operationId: 'op-c', actions: [action('c', 'venue-1', '300')] });

    await expect(repo.getByOwnerActorVenueAccount('owner-a', 'agent-a', 'venue-1')).resolves.toMatchObject({ capital: '100' });
    await expect(repo.getByOwnerActorVenueAccount('owner-a', 'agent-b', 'venue-1')).resolves.toMatchObject({ capital: '200' });
    await expect(repo.getByOwnerActorVenueAccount('owner-b', 'agent-a', 'venue-1')).resolves.toMatchObject({ capital: '300' });
  });

  it('replays a multi-action operation, rejects manifest conflicts, and restores every preimage on rollback', async () => {
    await repo.applyOperation({ ownerId: 'owner-a', actorId: 'agent-a', operationId: 'seed-a', actions: [action('seed-a', 'venue-a', '100')] });
    await repo.applyOperation({ ownerId: 'owner-a', actorId: 'agent-a', operationId: 'seed-b', actions: [action('seed-b', 'venue-b', '200')] });
    const actions = [action('replace-a', 'venue-a', '150'), action('clear-b', 'venue-b', null, 'clear')];

    await repo.applyOperation({ ownerId: 'owner-a', actorId: 'agent-a', operationId: 'change', actions });
    await repo.applyOperation({ ownerId: 'owner-a', actorId: 'agent-a', operationId: 'change', actions });
    await expect(repo.applyOperation({ ownerId: 'owner-a', actorId: 'agent-a', operationId: 'change', actions: [action('replace-a', 'venue-a', '999')] }))
      .rejects.toBeInstanceOf(TradingProfileOperationConflictError);
    await repo.rollbackChange('owner-a', 'agent-a', 'change');

    await expect(repo.getByOwnerActorVenueAccount('owner-a', 'agent-a', 'venue-a')).resolves.toMatchObject({ capital: '100' });
    await expect(repo.getByOwnerActorVenueAccount('owner-a', 'agent-a', 'venue-b')).resolves.toMatchObject({ capital: '200' });
  });

  it('preserves agent risk overrides when a reconciliation snapshot replaces profile fields', async () => {
    await repo.applyOperation({ ownerId: 'owner-a', actorId: 'agent-a', operationId: 'seed', actions: [action('seed', 'venue-a', '100')] });
    await repo.replaceRiskOverrides({ ownerId: 'owner-a', actorId: 'agent-a', venueAccountId: 'venue-a', riskOverrides: { maxOpenPositions: 3 } });
    await repo.applyOperation({ ownerId: 'owner-a', actorId: 'agent-a', operationId: 'replace', actions: [action('replace', 'venue-a', '250')] });

    await expect(repo.getByOwnerActorVenueAccount('owner-a', 'agent-a', 'venue-a')).resolves.toMatchObject({
      capital: '250',
      riskOverrides: { maxOpenPositions: 3 },
    });
  });

  it('keeps the active strategy when an unchanged creator strategy is resent', async () => {
    await seedVenueAccount('venue-s', 'owner-a');
    const creatorStrategy: CreatorStrategy = { presetKey: 'momentum', styleTier: 'standard' };
    await repo.applyOperation({
      ownerId: 'owner-a', actorId: 'agent-a', operationId: 'first',
      actions: [action('first', 'venue-s', '100', 'set', { scanMode: 'scanner_gated', creatorStrategy })],
    });
    const afterFirst = await repo.getByOwnerActorVenueAccount('owner-a', 'agent-a', 'venue-s');
    const firstActive = afterFirst?.activeStrategy;
    expect(firstActive).toBeTruthy();
    expect(firstActive?.presetKey).toBe('momentum');

    // Resend the SAME creator strategy while only capital changes.
    await repo.applyOperation({
      ownerId: 'owner-a', actorId: 'agent-a', operationId: 'resend',
      actions: [action('resend', 'venue-s', '250', 'set', { scanMode: 'scanner_gated', creatorStrategy })],
    });
    const afterResend = await repo.getByOwnerActorVenueAccount('owner-a', 'agent-a', 'venue-s');

    expect(afterResend?.capital).toBe('250');
    // active_strategy is byte-identical — not re-resolved, so changedAt is unchanged.
    expect(afterResend?.activeStrategy).toEqual(firstActive);
  });

  it('resets the active strategy when the creator changes their strategy', async () => {
    await seedVenueAccount('venue-c', 'owner-a');
    await repo.applyOperation({
      ownerId: 'owner-a', actorId: 'agent-a', operationId: 'first',
      actions: [action('first', 'venue-c', '100', 'set', {
        scanMode: 'scanner_gated', creatorStrategy: { presetKey: 'momentum', styleTier: 'standard' },
      })],
    });
    const afterFirst = await repo.getByOwnerActorVenueAccount('owner-a', 'agent-a', 'venue-c');
    expect(afterFirst?.activeStrategy?.presetKey).toBe('momentum');

    // Creator switches to a different preset → active strategy is re-resolved.
    await repo.applyOperation({
      ownerId: 'owner-a', actorId: 'agent-a', operationId: 'change',
      actions: [action('change', 'venue-c', '100', 'set', {
        scanMode: 'scanner_gated', creatorStrategy: { presetKey: 'range', styleTier: 'standard' },
      })],
    });
    const afterChange = await repo.getByOwnerActorVenueAccount('owner-a', 'agent-a', 'venue-c');

    expect(afterChange?.activeStrategy?.presetKey).toBe('range');
    expect(afterChange?.activeStrategy?.source).toBe('creator');
    expect(afterChange?.creatorStrategy).toEqual({ presetKey: 'range', styleTier: 'standard' });
  });

  it('leaves the active strategy untouched when scan fields are absent on resend', async () => {
    await seedVenueAccount('venue-abs', 'owner-a');
    await repo.applyOperation({
      ownerId: 'owner-a', actorId: 'agent-a', operationId: 'first',
      actions: [action('first', 'venue-abs', '100', 'set', {
        scanMode: 'scanner_gated', creatorStrategy: { presetKey: 'momentum', styleTier: 'standard' },
      })],
    });
    const afterFirst = await repo.getByOwnerActorVenueAccount('owner-a', 'agent-a', 'venue-abs');

    // Old caller: no scanMode/creatorStrategy. Stored strategy must survive.
    await repo.applyOperation({
      ownerId: 'owner-a', actorId: 'agent-a', operationId: 'bare',
      actions: [action('bare', 'venue-abs', '300')],
    });
    const afterBare = await repo.getByOwnerActorVenueAccount('owner-a', 'agent-a', 'venue-abs');

    expect(afterBare?.capital).toBe('300');
    expect(afterBare?.scanMode).toBe('scanner_gated');
    expect(afterBare?.creatorStrategy).toEqual({ presetKey: 'momentum', styleTier: 'standard' });
    expect(afterBare?.activeStrategy).toEqual(afterFirst?.activeStrategy);
  });

  it('omitted scanMode and creatorStrategy preserve the stored values', async () => {
    await seedVenueAccount('venue-om', 'owner-a');
    await repo.applyOperation({
      ownerId: 'owner-a', actorId: 'agent-a', operationId: 'seed',
      actions: [action('seed', 'venue-om', '100', 'set', {
        scanMode: 'mixed', creatorStrategy: { presetKey: 'momentum', styleTier: 'standard' },
      })],
    });

    // Keys omitted → unchanged.
    await repo.applyOperation({
      ownerId: 'owner-a', actorId: 'agent-a', operationId: 'bare',
      actions: [action('bare', 'venue-om', '200')],
    });
    const after = await repo.getByOwnerActorVenueAccount('owner-a', 'agent-a', 'venue-om');

    expect(after?.capital).toBe('200');
    expect(after?.scanMode).toBe('mixed');
    expect(after?.creatorStrategy).toEqual({ presetKey: 'momentum', styleTier: 'standard' });
  });

  it('explicit null scanMode clears the stored scan mode', async () => {
    await seedVenueAccount('venue-ns', 'owner-a');
    await repo.applyOperation({
      ownerId: 'owner-a', actorId: 'agent-a', operationId: 'seed',
      actions: [action('seed', 'venue-ns', '100', 'set', {
        scanMode: 'mixed', creatorStrategy: { presetKey: 'momentum', styleTier: 'standard' },
      })],
    });

    await repo.applyOperation({
      ownerId: 'owner-a', actorId: 'agent-a', operationId: 'clear-scan',
      actions: [action('clear-scan', 'venue-ns', '100', 'set', { scanMode: null })],
    });
    const after = await repo.getByOwnerActorVenueAccount('owner-a', 'agent-a', 'venue-ns');

    expect(after?.scanMode).toBeNull();
    // creatorStrategy was omitted → unchanged.
    expect(after?.creatorStrategy).toEqual({ presetKey: 'momentum', styleTier: 'standard' });
  });

  it('explicit null creatorStrategy clears creator and active strategy', async () => {
    await seedVenueAccount('venue-nc', 'owner-a');
    await repo.applyOperation({
      ownerId: 'owner-a', actorId: 'agent-a', operationId: 'seed',
      actions: [action('seed', 'venue-nc', '100', 'set', {
        scanMode: 'mixed', creatorStrategy: { presetKey: 'momentum', styleTier: 'standard' },
      })],
    });

    await repo.applyOperation({
      ownerId: 'owner-a', actorId: 'agent-a', operationId: 'clear-creator',
      actions: [action('clear-creator', 'venue-nc', '100', 'set', { creatorStrategy: null })],
    });
    const after = await repo.getByOwnerActorVenueAccount('owner-a', 'agent-a', 'venue-nc');

    expect(after?.creatorStrategy).toBeNull();
    expect(after?.activeStrategy).toBeNull();
    // scanMode omitted → unchanged.
    expect(after?.scanMode).toBe('mixed');
  });

  it('a replayed manifest with omitted scan fields does not raise an operation conflict', async () => {
    await seedVenueAccount('venue-rp', 'owner-a');
    const bare = [action('bare', 'venue-rp', '100')];

    // First apply persists the forward action (scan keys omitted → dropped by
    // jsonb). A replay reads it back and must compare equal.
    await repo.applyOperation({ ownerId: 'owner-a', actorId: 'agent-a', operationId: 'rp', actions: bare });
    await expect(
      repo.applyOperation({ ownerId: 'owner-a', actorId: 'agent-a', operationId: 'rp', actions: bare }),
    ).resolves.toBeInstanceOf(Map);
  });
});