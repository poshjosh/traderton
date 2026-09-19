// A3 tests — end-to-end read parity + typed fail-closed write, over the
// boundary app (`app.inject`, no network). Real copied tools are registered;
// the context factory binds `riskContractOps` behind the RiskSource seam the
// same way bin.ts does (payload spec → RiskSource → buildRiskContractOps
// FromRiskSource). Proves:
//   1. `get_risk_limits` with an attached spec returns REAL contract fields
//      (capital-derived provenance) — the same composite shape the in-process
//      tool builds.
//   2. `get_risk_limits` WITHOUT a spec → `precondition.not_ready` (the
//      context factory throws; the dispatcher maps it).
//   3. `adjust_risk_limits` fails CLOSED with a typed `precondition.not_ready`
//      (A8's split assertion: reads work AND the write fails typed).
//   4. get_account_summary keeps its graceful degrade shape when the spec is
//      absent, and populates riskLimits/capital-derived warnings with one.

import { describe, it, expect, beforeEach } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import type { TradingToolContext } from '@traderton/domain';
import type { AgentRiskDefaultsConfig } from '@traderton/domain';
import {
  ToolRegistry,
  accountTools,
  riskLimitsTools,
  buildRiskContractOpsFromRiskSource,
  riskSourceIsEmpty,
  type RiskSource,
} from '@traderton/worker';
import { createBoundaryApp } from './app.js';
import type { BoundaryConfig } from './config.js';
import type { TradingToolContextFactory, BoundaryInvocationStore, ContextFactoryRequest } from './dispatcher.js';

const CONSUMER_ID = 'consumerA';
const KEY_ID = 'current';
const SECRET = 'test-signing-secret';
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const INVOKE_PATH = '/internal/v1/tools:invoke';

const CONFIG: BoundaryConfig = {
  clockSkewMs: 30_000,
  allowedConsumers: { [CONSUMER_ID]: { keyId: KEY_ID, secret: SECRET } },
};

const AGENT_RISK_DEFAULTS = {
  maxOpenPositions: 10,
  maxPositionSizePct: 100,
  stopLossPct: 10,
  stopLossCooldownMs: 300_000,
  maxDrawdownPct: 20,
  dailyMaxLossPct: 20,
  maxOrderNotionalMultiplier: 1,
} as AgentRiskDefaultsConfig;

const SPEC = {
  capital: '1000',
  riskPosture: { maxOpenPositions: 3, stopLossPct: 5, dailyMaxLossPct: 20 },
  riskOverrides: { maxDrawdownPct: 5 },
};

/** Build the ops from the payload spec exactly as bin.ts does (the seam). */
function riskSourceFromPayload(payload: unknown): RiskSource | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  const capital = typeof p['capital'] === 'string' ? p['capital'] : undefined;
  const riskPosture = (p['riskPosture'] && typeof p['riskPosture'] === 'object') ? p['riskPosture'] as RiskSource['riskPosture'] : undefined;
  const riskOverrides = (p['riskOverrides'] && typeof p['riskOverrides'] === 'object') ? p['riskOverrides'] as RiskSource['riskOverrides'] : undefined;
  const source: RiskSource = {
    capital: capital ?? null,
    riskPosture: riskPosture ?? null,
    riskOverrides: riskOverrides ?? {},
  };
  return riskSourceIsEmpty(source) ? undefined : source;
}

