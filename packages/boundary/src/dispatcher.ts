// AUTHORED (Phase 9b item F1) — the `tools:invoke` dispatcher: envelope +
// version validation → read-only gate → payload validation → authorization →
// build `TradingToolContext` → `tool.execute` → map `ToolResult` to
// `TradertonToolResultV1` (005 §Invocation Contract, §Version Compatibility,
// §Consumer Result Mapping).
//
// It authors NO trading behaviour — it dispatches to the already-copied tools on
// the `ToolRegistry` and injects the platform-owned VALUES the boundary carries
// (the signed `subject.ownerId`/`actor` + a caller-supplied base context). The
// ports-carry-values invariant (000/004) holds: the boundary supplies values,
// never trading logic.

import type { ToolRegistry } from '@traderton/worker';
import type { AgentTool, TradingToolContext, ToolResult } from '@traderton/domain';
import { getCategoryOperation } from '@traderton/domain';
import { createLogger } from '@traderton/worker';

const logger = createLogger('dispatcher');

import {
  CONTRACT_VERSION,
  TradertonToolInvocationV1Schema,
  type TradertonToolInvocationV1,
  type TradertonToolResultV1,
  type TradertonInvokeResponseV1,
} from './contract.js';
import type { BoundaryConfig } from './config.js';
import {
  failureResult,
  successResult,
  inProgressStatus,
  terminalStatus,
  type ResultIdentity,
} from './result.js';

/**
 * The idempotency store the dispatcher drives (005 §Deadlines, Retries, And
 * Idempotency). A THIN local interface the `@traderton/db`
 * `BoundaryInvocationRepository` satisfies structurally — the boundary depends
 * on this port, never on `@traderton/db` internals (000 invariant: no db import
 * leaks into the dispatcher). `bin.ts` injects the real repo.
 */
export interface BoundaryInvocationStore {
  beginOrResolve(params: {
    consumerId: string;
    ownerId: string;
    toolName: string;
    idempotencyKey: string;
    requestFingerprint: string;
    requestId: string;
    correlationId: string;
    retentionMs: number;
  }): Promise<
    | { kind: 'started'; id: string }
    | { kind: 'in_progress' }
    | { kind: 'replay'; terminalResponse: Record<string, unknown> | null }
    | { kind: 'conflict' }
  >;
  complete(params: {
    consumerId: string;
    ownerId: string;
    toolName: string;
    idempotencyKey: string;
    terminalResponse: Record<string, unknown>;
  }): Promise<void>;
  findByRequestId(requestId: string): Promise<{
    requestId: string;
    correlationId: string;
    state: string;
    terminalResponse: Record<string, unknown> | null;
  } | null>;
}

/**
 * The deterministic request-fingerprint function (005 §Idempotency). A thin
 * function port the `@traderton/db` `computeRequestFingerprint` satisfies —
 * injected so the dispatcher never imports `@traderton/db`.
 */
export type ComputeRequestFingerprint = (input: {
  consumerId: string;
  ownerId: string;
  toolName: string;
  payload: unknown;
}) => string;

/**
 * The signed subject the boundary hands the context factory. These are
 * platform-owned VALUES the caller injects — never trading behaviour.
 */
export interface DispatchSubject {
  ownerId: string;
  actor: { type: 'agent' | 'bot' | 'user' | 'system'; id: string };
}

/**
 * The boundary's injection seam (ports-carry-values). The composition root / bin
 * supplies a factory that builds the `TradingToolContext` for a signed subject
 * (stamping `agentId`/mode + wiring the read-only repos/registry the tool needs).
 * F1 keeps this factory OUTSIDE the dispatcher so no DB/runtime wiring — and no
 * trading behaviour — is authored here.
 */
export type TradingToolContextFactory = (
  request: ContextFactoryRequest,
) => TradingToolContext | Promise<TradingToolContext>;

/**
 * What the dispatcher hands the context factory: the signed subject PLUS the
 * resolved tool name + validated payload. The D2 subject→injection resolver
 * (authored in `bin.ts`) needs the payload to find a named `botId` (bot-scoped
 * tools) or fall back to a per-owner default venue account (no bot named). These
 * are VALUES for lookup — never trading behaviour.
 */
