// Regression for bug 2026-11-21/002: `list_strategy_presets` and `change_strategy_preset`
// answered "preset assessment not available in this context" for every consumer call.
//
// Why: the boundary builds `presetAssessment` only for an agent subject whose request
// resolves a venue account, and the dispatcher forwards the Zod-PARSED payload, so a key the
// tool schema does not declare never reaches the subject resolver (same mechanism as bug
// 2026-09-17/001). `change_strategy_preset` did not declare `venueAccountId`; `list_strategy_presets`
// can never be given one, so it now reads the venue-independent `presetCatalog` instead.
//
// This drives the REAL preset tools through the REAL signed-request path (createBoundaryApp →
// dispatcher → Zod parse) and the REAL `resolveSubjectInjection`. Only the db ports and the
// preset-assessment seam are fakes. The context factory below applies the same two rules as
// `bin.ts`'s factory, by calling the same helpers (`skipsVenueResolution` and
// `canBuildPresetAssessment` in ./context-rules.ts), so it cannot drift from them:
// (1) skip venue resolution for read-only or `ownerScopedNoVenue` tools, (2) build
// `presetAssessment` only for an agent subject with a non-empty resolved `venueAccountId`.
// `presetCatalog` is always present, as in `bin.ts`. The rest of that factory (profile load,
// actor ensure, the real `presetAssessmentOps.buildContext`) is NOT exercised here.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import type { PresetEntry, TradingToolContext } from '@traderton/domain';
import { ToolRegistry, presetAssessmentTools } from '@traderton/worker';
import { createBoundaryApp } from './app.js';
import type { BoundaryConfig } from './config.js';
import { canBuildPresetAssessment, skipsVenueResolution } from './context-rules.js';
import type { BoundaryInvocationStore, TradingToolContextFactory } from './dispatcher.js';
import { resolveSubjectInjection, type SubjectResolverPorts } from './subject-resolver.js';

const CONSUMER_ID = 'consumerA';
const KEY_ID = 'current';
const SECRET = 'test-signing-secret';
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const INVOKE_PATH = '/internal/v1/tools:invoke';
const CONFIG: BoundaryConfig = {
  clockSkewMs: 30_000,
  idempotencyRetentionHours: 168,
  allowedConsumers: { [CONSUMER_ID]: { keyId: KEY_ID, secret: SECRET } },
};

const OWNER = 'owner-1';
const AGENT = 'agent-1';
const OWNED_ACCOUNT = { id: 'va-1', venue: 'hyperliquid' };
const OTHER_OWNERS_ACCOUNT_ID = 'va-of-someone-else';

const momentumPreset: PresetEntry = {
  name: 'Momentum — Day',
  description: 'Day-trend following',
  strategy: { type: 'momentum', decisionMode: 'mechanical', params: { signalBias: 'trend-following', indicators: {} } },
};

type PresetAssessmentCtx = NonNullable<TradingToolContext['presetAssessment']>;

/** A complete preset-assessment seam; `change_strategy_preset` only touches a few members. */
function makePresetAssessment(
  injection: { venueAccountId: string; venue: string },
  applyPresetChange: PresetAssessmentCtx['applyPresetChange'],
): PresetAssessmentCtx {
  return {
    config: {
      minRequestIntervalMs: 86_400_000,
      cacheFreshnessMs: 21_600_000,
      maxInstrumentsPerRequest: 3,
      minChangeCooldownMs: 86_400_000,
      preCheck: {
        signalRatioThreshold: 2.0,
        scanMetricsLookbackMs: 86_400_000,
        minSignalsForActive: 3,
        identityCooldownMs: 86_400_000,
        candidateMaxAgeMs: 86_400_000,
        policyVersion: '1.0.0',
        enablePeerComparison: true,
        reviewIntervalMs: 3_600_000,
      },
    },
    presetPolicy: { changesAllowed: true, allowedPresets: [], styleTier: 'standard' },
    activeStrategy: null,
    venue: injection.venue,
    venueType: 'orderbook',
    venueAccountId: injection.venueAccountId,
    executionMode: 'paper',
    listPresets: () => [{ key: 'momentum', entry: momentumPreset }],
    fetchCandles: vi.fn(async () => []),
    scoreCandidate: vi.fn(async () => ({ kind: 'in_progress' as const })),
    checkRegime: vi.fn(async () => ({ kind: 'in_progress' as const })),
    getVolatility: vi.fn(async () => ({ kind: 'in_progress' as const })),
    applyPresetChange,
    getArtifact: vi.fn(async () => ({
      id: 'artifact-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      presets: [],
      evidence: {},
      currentStrategy: {},
    })),
    persistAssessment: vi.fn(async () => undefined),
    findFreshArtifact: vi.fn(async () => null),
    latestCompletedRequest: vi.fn(async () => null),
  };
}

interface Harness {
  app: ReturnType<typeof createBoundaryApp>;
  applyPresetChange: ReturnType<typeof vi.fn>;
  catalogListPresets: ReturnType<typeof vi.fn>;
  /** The parsed payload the dispatcher handed the context factory, one entry per call. */
  factoryPayloads: unknown[];
  /** The `presetAssessment` seam each built context carried (undefined when not built). */
  builtPresetAssessments: Array<PresetAssessmentCtx | undefined>;
}