function makeContextFactory(opts: { withSpec: boolean }): TradingToolContextFactory {
  return async (request: ContextFactoryRequest): Promise<TradingToolContext> => {
    const source = opts.withSpec ? riskSourceFromPayload(request.payload) : undefined;
    const riskContractOps = source
      ? buildRiskContractOpsFromRiskSource({ agentRiskDefaults: AGENT_RISK_DEFAULTS, source })
      : undefined;
    if (request.toolName === 'get_risk_limits' && !riskContractOps) {
      throw new Error('risk context unavailable: the consumer did not attach a risk spec to this invocation');
    }
    return {
      agentId: request.actor.id,
      sessionId: `boundary:${request.ownerId}`,
      ownerId: request.ownerId,
      executionMode: 'paper',
      authorizationMode: 'direct',
      redis: {
        hset: async () => 1, hget: async () => null, hgetall: async () => ({}),
        hdel: async () => 1, publish: async () => 1, blpop: async () => null,
        smembers: async () => [], sadd: async () => 1, srem: async () => 1, expire: async () => 1,
      } as unknown as TradingToolContext['redis'],
      publishToInbound: async () => {},
      riskContractOps,
      // get_account_summary hard-requires botRepo (its positions read) — bin.ts
      // supplies the real repo in production; here a stub with empty positions.
      botRepo: {
        getOpenPositionsByCreator: async () => [],
        getAnalyticsByCreator: async () => ({
          realizedPnlUsd: '0', botCount: 0, openPositions: 0, closedPositions: 0,
          winningPositions: 0, totalFeesUsd: '0', recentFills: 0, avgHoldTimeHours: null, byBot: [],
        }),
      } as unknown as TradingToolContext['botRepo'],
      agentRepo: source ? {
        getAgent: async () => ({ capital: source.capital, risk: (source.riskPosture ?? null) as Record<string, unknown> | null }),
      } as unknown as TradingToolContext['agentRepo'] : undefined,
      executionConfig: {
        getExecutionConfig: async () => ({ mode: 'paper', positionSizeMode: null, fixedPositionSize: null }),
      },
    };
  };
}

const FAKE_STORE: BoundaryInvocationStore = {
  beginOrResolve: async () => ({ state: 'started' }) as Awaited<ReturnType<BoundaryInvocationStore['beginOrResolve']>>,
  complete: async () => {},
  findByRequestId: async () => null,
} as unknown as BoundaryInvocationStore;

function buildApp(opts: { withSpec: boolean }) {
  const registry = new ToolRegistry();
  for (const tool of [...riskLimitsTools, ...accountTools]) registry.register(tool);
  return createBoundaryApp({
    config: CONFIG,
    registry,
    contextFactory: makeContextFactory(opts),
    invocationStore: FAKE_STORE,
    computeRequestFingerprint: (r) =>
      createHash('sha256').update(JSON.stringify([r.consumerId, r.toolName, r.ownerId, r.payload])).digest('hex'),
    retentionMs: 3_600_000,
    now: () => NOW,
  });
}

let seq = 0;
async function invoke(toolName: string, payload: unknown): Promise<{ status: number; outcome: Record<string, unknown> }> {
  const app = appRef!;
  const envelope = {
    contractVersion: '1.0',
    requestId: `req-${++seq}`,
    idempotencyKey: `idem-${seq}`,
    correlationId: `corr-${seq}`,
    issuedAt: new Date(NOW).toISOString(),
    deadlineAt: new Date(NOW + 30_000).toISOString(),
    caller: { consumerId: CONSUMER_ID, keyId: KEY_ID },
    subject: { ownerId: 'owner-1', actor: { type: 'agent', id: 'agent-1' } },
    toolName,
    payload: payload ?? {},
  };
  const rawBody = JSON.stringify(envelope);
  const timestamp = new Date(NOW).toISOString();
  const bodyHash = createHash('sha256').update(Buffer.from(rawBody, 'utf8')).digest('hex');
  const canonical = `POST\n${INVOKE_PATH}\n${timestamp}\n${bodyHash}`;
  const sig = 'sha256=' + createHmac('sha256', SECRET).update(canonical).digest('hex');
  const res = await app.inject({
    method: 'POST',
    url: INVOKE_PATH,
    headers: {
      'content-type': 'application/json',
      'x-traderton-consumer-id': CONSUMER_ID,
      'x-traderton-key-id': KEY_ID,
      'x-traderton-timestamp': timestamp,
      'x-traderton-signature': sig,
      'x-request-deadline-at': new Date(NOW + 30_000).toISOString(),
    },
    payload: rawBody,
  });
  return { status: res.statusCode, outcome: (res.json() as Record<string, unknown>)['outcome'] as Record<string, unknown> };
}