export interface ContextFactoryRequest extends DispatchSubject {
  toolName: string;
  payload: unknown;
}

export interface DispatcherDeps {
  registry: ToolRegistry;
  contextFactory: TradingToolContextFactory;
  /** The boundary config — carries `allowedConsumers.<id>.allowedActorTypes` (D4). */
  config: BoundaryConfig;
  /**
   * The idempotency store (F2a repo, injected via the thin port). Side-effecting
   * tools persist-before-side-effect through it; read-only tools bypass it.
   */
  invocationStore: BoundaryInvocationStore;
  /** The request-fingerprint function (F2a, injected). */
  computeRequestFingerprint: ComputeRequestFingerprint;
  /**
   * Retention window in ms — a VALUE the composition root derives from
   * `boundary.idempotencyRetentionHours` (005: never hard-coded).
   */
  retentionMs: number;
  /** Injectable clock — tests pin it; production defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Best-effort identity for a result envelope when the body has not fully parsed
 * yet. 005 always echoes requestId/correlationId; when they are unreadable we
 * fall back to empty strings (the failure is terminal regardless).
 */
function identityFromRaw(body: unknown): ResultIdentity {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    return {
      requestId: typeof record['requestId'] === 'string' ? record['requestId'] : '',
      correlationId:
        typeof record['correlationId'] === 'string' ? record['correlationId'] : '',
    };
  }
  return { requestId: '', correlationId: '' };
}

/** Path-major must equal contractVersion-major (005 §Version Compatibility). */
function majorOf(version: string): string {
  return version.split('.')[0] ?? '';
}

/**
 * Map a copied tool's `ToolResult` onto the closed `TradertonBoundaryFailureCode`
 * union (005 §Consumer Result Mapping). Never leaks credentials / raw provider
 * responses / internal authz detail — only the tool's own `error` string +
 * `errorCode` are surfaced.
 */
function mapToolResult(
  identity: ResultIdentity,
  result: ToolResult,
): TradertonToolResultV1 {
  if (result.success) {
    return successResult(identity, result.data);
  }

  const message = result.error ?? 'tool execution failed';
  const details = result.errorCode ? { errorCode: result.errorCode } : undefined;

  // A tool-signalled rate-limit throttle maps to the closed-union `rate_limit.exceeded`
  // (still retryable) — checked BEFORE the generic retryable branch so a throttle is
  // distinguishable from a generic transient fault at the boundary. Consumers rely on
  // this to split throttle-vs-failure telemetry (L3 Q2 regime re-point; parity).
  if (result.errorCode === 'rate_limit') {
    return failureResult(identity, 'rate_limit.exceeded', message, true, details);
  }
  // A3: a tool-signaled typed precondition (e.g. adjust_risk_limits' fail-closed
  // "no durable store until B1") passes through as the closed-union
  // `precondition.not_ready` — a content-level "not yet" outcome, not an
  // infrastructure fault. Without this branch the generic mapping below would
  // flatten it to `validation.invalid_payload`, losing the semantic the consumer
  // keys its non-circuit-breaking handling on.
  if (result.errorCode === 'precondition.not_ready') {
    return failureResult(identity, 'precondition.not_ready', message, result.retryable === true, details);
  }
  // A transient/retryable fault → upstream.transient (infrastructure/dependency).
  if (result.retryable === true) {
    return failureResult(identity, 'upstream.transient', message, true, details);
  }

  // A content-level outcome (fault === false) is a non-retryable client/contract
  // failure surfaced generically as invalid_payload — the tool judged the input,
  // not the infrastructure, at fault.
  if (result.fault === false) {
    return failureResult(identity, 'validation.invalid_payload', message, false, details);
  }

  // Otherwise a non-retryable internal service failure.
  return failureResult(identity, 'internal.non_retryable', message, false, details);
}

export class ToolInvocationDispatcher {
  private readonly registry: ToolRegistry;
  private readonly contextFactory: TradingToolContextFactory;
  private readonly config: BoundaryConfig;
  private readonly invocationStore: BoundaryInvocationStore;
  private readonly computeRequestFingerprint: ComputeRequestFingerprint;
  private readonly retentionMs: number;
  private readonly now: () => number;