function buildHarness(venueAccountsOwned: Array<{ id: string; venue: string }> = [OWNED_ACCOUNT]): Harness {
  const registry = new ToolRegistry();
  for (const tool of presetAssessmentTools) registry.register(tool);

  const applyPresetChange = vi.fn(async () => ({ ok: true as const }));
  const catalogListPresets = vi.fn(() => [{ key: 'momentum', entry: momentumPreset }]);
  const factoryPayloads: unknown[] = [];
  const builtPresetAssessments: Array<PresetAssessmentCtx | undefined> = [];

  const ports: SubjectResolverPorts = {
    getBotById: async () => null,
    listVenueAccountsByOwner: async (ownerId) => (ownerId === OWNER ? venueAccountsOwned : []),
  };

  const contextFactory: TradingToolContextFactory = async (request) => {
    factoryPayloads.push(request.payload);
    const resolution = await resolveSubjectInjection(
      { ownerId: request.ownerId, actor: request.actor },
      skipsVenueResolution(registry.get(request.toolName)),
      request.payload,
      ports,
    );
    if (!resolution.ok) {
      throw new Error(`subject resolution failed: ${resolution.code}: ${resolution.message}`);
    }
    const injection = resolution.injection;
    const presetAssessment = canBuildPresetAssessment(request.actor.type, injection.venueAccountId)
      ? makePresetAssessment(injection, applyPresetChange)
      : undefined;
    builtPresetAssessments.push(presetAssessment);
    return {
      agentId: request.actor.id,
      sessionId: `s:${request.ownerId}`,
      ownerId: request.ownerId,
      executionMode: 'paper',
      authorizationMode: 'direct',
      redis: {} as TradingToolContext['redis'],
      publishToInbound: async () => {},
      presetCatalog: { listPresets: catalogListPresets },
      presetAssessment,
    } satisfies TradingToolContext;
  };

  const store: BoundaryInvocationStore = {
    async beginOrResolve() {
      return { kind: 'started', id: 'row-1' };
    },
    async complete() {},
    async findByRequestId() {
      return null;
    },
  };

  const app = createBoundaryApp({
    config: CONFIG,
    registry,
    contextFactory,
    invocationStore: store,
    computeRequestFingerprint: (input) => `fp:${input.consumerId}:${input.ownerId}:${input.toolName}`,
    retentionMs: 168 * 60 * 60 * 1000,
    now: () => NOW,
  });
  return { app, applyPresetChange, catalogListPresets, factoryPayloads, builtPresetAssessments };
}

let requestCounter = 0;

async function invoke(app: Harness['app'], toolName: string, payload: unknown) {
  requestCounter += 1;
  const envelope = {
    contractVersion: '1.0',
    requestId: `req-${requestCounter}`,
    idempotencyKey: `idem-${requestCounter}`,
    correlationId: `corr-${requestCounter}`,
    issuedAt: '2026-01-01T00:00:00.000Z',
    deadlineAt: '2026-01-01T00:00:30.000Z',
    caller: { consumerId: CONSUMER_ID, keyId: KEY_ID },
    subject: { ownerId: OWNER, actor: { type: 'agent', id: AGENT } },
    toolName,
    payload,
  };
  const rawBody = JSON.stringify(envelope);
  const timestamp = '2026-01-01T00:00:00.000Z';
  const bodyHash = createHash('sha256').update(Buffer.from(rawBody, 'utf8')).digest('hex');
  const signature = 'sha256=' + createHmac('sha256', SECRET).update(`POST\n${INVOKE_PATH}\n${timestamp}\n${bodyHash}`).digest('hex');
  const res = await app.inject({
    method: 'POST',
    url: INVOKE_PATH,
    headers: {
      'content-type': 'application/json',
      'x-traderton-consumer-id': CONSUMER_ID,
      'x-traderton-key-id': KEY_ID,
      'x-traderton-timestamp': timestamp,
      'x-traderton-signature': signature,
      'x-request-deadline-at': '2026-01-01T00:00:30.000Z',
    },
    payload: rawBody,
  });
  return res.json() as InvokeBody;
}

type Outcome =
  | { kind: 'success'; payload: Record<string, unknown> }
  | { kind: 'failure'; code: string; message: string; retryable: boolean };
interface InvokeBody {
  outcome: Outcome;
}

/** Narrow to the success outcome, failing the test with the real outcome if it was not one. */
function success(body: InvokeBody): Record<string, unknown> {
  if (body.outcome.kind !== 'success') {
    throw new Error(`expected a success outcome, got: ${JSON.stringify(body.outcome)}`);
  }
  return body.outcome.payload;
}

/** Narrow to the failure outcome, failing the test with the real outcome if it was not one. */
function failure(body: InvokeBody): Extract<Outcome, { kind: 'failure' }> {
  if (body.outcome.kind !== 'failure') {
    throw new Error(`expected a failure outcome, got: ${JSON.stringify(body.outcome)}`);
  }
  return body.outcome;
}

