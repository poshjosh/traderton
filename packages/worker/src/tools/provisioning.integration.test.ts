import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { TradingToolContext } from '@traderton/domain';
import { createDatabase, closeDatabase, userCredentials, venueAccounts, type Database } from '@traderton/db';
import { decryptCredential } from '../crypto.js';
import { provisioningTools } from './provisioning.js';

/**
 * DATABASE_URL-gated integration test (L3-P1). Skips locally; runs against real
 * Postgres when DATABASE_URL is set — same pattern as the F2a
 * boundary-invocations integration test. Migrations are applied by
 * scripts/run-integration.sh before the gated suite runs.
 *
 * Proves the real provisioning path: `provision_venue_account` creates a real
 * `user_credentials` row + a linked `venue_accounts` row, and the persisted
 * `encrypted_data` is NOT the plaintext secret (encrypt-at-rest) — it decrypts
 * back to the canonicalized secrets with the configured key.
 */
const SKIP = !process.env['DATABASE_URL'];
const ENCRYPTION_KEY = 'a'.repeat(64);
const OWNER_ID = 'owner-l3p1-integration';

const provisionTool = provisioningTools.find((t) => t.name === 'provision_venue_account')!;

describe.skipIf(SKIP)('provision_venue_account (integration)', () => {
  let db: Database;

  function makeCtx(): TradingToolContext {
    return {
      agentId: 'agent-1',
      sessionId: 'session-1',
      ownerId: OWNER_ID,
      executionMode: 'paper',
      authorizationMode: 'direct',
      redis: {} as unknown as TradingToolContext['redis'],
      publishToInbound: async () => {},
      db,
    };
  }

  beforeAll(() => {
    const url = process.env['DATABASE_URL']!;
    db = createDatabase(url);
    process.env['CREDENTIAL_ENCRYPTION_KEY'] = ENCRYPTION_KEY;
  }, 30_000);

  afterAll(async () => {
    await closeDatabase(db);
  });

  beforeEach(async () => {
    // Clean any prior rows for this test owner (venue_accounts first — FK RESTRICT).
    await db.delete(venueAccounts).where(eq(venueAccounts.ownerId, OWNER_ID));
    await db.delete(userCredentials).where(eq(userCredentials.ownerId, OWNER_ID));
  });

  it('creates real rows and stores the credential encrypted (not plaintext)', async () => {
    const secrets = {
      apiKey: 'real-secret-key',
      secret: 'real-secret-value',
      walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };

    const res = await provisionTool.execute(
      { venue: 'hyperliquid', label: 'integration-key', secrets },
      makeCtx(),
    );

    expect(res.success).toBe(true);
    const venueAccountId = (res.data as { venueAccountId: string }).venueAccountId;
    expect(venueAccountId).toBeDefined();

    // The venue account row exists, owner-keyed, linked to a credential.
    const [account] = await db.select().from(venueAccounts).where(eq(venueAccounts.id, venueAccountId));
    expect(account).toBeDefined();
    expect(account!.ownerId).toBe(OWNER_ID);
    expect(account!.venue).toBe('hyperliquid');
    expect(account!.credentialId).toBeTruthy();

    // The credential row exists, owner-keyed, encrypted at rest.
    const [cred] = await db.select().from(userCredentials).where(eq(userCredentials.id, account!.credentialId!));
    expect(cred).toBeDefined();
    expect(cred!.ownerId).toBe(OWNER_ID);
    expect(cred!.provider).toBe('hyperliquid');

    // encrypted_data is NOT the plaintext secret.
    expect(cred!.encryptedData).not.toContain('real-secret-key');
    expect(cred!.encryptedData).not.toContain('real-secret-value');

    // But decrypts back to the canonicalized secrets with the configured key.
    const decrypted = JSON.parse(decryptCredential(cred!.encryptedData, ENCRYPTION_KEY));
    expect(decrypted).toEqual(secrets);
  });
});