  constructor(deps: DispatcherDeps) {
    this.registry = deps.registry;
    this.contextFactory = deps.contextFactory;
    this.config = deps.config;
    this.invocationStore = deps.invocationStore;
    this.computeRequestFingerprint = deps.computeRequestFingerprint;
    this.retentionMs = deps.retentionMs;
    this.now = deps.now ?? Date.now;
  }

  /** A tool is side-effecting when its category operation is not read-only. */
  private isSideEffecting(tool: AgentTool): boolean {
    return getCategoryOperation(tool.category) !== 'read';
  }

  /**
   * Look up an invocation's status by requestId (005 status endpoint). Reads the
   * store only — it NEVER executes a tool. `in_progress` → the in-progress status
   * shape; `terminal` → the stored terminal result wrapped as a
   * `TradertonToolInvocationStatusV1`; no row → `not_found.resource`.
   */
  async status(requestId: string): Promise<TradertonInvokeResponseV1> {
    const row = await this.invocationStore.findByRequestId(requestId);
    if (!row) {
      return failureResult(
        { requestId, correlationId: '' },
        'not_found.resource',
        `no invocation for requestId: ${requestId}`,
        false,
      );
    }
    const identity: ResultIdentity = {
      requestId: row.requestId,
      correlationId: row.correlationId,
    };
    if (row.state !== 'terminal') {
      return inProgressStatus(identity);
    }
    // The stored terminal response IS a serialized TradertonToolResultV1.
    return terminalStatus(
      identity,
      (row.terminalResponse ?? {}) as unknown as TradertonToolResultV1,
    );
  }