const validChange = { assessmentArtifactId: 'artifact-1', targetPreset: 'momentum', mode: 'entries_only', reason: 'Strong momentum' } as const;

describe('list_strategy_presets over the boundary (T1)', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('returns the catalog although the consumer sent no venue account and no preset-assessment context exists', async () => {
    const body = await invoke(h.app, 'list_strategy_presets', { styleTier: 'standard' });
    const payload = success(body);
    expect(payload.ok).toBe(true);
    expect(payload.presets).toEqual([expect.objectContaining({ key: 'momentum', name: 'Momentum — Day' })]);
    expect(h.builtPresetAssessments).toEqual([undefined]);
    expect(h.catalogListPresets).toHaveBeenCalledWith('standard');
    await h.app.close();
  });

  it('lists every tier when no styleTier is sent', async () => {
    const body = await invoke(h.app, 'list_strategy_presets', {});
    success(body);
    expect(h.catalogListPresets.mock.calls.map((call) => call[0])).toEqual(['economy', 'standard', 'premium']);
    await h.app.close();
  });

  it('works before the owner has any venue account (pre-connection catalog read)', async () => {
    const noAccounts = buildHarness([]);
    const body = await invoke(noAccounts.app, 'list_strategy_presets', {});
    success(body);
    await noAccounts.app.close();
  });

  it('strips a venueAccountId the consumer sends anyway, since the tool does not take one', async () => {
    const body = await invoke(h.app, 'list_strategy_presets', { venueAccountId: OWNED_ACCOUNT.id });
    success(body);
    expect(h.factoryPayloads).toEqual([{}]);
    await h.app.close();
  });

  it('rejects an unknown style tier at the boundary, before any context is built', async () => {
    const body = await invoke(h.app, 'list_strategy_presets', { styleTier: 'platinum' });
    expect(failure(body).code).toBe('validation.invalid_payload');
    expect(h.factoryPayloads).toHaveLength(0);
    await h.app.close();
  });
});

describe('change_strategy_preset over the boundary (T2)', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('keeps the consumer-supplied venueAccountId through the payload parse (the bug shape)', async () => {
    await invoke(h.app, 'change_strategy_preset', { ...validChange, venueAccountId: OWNED_ACCOUNT.id });
    expect(h.factoryPayloads).toHaveLength(1);
    expect((h.factoryPayloads[0] as Record<string, unknown>).venueAccountId).toBe(OWNED_ACCOUNT.id);
    await h.app.close();
  });

  it('builds the preset-assessment context for the owned account and applies the change', async () => {
    const body = await invoke(h.app, 'change_strategy_preset', { ...validChange, venueAccountId: OWNED_ACCOUNT.id });
    expect(success(body)).toEqual({ ok: true, targetPreset: 'momentum' });
    expect(h.builtPresetAssessments[0]).toMatchObject({ venueAccountId: OWNED_ACCOUNT.id, venue: OWNED_ACCOUNT.venue });
    expect(h.applyPresetChange).toHaveBeenCalledTimes(1);
    expect(h.applyPresetChange).toHaveBeenCalledWith({
      targetPreset: 'momentum',
      styleTier: 'standard',
      reason: 'Strong momentum',
      artifactId: 'artifact-1',
    });
    await h.app.close();
  });

  it('without a venueAccountId there is no preset-assessment context, so nothing is applied', async () => {
    const body = await invoke(h.app, 'change_strategy_preset', validChange);
    const refusal = failure(body);
    expect(refusal.code).toBe('validation.invalid_payload');
    expect(refusal.message).toBe('preset assessment not available in this context');
    expect(h.builtPresetAssessments).toEqual([undefined]);
    expect(h.applyPresetChange).not.toHaveBeenCalled();
    await h.app.close();
  });

  it('refuses a venueAccountId the signed owner does not own, and applies nothing', async () => {
    const body = await invoke(h.app, 'change_strategy_preset', { ...validChange, venueAccountId: OTHER_OWNERS_ACCOUNT_ID });
    expect(failure(body).code).toBe('precondition.not_ready');
    expect(h.builtPresetAssessments).toHaveLength(0);
    expect(h.applyPresetChange).not.toHaveBeenCalled();
    await h.app.close();
  });

  it('still rejects an unsupported mode at the boundary', async () => {
    const body = await invoke(h.app, 'change_strategy_preset', { ...validChange, mode: 'full_transition', venueAccountId: OWNED_ACCOUNT.id });
    expect(failure(body).code).toBe('validation.invalid_payload');
    expect(h.factoryPayloads).toHaveLength(0);
    expect(h.applyPresetChange).not.toHaveBeenCalled();
    await h.app.close();
  });

  it('still rejects an empty venueAccountId at the boundary', async () => {
    const body = await invoke(h.app, 'change_strategy_preset', { ...validChange, venueAccountId: '' });
    expect(failure(body).code).toBe('validation.invalid_payload');
    expect(h.factoryPayloads).toHaveLength(0);
    await h.app.close();
  });
});
