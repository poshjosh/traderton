import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import type { Database } from './index.js';
import {
  AgentTradingProfileRepository,
  TradingProfileOperationConflictError,
} from './agent-trading-profile-repository.js';
import { openTestDb, truncate, type TestDb } from './test-helpers/integration-db.js';

const SKIP = !process.env['DATABASE_URL'];

describe.skipIf(SKIP)('AgentTradingProfileRepository (integration)', () => {
  let client: ReturnType<typeof postgres>;
  let db: TestDb;
  let repo: AgentTradingProfileRepository;

  const action = (actionId: string, venueAccountId: string, capital: string | null, kind: 'set' | 'clear' = 'set') => ({
    actionId,
    kind,
    venueAccountId,
    capital,
    riskPosture: null,
    executionDefaults: kind === 'set' ? { mode: 'paper' as const } : null,
  });

  beforeAll(() => {
    const handle = openTestDb();
    client = handle.client;
    db = handle.db;
    repo = new AgentTradingProfileRepository(db as unknown as Database);
  });

  afterAll(async () => client.end());

  beforeEach(async () => truncate(client, 'agent_trading_profile_changes', 'agent_trading_profiles'));

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
});