  /**
   * Dispatch a `tools:invoke` request that has already been HMAC-authenticated.
   * `pathVersion` is the path major (e.g. 'v1') stripped of its `v` prefix so it
   * can be compared to the contractVersion major.
   *
   * Returns a terminal `TradertonToolResultV1`. Never throws for a contract-level
   * failure — all failures map onto the closed union.
   */
  async dispatch(
    rawBody: unknown,
    pathMajor: string,
  ): Promise<TradertonInvokeResponseV1> {
    // 1. Envelope validation — reject unknown outer keys (005 §Invocation Contract).
    const parsed = TradertonToolInvocationV1Schema.safeParse(rawBody);
    if (!parsed.success) {
      const identity = identityFromRaw(rawBody);
      // A bad contractVersion literal is a version failure, not a payload one.
      const contractVersionIssue = parsed.error.issues.some(
        (issue) => issue.path.length === 1 && issue.path[0] === 'contractVersion',
      );
      if (contractVersionIssue) {
        return failureResult(
          identity,
          'contract.unsupported_version',
          'unsupported contractVersion',
          false,
        );
      }
      return failureResult(
        identity,
        'validation.invalid_payload',
        'malformed invocation envelope',
        false,
        { issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
      );
    }

    const invocation: TradertonToolInvocationV1 = parsed.data;
    const identity: ResultIdentity = {
      requestId: invocation.requestId,
      correlationId: invocation.correlationId,
    };

    // 1b. Deadline PRE-check (005 §Deadlines; D3 PRAGMATIC). The envelope has
    //     parsed, so `deadlineAt` is readable — reject an already-expired request
    //     BEFORE tool lookup / payload validation (005: "before validation").
    if (this.isDeadlineExpired(invocation.deadlineAt)) {
      return failureResult(identity, 'deadline.expired', 'request deadline has passed', false);
    }

    // 2. Version compatibility — path-major ↔ contractVersion-major (005 §Version).
    if (pathMajor !== majorOf(invocation.contractVersion)) {
      return failureResult(
        identity,
        'contract.unsupported_version',
        `path major ${pathMajor} does not match contractVersion ${invocation.contractVersion}`,
        false,
      );
    }

    // 3. Tool lookup (005: unknown tool → terminal validation failure).
    const tool: AgentTool | undefined = this.registry.get(invocation.toolName);
    if (!tool) {
      return failureResult(
        identity,
        'validation.invalid_payload',
        `unknown tool: ${invocation.toolName}`,
        false,
      );
    }

    // 4. F1's read-only scope gate is OPEN in F2b — side-effecting tools now
    //    dispatch, protected by the deadline re-check + the idempotency wrap
    //    (step 7). The category distinction is still consulted there (it decides
    //    whether an invocation persists through the store vs runs directly).

    // 5. Payload validation against the Traderton-owned tool schema (005).
    const payloadParse = tool.parametersSchema.safeParse(invocation.payload);
    if (!payloadParse.success) {
      return failureResult(
        identity,
        'validation.invalid_payload',
        `payload does not match schema for ${tool.name}`,
        false,
        { issues: payloadParse.error.issues.map((i) => ({ path: i.path, message: i.message })) },
      );
    }

    // 6. Authorization (005 §Authentication And Authorization, post-auth checks):
    //    item 1 (caller allowed to use the boundary) is enforced by HMAC config;
    //    item 2 (non-empty ownerId + actor) is the runtime check below; item 4
    //    (tool-specific readiness) is the context factory + the tool's own logic.
    //    Item 3 (actor provenance valid for the requested tool) is now ENFORCED
    //    via D4 Option B (operator-config `allowedActorTypes` per consumer) — see
    //    below. Per-tool provenance rules (Option A) remain the docs/010 B3
    //    later-option, intentionally out of scope.
    if (!invocation.subject.ownerId.trim() || !invocation.subject.actor.id.trim()) {
      return failureResult(
        identity,
        'authorization.denied',
        'subject.ownerId and subject.actor.id must be non-empty',
        false,
      );
    }

    // 6b. Item-3 actor provenance (D4 Option B). The asserted `actor.type` must
    //     be one the operator configured this consumer to assert. Absent config →
    //     all four types allowed (back-compat; no surprise tightening). This is a
    //     VALUE assertion (ports-carry-values), NOT an authored per-tool rule.
    const consumer = this.config.allowedConsumers[invocation.caller.consumerId];
    const allowedActorTypes = consumer?.allowedActorTypes;
    if (allowedActorTypes && !allowedActorTypes.includes(invocation.subject.actor.type)) {
      return failureResult(
        identity,
        'authorization.denied',
        `actor type not permitted for this consumer: ${invocation.subject.actor.type}`,
        false,
      );
    }

    // 7. Deadline RE-check (005 §Deadlines; D3 PRAGMATIC). Immediately before the
    //    single "before the side effect" point. Per the logged D3 decision
    //    (docs/003, 2026-09-08), the PRAGMATIC reading commits to exactly ONE
    //    re-check here — it does NOT thread `deadlineAt` into the copied drive
    //    path, so this is a deliberate divergence from 005's literal "every side
    //    effect" wording (the literal per-side-effect re-check is the docs/010
    //    later-option).
    if (this.isDeadlineExpired(invocation.deadlineAt)) {
      return failureResult(identity, 'deadline.expired', 'request deadline has passed', false);
    }

    // 8. Read-only tools run DIRECTLY — no side effect to protect, so they bypass
    //    the idempotency store (005; F1 rationale). Side-effecting tools go
    //    through the persist-before-side-effect idempotency wrap.
    if (!this.isSideEffecting(tool)) {
      return this.executeAndMap(tool, payloadParse.data, invocation, identity);
    }

    return this.dispatchSideEffecting(tool, payloadParse.data, invocation, identity);
  }

  /**
   * The side-effecting idempotency wrap (005 §Deadlines, Retries, And
   * Idempotency): fingerprint → beginOrResolve → branch. `started` executes once
   * and completes the row terminally; a caught execute error STILL completes the
   * row terminally (never leaves it stuck `in_progress`). `replay` returns the
   * stored terminal result without re-running the tool; `in_progress` returns the
   * status shape (no second execution); `conflict` maps to invalid_payload.
   */
  private async dispatchSideEffecting(
    tool: AgentTool,
    payload: unknown,
    invocation: TradertonToolInvocationV1,
    identity: ResultIdentity,
  ): Promise<TradertonInvokeResponseV1> {
    const consumerId = invocation.caller.consumerId;
    const ownerId = invocation.subject.ownerId;
    const toolName = tool.name;

    const requestFingerprint = this.computeRequestFingerprint({
      consumerId,
      ownerId,
      toolName,
      payload,
    });

    const begin = await this.invocationStore.beginOrResolve({
      consumerId,
      ownerId,
      toolName,
      idempotencyKey: invocation.idempotencyKey,
      requestFingerprint,
      requestId: invocation.requestId,
      correlationId: invocation.correlationId,
      retentionMs: this.retentionMs,
    });

    if (begin.kind === 'conflict') {
      // Same key, different request → the client reused a key wrongly (005).
      return failureResult(
        identity,
        'validation.invalid_payload',
        'idempotency key reused with a different request',
        false,
      );
    }

    if (begin.kind === 'in_progress') {
      // Original invocation still running → no second side effect (005).
      return inProgressStatus(identity);
    }

    if (begin.kind === 'replay') {
      // Terminal already stored → return it, do NOT re-run the tool (005).
      return (begin.terminalResponse ?? {}) as unknown as TradertonToolResultV1;
    }

    // begin.kind === 'started' → we own the single execution. Whatever the
    // outcome (success, mapped failure, or a thrown tool), the row MUST reach
    // terminal so it is never left stuck in_progress (store hygiene, §8).
    const mapped = await this.executeAndMap(tool, payload, invocation, identity);
    try {
      await this.invocationStore.complete({
        consumerId,
        ownerId,
        toolName,
        idempotencyKey: invocation.idempotencyKey,
        terminalResponse: mapped as unknown as Record<string, unknown>,
      });
    } catch {
      // The side effect has already happened and `mapped` is the tool's
      // authoritative terminal result. A persistence-only failure here (a DB
      // blip after the side effect ran) must NOT surface as a raw 500 nor
      // re-run anything — swallow it and return `mapped`. The row stays
      // in_progress and reconciles later via retention/retry, not by
      // downgrading the caller's result to a different code.
    }
    return mapped;
  }

  /**
   * Build the `TradingToolContext` from the signed subject + injected VALUES,
   * dispatch to the copied tool, and map the `ToolResult` onto the closed union.
   * A context that cannot be assembled → `precondition.not_ready`; a thrown tool
   * → `internal.non_retryable`. Returns a terminal `TradertonToolResultV1`.
   */
  private async executeAndMap(
    tool: AgentTool,
    payload: unknown,
    invocation: TradertonToolInvocationV1,
    identity: ResultIdentity,
  ): Promise<TradertonToolResultV1> {
    let ctx: TradingToolContext;
    try {
      ctx = await this.contextFactory({
        ownerId: invocation.subject.ownerId,
        actor: invocation.subject.actor,
        toolName: tool.name,
        payload,
      });
    } catch (err) {
      // A context that cannot be assembled is a readiness failure, not a caller
      // error. Do not leak the underlying cause over the boundary — but DO log it
      // internally: without this the exact failure (e.g. subject-resolution
      // ambiguity, a repo/db failure) is unrecoverable from artifacts and every
      // such rejection looks identical to the consumer.
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { toolName: tool.name, ownerId: invocation.subject.ownerId, actorId: invocation.subject.actor.id, requestId: identity.requestId, correlationId: identity.correlationId, err: message },
        'context factory failed — returning precondition.not_ready',
      );
      return failureResult(identity, 'precondition.not_ready', 'trading context unavailable', true);
    }

    let result: ToolResult;
    try {
      result = await tool.execute(payload, ctx);
    } catch (err) {
      // A thrown tool is an internal, non-retryable service failure. Surface only
      // a generic message — never the raw error/stack (005 §Consumer Result Mapping).
      const message = err instanceof Error ? err.message : 'tool execution error';
      return failureResult(identity, 'internal.non_retryable', message, false);
    }

    return mapToolResult(identity, result);
  }

  /** True when `deadlineAt` is unparseable or already at/past the injected clock. */
  private isDeadlineExpired(deadlineAt: string): boolean {
    const deadlineMs = Date.parse(deadlineAt);
    if (Number.isNaN(deadlineMs)) {
      // An unparseable deadline cannot be honoured — treat as expired (fail-closed).
      return true;
    }
    return deadlineMs <= this.now();
  }
}

export { CONTRACT_VERSION };
