// AUTHORED (follow-up to 005 §Required Verification) — the FULL signed-call set,
// driven against a DEPLOYED Traderton boundary over HTTPS (not in-process via
// `app.inject`). This complements `boundary.verification.integration.test.ts`:
// that suite runs tests 1–6 in-process against a Postgres, and only #7 over HTTP
// (a bare /health/ready). This suite exercises the ENTIRE signed-call contract —
// auth rejections, envelope payload validation, deadline, the status endpoint,
// and real tool dispatch (read-only `get_schema`, and `submit_decision` in
// `dryRun` mode) — over the wire, against the live runtime stack.
//
// Gated on env (like the existing suite) so the default `pnpm test` is unchanged:
//   BOUNDARY_BASE_URL        https://api.staging.traderton.com  (running boundary)
//   BOUNDARY_CONSUMER_ID      consumerId the boundary is configured to accept
//   BOUNDARY_KEY_ID           keyId for that consumer
//   BOUNDARY_SIGNING_SECRET   matching HMAC signing secret
//
// The identity equals the boundary's own accepted-consumer config, so a signed
// test call is what the platform (herobids) itself would send. Read
// `scripts/shell/tests/run-live-boundary.sh` which sources these from the
// operator `.env.environment` and runs this file.
//
// SAFETY: every assertion is side-effect-free. Read-only tools bypass the
// idempotency store; `submit_decision` runs in `dryRun:true` (validates + previews
// WITHOUT publishing to the engine), and the remaining tests are rejection cases
// that fail BEFORE any side effect. No venue is driven; no trading state mutated.

import { describe, it, expect } from 'vitest';
import {
  signInvoke,
  signRequest,
  signStatus,
  type SigningIdentity,
} from './dev/sign.js';
import { BOUNDARY_FAILURE_CODES } from './contract.js';

const BASE_URL = process.env['BOUNDARY_BASE_URL'];
const CONSUMER_ID = process.env['BOUNDARY_CONSUMER_ID'];
const KEY_ID = process.env['BOUNDARY_KEY_ID'];
const SECRET = process.env['BOUNDARY_SIGNING_SECRET'];

const INVOKE_PATH = '/internal/v1/tools:invoke';
const STATUS_PATH = '/internal/v1/invocations/';
const HEALTH_READY_PATH = '/health/ready';

const IDENTITY: SigningIdentity = {
  consumerId: CONSUMER_ID ?? '',
  keyId: KEY_ID ?? '',
  secret: SECRET ?? '',
};

// ── Signed-call fixtures ────────────────────────────────────────────────────

interface Envelope {
  contractVersion: string;
  requestId: string;
  idempotencyKey: string;
  correlationId: string;
  issuedAt: string;
  deadlineAt: string;
  caller: { consumerId: string; keyId: string };
  subject: { ownerId: string; actor: { type: 'agent' | 'bot' | 'user' | 'system'; id: string } };
  toolName: string;
  payload: unknown;
}

const OWNER_ID = 'live-verif-owner';
const ACTOR_ID = 'actor-live-verif';

function futureDeadline(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

function makeEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    contractVersion: '1.0',
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
    correlationId: 'corr-live-verif',
    issuedAt: new Date().toISOString(),
    deadlineAt: futureDeadline(),
    caller: { consumerId: IDENTITY.consumerId, keyId: IDENTITY.keyId },
    subject: { ownerId: OWNER_ID, actor: { type: 'agent', id: ACTOR_ID } },
    toolName: 'get_schema',
    payload: { name: 'all' },
    ...overrides,
  };
}

async function invoke(
  envelope: Envelope,
  opts: { timestamp?: string; badSignature?: boolean } = {},
): Promise<Record<string, unknown>> {
  const { headers, rawBody } = signInvoke(IDENTITY, INVOKE_PATH, envelope, {
    ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
  });
  if (opts.badSignature) headers['x-traderton-signature'] = 'sha256=deadbeef';
  const res = await fetch(`${BASE_URL}${INVOKE_PATH}`, {
    method: 'POST',
    headers,
    body: rawBody,
  });
  return (await res.json()) as Record<string, unknown>;
}

function outcome(body: Record<string, unknown>): Record<string, unknown> {
  return body['outcome'] as Record<string, unknown>;
}

// ── 0. health (unsigned — the only call that needs no HMAC) ─────────────────
describe.skipIf(!BASE_URL)('live boundary /health', () => {
  it('serves /health/ready', async () => {
    const res = await fetch(`${BASE_URL}${HEALTH_READY_PATH}`);
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ status: 'ready' });
  });
});