let appRef: ReturnType<typeof buildApp> | null = null;

describe('A3 — boundary risk/account reads over the RiskSource seam', () => {
  beforeEach(() => {
    appRef = null;
  });

  it('get_risk_limits with an attached spec returns real contract fields (read parity)', async () => {
    const app = buildApp({ withSpec: true });
    appRef = app;
    const { status, outcome } = await invoke('get_risk_limits', SPEC);
    expect(status).toBe(200);
    expect(outcome['kind']).toBe('success');
    const data = outcome['payload'] as Record<string, unknown>;
    // Creator-posture values win with provenance — real contract math, not stubs.
    expect(data['limits']['maxOpenPositions']).toMatchObject({ value: 3, source: 'user', mutable: false, ceiling: 10 });
    expect(data['limits']['stopLossPct']).toMatchObject({ value: 5, source: 'user', mutable: false, ceiling: 10 });
    // The override caps under the ceiling with agent_override provenance.
    expect(data['limits']['maxDrawdownPct']).toMatchObject({ value: 5, source: 'agent_override', mutable: true, ceiling: 20 });
    // Runtime snapshot is composed (no botRepo over the boundary → daily loss '0').
    const runtime = data['runtime'] as Record<string, unknown>;
    const dailyLoss = runtime['dailyLoss'] as Record<string, unknown>;
    expect(dailyLoss['current']).toBe('0');
    // Daily-loss limit derived from the spec's capital × agentRepo-declared posture.
    expect(dailyLoss['limit']).toBe('200'); // 1000 × 20%
  });

  it('get_risk_limits WITHOUT a spec → precondition.not_ready (typed, not silent)', async () => {
    const app = buildApp({ withSpec: true });
    appRef = app;
    const { status, outcome } = await invoke('get_risk_limits', {});
    expect(status).toBe(200);
    expect(outcome['kind']).toBe('failure');
    expect(outcome['code']).toBe('precondition.not_ready');
  });

  it('get_risk_limits when the factory never sees a spec (withSpec=false) → precondition.not_ready', async () => {
    const app = buildApp({ withSpec: false });
    appRef = app;
    const { outcome } = await invoke('get_risk_limits', {});
    expect(outcome['kind']).toBe('failure');
    expect(outcome['code']).toBe('precondition.not_ready');
  });

  it('adjust_risk_limits fails CLOSED with a typed precondition — no write, no silent pass (A8 split)', async () => {
    const app = buildApp({ withSpec: true });
    appRef = app;
    const { outcome } = await invoke('adjust_risk_limits', { maxOpenPositions: 4, ...SPEC });
    expect(outcome['kind']).toBe('failure');
    expect(outcome['code']).toBe('precondition.not_ready');
    expect(String(outcome['message'])).toContain('B1');
  });

  it('get_account_summary with a spec populates riskLimits + capital from the same seam', async () => {
    const app = buildApp({ withSpec: true });
    appRef = app;
    const { outcome } = await invoke('get_account_summary', SPEC);
    expect(outcome['kind']).toBe('success');
    const data = outcome['payload'] as Record<string, unknown>;
    expect(data['capital']).toBe('1000');
    expect(data['capitalAvailable']).toBe(true);
    const riskLimits = data['riskLimits'] as Record<string, unknown>;
    expect(riskLimits['maxOpenPositions']).toBe(3);
    expect(riskLimits['maxOpenPositionsSource']).toBe('user');
  });

  it('get_account_summary WITHOUT a spec keeps the graceful warnings degrade', async () => {
    const app = buildApp({ withSpec: false });
    appRef = app;
    const { outcome } = await invoke('get_account_summary', {});
    expect(outcome['kind']).toBe('success');
    const data = outcome['payload'] as Record<string, unknown>;
    expect(data['capital']).toBeNull();
    expect(data['riskLimits']).toBe('unavailable');
    const warnings = data['warnings'] as string[];
    expect(warnings).toContain('risk_contract_unavailable');
  });
});
