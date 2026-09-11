import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TradingToolContext } from '@traderton/domain';
import { provisioningTools } from './provisioning.js';

/**
 * Tool-level tests for `provision_venue_account`.
 *
 * These adapt the copied credentials.test.ts / accounts.test.ts create-path
 * assertions (the parity oracle) into the tool shape: route → tool, JWT userId →
 * boundary-resolved `ctx.ownerId`. They keep the copied assertions: venue-secret
 * validation, alias canonicalization, the 1inch legacy-apiKey discard, the
 * Jupiter Solana `venueAccountRef` rule, credential↔venue linkage (implicit —
 * the credential is created in the same tx), encrypt-at-rest, and
 * no-secret-in-response.
 */

const OWNER_ID = 'owner-1';
const VALID_KEY = 'a'.repeat(64);

const provisionTool = provisioningTools.find((t) => t.name === 'provision_venue_account')!;

// Capture the rows inserted through the mocked db.transaction.
let credentialInsert: Record<string, unknown> | undefined;
let venueAccountInsert: Record<string, unknown> | undefined;
// Ordered capture of every insert's values, in call order — lets tests assert
// the credential→venue_account INSERT ORDER (FK ON DELETE RESTRICT requires it).
let insertOrder: Array<Record<string, unknown>>;

function buildMockDb(opts: { failInsert?: boolean } = {}) {
  credentialInsert = undefined;
  venueAccountInsert = undefined;
  insertOrder = [];
  let insertCall = 0;

  const tx = {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((v: Record<string, unknown>) => {
        if (opts.failInsert) {
          return Promise.reject(new Error('insert failed'));
        }
        insertOrder.push(v);
        // First insert = user_credentials, second = venue_accounts (tool order).
        if (insertCall === 0) {
          credentialInsert = v;
        } else {
          venueAccountInsert = v;
        }
        insertCall++;
        return Promise.resolve();
      }),
    }),
  };

  return {
    transaction: vi.fn().mockImplementation(async (fn: (innerTx: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as TradingToolContext['db'];
}

function makeCtx(overrides: Partial<TradingToolContext> = {}): TradingToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    ownerId: OWNER_ID,
    executionMode: 'paper',
    authorizationMode: 'direct',
    redis: {} as unknown as TradingToolContext['redis'],
    publishToInbound: vi.fn(async () => undefined),
    db: buildMockDb(),
    ...overrides,
  };
}

describe('provision_venue_account', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env['CREDENTIAL_ENCRYPTION_KEY'] = VALID_KEY;
  });

  // -- Context readiness --

  it('fails when db is unavailable', async () => {
    const ctx = makeCtx({ db: undefined });
    const res = await provisionTool.execute(
      { venue: 'bybit', label: 'x', secrets: { apiKey: 'k', secret: 's' } },
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('provision.db_unavailable');
  });

  it('fails when ownerId is unavailable', async () => {
    const ctx = makeCtx({ ownerId: undefined });
    const res = await provisionTool.execute(
      { venue: 'bybit', label: 'x', secrets: { apiKey: 'k', secret: 's' } },
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('provision.owner_unavailable');
  });

  // -- Happy path + owner-keying + encrypt-at-rest + no-secret-leak --

  it('creates credential + venue account (owner-keyed) and returns metadata only', async () => {
    const ctx = makeCtx();
    const res = await provisionTool.execute(
      {
        venue: 'hyperliquid',
        label: 'prod-key',
        secrets: { apiKey: 'secret-key', secret: 'secret-value', walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      },
      ctx,
    );

    expect(res.success).toBe(true);
    const data = res.data as Record<string, unknown>;
    expect(data.venueAccountId).toBeDefined();
    expect(data.venue).toBe('hyperliquid');
    expect(data.label).toBe('prod-key');

    // Both rows written under ownerId (userId → ownerId adapt).
    expect(credentialInsert?.ownerId).toBe(OWNER_ID);
    expect(credentialInsert?.provider).toBe('hyperliquid');
    expect(venueAccountInsert?.ownerId).toBe(OWNER_ID);
    expect(venueAccountInsert?.venue).toBe('hyperliquid');

    // INSERT ORDER: the credential row MUST be inserted before the venue-account
    // row — the FK (venue_accounts.credentialId → user_credentials, ON DELETE
    // RESTRICT) requires the referenced credential to exist first. Assert the
    // first insert carries the credential fields and the second references it.
    expect(insertOrder).toHaveLength(2);
    const [firstInsert, secondInsert] = insertOrder;
    expect(firstInsert?.encryptedData).toBeDefined();
    expect(firstInsert?.encryptionMeta).toBeDefined();
    expect(secondInsert?.credentialId).toBe(firstInsert?.id);
    expect(secondInsert?.encryptedData).toBeUndefined();

    // Credential linkage: venue account points at the newly created credential.
    expect(venueAccountInsert?.credentialId).toBe(credentialInsert?.id);

    // Encrypt-at-rest: the stored blob is not the plaintext secrets.
    const encrypted = credentialInsert?.encryptedData as string;
    expect(typeof encrypted).toBe('string');
    expect(encrypted).not.toContain('secret-key');
    expect(encrypted).not.toContain('secret-value');
    expect(credentialInsert?.encryptionMeta).toMatchObject({ algorithm: 'aes-256-gcm' });

    // No-secret-in-response: neither the result envelope nor the persisted rows
    // (other than the encrypted blob) contain the plaintext secrets.
    const envelope = JSON.stringify(res);
    expect(envelope).not.toContain('secret-key');
    expect(envelope).not.toContain('secret-value');
  });

  // -- Canonicalization (alias normalization) — copied parity assertion --

  it('normalizes aliased Hyperliquid secret names before encryption', async () => {
    const ctx = makeCtx();
    const res = await provisionTool.execute(
      {
        venue: 'hyperliquid',
        label: 'prod-key',
        secrets: {
          'api-key': 'secret-key',
          secret: 'secret-value',
          'account-address': '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        },
      },
      ctx,
    );

    expect(res.success).toBe(true);
    // The encrypted blob decrypts to the canonicalized shape; we assert indirectly
    // by decrypting with the known key.
    const { decryptCredential } = await import('../crypto.js');
    const decrypted = JSON.parse(decryptCredential(credentialInsert!.encryptedData as string, VALID_KEY));
    expect(decrypted).toEqual({
      apiKey: 'secret-key',
      secret: 'secret-value',
      // walletAddress normalization includes lowercase.
      walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
  });

  it('discards a legacy user-supplied 1inch apiKey before encryption', async () => {
    const ctx = makeCtx();
    const res = await provisionTool.execute(
      {
        venue: '1inch',
        label: 'base-wallet',
        secrets: {
          privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
          apiKey: 'legacy-user-api-key',
        },
      },
      ctx,
    );

    expect(res.success).toBe(true);
    const { decryptCredential } = await import('../crypto.js');
    const decrypted = JSON.parse(decryptCredential(credentialInsert!.encryptedData as string, VALID_KEY));
    expect(decrypted).toEqual({ privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' });
    expect(JSON.stringify(res)).not.toContain('legacy-user-api-key');
  });

  // -- Venue-secret validation — copied parity assertions --

  it('rejects Hyperliquid credential with empty walletAddress', async () => {
    const ctx = makeCtx();
    const res = await provisionTool.execute(
      { venue: 'hyperliquid', label: 'prod-key', secrets: { apiKey: 'key', secret: 'sec', walletAddress: '' } },
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.fault).toBe(false); // maps to validation.invalid_payload at the boundary
    expect(res.errorCode).toBe('credential.validation_error.required');
    expect(credentialInsert).toBeUndefined();
  });

  it('rejects Hyperliquid credential with malformed walletAddress', async () => {
    const ctx = makeCtx();
    const res = await provisionTool.execute(
      { venue: 'hyperliquid', label: 'prod-key', secrets: { apiKey: 'key', secret: 'sec', walletAddress: 'not-an-address' } },
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('credential.validation_error.invalid_wallet_address');
  });

  it('rejects Bybit credential with empty apiKey', async () => {
    const ctx = makeCtx();
    const res = await provisionTool.execute(
      { venue: 'bybit', label: 'bybit-main', secrets: { apiKey: '', secret: 'valid-secret' } },
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('credential.validation_error.required');
  });

  it('rejects 1inch credential with malformed privateKey', async () => {
    const ctx = makeCtx();
    const res = await provisionTool.execute(
      { venue: '1inch', label: 'base-wallet', secrets: { privateKey: 'not-a-private-key' } },
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('credential.validation_error.invalid_private_key');
  });

  it('creates Bybit credential successfully', async () => {
    const ctx = makeCtx();
    const res = await provisionTool.execute(
      { venue: 'bybit', label: 'bybit-main', secrets: { apiKey: 'bybit-key-123', secret: 'bybit-secret-456' } },
      ctx,
    );
    expect(res.success).toBe(true);
  });

  // -- Jupiter venueAccountRef (Solana wallet) rule — copied parity assertions --

  it('succeeds when jupiter provides a valid Solana wallet address', async () => {
    const ctx = makeCtx();
    const res = await provisionTool.execute(
      {
        venue: 'jupiter',
        label: 'Swap Wallet',
        secrets: { privateKey: 'signing-key' },
        venueAccountRef: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV',
      },
      ctx,
    );
    expect(res.success).toBe(true);
    expect(venueAccountInsert?.venueAccountRef).toBe('7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV');
  });

  it('rejects jupiter account without a wallet address', async () => {
    const ctx = makeCtx();
    const res = await provisionTool.execute(
      { venue: 'jupiter', label: 'Swap Wallet', secrets: { privateKey: 'signing-key' } },
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('account.validation_error.missing_venue_account_ref');
  });

  it('rejects jupiter account with an invalid Solana public key', async () => {
    const ctx = makeCtx();
    const resShort = await provisionTool.execute(
      { venue: 'jupiter', label: 'Swap Wallet', secrets: { privateKey: 'k' }, venueAccountRef: 'tooshort' },
      ctx,
    );
    expect(resShort.success).toBe(false);
    expect(resShort.errorCode).toBe('account.validation_error.invalid_venue_account_ref');

    const resHex = await provisionTool.execute(
      { venue: 'jupiter', label: 'Swap Wallet', secrets: { privateKey: 'k' }, venueAccountRef: '0x3419aabbccdd112233445566778899aabb112233' },
      ctx,
    );
    expect(resHex.success).toBe(false);
    expect(resHex.errorCode).toBe('account.validation_error.invalid_venue_account_ref');
  });

  // -- Encryption key custody --

  it('fails cleanly (never leaking secrets) when the encryption key is misconfigured', async () => {
    // Set a malformed-but-PRESENT key so getEncryptionKey()/encryptCredential
    // throws for a real reason (wrong length) rather than the key simply being
    // absent — this makes the no-leak assertion below meaningful.
    const MALFORMED_KEY = 'deadbeef';
    process.env['CREDENTIAL_ENCRYPTION_KEY'] = MALFORMED_KEY;
    const ctx = makeCtx();
    const res = await provisionTool.execute(
      { venue: 'bybit', label: 'x', secrets: { apiKey: 'secret-key', secret: 'secret-value' } },
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.fault).toBe(true);
    expect(res.errorCode).toBe('provision.encryption_unavailable');
    expect(credentialInsert).toBeUndefined();

    // No leak: neither the malformed key value nor any plaintext secret appears
    // anywhere in the returned result (including the error message).
    const envelope = JSON.stringify(res);
    expect(envelope).not.toContain(MALFORMED_KEY);
    expect(envelope).not.toContain('secret-key');
    expect(envelope).not.toContain('secret-value');
  });

  // -- Persistence failure --

  it('reports a persist failure when the transaction throws', async () => {
    const ctx = makeCtx({ db: buildMockDb({ failInsert: true }) });
    const res = await provisionTool.execute(
      { venue: 'bybit', label: 'x', secrets: { apiKey: 'k', secret: 's' } },
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('provision.persist_failed');
  });
});