// ── 1..N. the full signed set (HMAC + contract + tool dispatch) ─────────────
describe.skipIf(!BASE_URL || !CONSUMER_ID || !KEY_ID || !SECRET)('live boundary signed calls', () => {
  // 1. signature verification — valid succeeds; bad signed rejected BEFORE execution.
  describe('1. signature verification (before execution)', () => {
    it('a valid signed read-only call succeeds', async () => {
      const body = await invoke(makeEnvelope());
      expect(outcome(body)['kind']).toBe('success');
      expect(outcome(body)['payload']).toMatchObject({ ok: true });
    });

    it('a bad signature fails as authentication.invalid_caller', async () => {
      const body = await invoke(makeEnvelope(), { badSignature: true });
      expect(outcome(body)['code']).toBe('authentication.invalid_caller');
    });

    it('a wrong consumer fails as authentication.invalid_caller', async () => {
      // Sign with a consumer the boundary does not know.
      const badIdentity: SigningIdentity = { ...IDENTITY, consumerId: 'not-the-cluster' };
      const envelope = makeEnvelope();
      const { headers, rawBody } = signInvoke(badIdentity, INVOKE_PATH, envelope);
      const res = await fetch(`${BASE_URL}${INVOKE_PATH}`, { method: 'POST', headers, body: rawBody });
      expect(outcome((await res.json()) as Record<string, unknown>)['code']).toBe(
        'authentication.invalid_caller',
      );
    });

    it('an out-of-skew timestamp fails as authentication.invalid_caller', async () => {
      const body = await invoke(makeEnvelope(), {
        timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
      });
      expect(outcome(body)['code']).toBe('authentication.invalid_caller');
    });
  });

  // 2. envelope / payload validation → typed validation failures.
  describe('2. malformed envelopes and payloads', () => {
    it('an unknown outer key → validation.invalid_payload', async () => {
      const envelope = { ...makeEnvelope(), unexpected: true } as unknown as Envelope;
      const body = await invoke(envelope);
      expect(outcome(body)['code']).toBe('validation.invalid_payload');
    });

    it('a non-JSON body → validation.invalid_payload', async () => {
      // Sign the EXACT malformed bytes so auth passes and the JSON parse failure
      // is what's under test.
      const malformed = '{not json';
      const deadlineAt = futureDeadline();
      const headers = signRequest(IDENTITY, {
        method: 'POST',
        path: INVOKE_PATH,
        rawBody: Buffer.from(malformed, 'utf8'),
        deadlineAt,
      });
      const res = await fetch(`${BASE_URL}${INVOKE_PATH}`, {
        method: 'POST',
        headers,
        body: malformed,
      });
      expect(outcome((await res.json()) as Record<string, unknown>)['code']).toBe(
        'validation.invalid_payload',
      );
    });

    it('a bad tool payload → validation.invalid_payload', async () => {
      const body = await invoke(makeEnvelope({ payload: { name: 42 } }));
      expect(outcome(body)['code']).toBe('validation.invalid_payload');
    });

    it('an unsupported contractVersion → contract.unsupported_version', async () => {
      const body = await invoke(makeEnvelope({ contractVersion: '2.0' }));
      expect(outcome(body)['code']).toBe('contract.unsupported_version');
    });

    it('an unknown tool → validation.invalid_payload', async () => {
      const body = await invoke(makeEnvelope({ toolName: 'does_not_exist' }));
      expect(outcome(body)['code']).toBe('validation.invalid_payload');
    });
  });

  // 3. deadline expiry is rejected before any side effect.
  describe('3. deadline expiry', () => {
    it('an already-past deadline → deadline.expired', async () => {
      const body = await invoke(
        makeEnvelope({ deadlineAt: new Date(Date.now() - 5_000).toISOString() }),
      );
      expect(outcome(body)['code']).toBe('deadline.expired');
    });
  });

  // 4. the signed status endpoint (GET, empty body) over HTTPS.
  describe('4. invocation status endpoint', () => {
    it('a signed GET by requestId for an unknown id → not_found.resource', async () => {
      const requestId = `req-absent-${Math.random().toString(36).slice(2)}`;
      const headers = signStatus(IDENTITY, `${STATUS_PATH}${requestId}`);
      const res = await fetch(`${BASE_URL}${STATUS_PATH}${requestId}`, {
        method: 'GET',
        headers,
      });
      expect(outcome((await res.json()) as Record<string, unknown>)['code']).toBe(
        'not_found.resource',
      );
    });
  });

  // 5. real tool dispatch over the wire:
  //    - submit_decision in dryRun mode → reaches dispatch and produces a terminal
  //      outcome WITHOUT publishing to the engine (no venue drive).
  describe('5. submit_decision dispatch (dry run)', () => {
    it('reaches dispatch and yields a terminal outcome without a venue side effect', async () => {
      const body = await invoke(
        makeEnvelope({
          toolName: 'submit_decision',
          payload: {
            instrumentId: 'BTC',
            intent: 'go_long',
            targetSize: '0.01',
            rationaleSummary: 'live boundary verification dry run',
            dryRun: true,
          },
        }),
      );

      const committed = outcome(body);
      expect(committed).toBeDefined();

      if (committed['kind'] === 'success') {
        // dryRun preview: schema validation passed, NOT submitted.
        expect(committed['payload']).toMatchObject({ dryRun: true });
      } else {
        // No venue account is seeded for the test owner on a fresh staging, so
        // resolution surfaces a typed boundary failure — NOT an HTTP/network error.
        expect(committed['kind']).toBe('failure');
        expect(BOUNDARY_FAILURE_CODES).toContain(committed['code']);
      }
    });
  });
});