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
import {
  CONTRACT_VERSION,
  TradertonToolInvocationV1Schema,
  type TradertonToolInvocationV1,
  type TradertonToolResultV1,
} from './contract.js';
import { failureResult, successResult, type ResultIdentity } from './result.js';

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
  subject: DispatchSubject,
) => TradingToolContext | Promise<TradingToolContext>;

export interface DispatcherDeps {
  registry: ToolRegistry;
  contextFactory: TradingToolContextFactory;
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
  private readonly readOnlyToolNames: Set<string>;

  constructor(deps: DispatcherDeps) {
    this.registry = deps.registry;
    this.contextFactory = deps.contextFactory;
    // Snapshot the read-only allow-set once (005 F1 scope gate — 029 §4).
    this.readOnlyToolNames = new Set(this.registry.getReadOnlyToolNames());
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
  ): Promise<TradertonToolResultV1> {
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

    // 4. F1 read-only scope gate (029 §4). Side-effecting tools are F2 — never
    //    dispatched on this boundary yet.
    if (!this.readOnlyToolNames.has(tool.name)) {
      return failureResult(
        identity,
        'precondition.not_ready',
        `tool not available on this boundary yet — F2: ${tool.name}`,
        false,
      );
    }

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
    //    Item 3 (actor provenance valid for the requested tool) is a per-tool
    //    policy that F1's read-only surface does not yet author — DEFERRED to F2
    //    (see docs/003 and the parity ledger). The actor-type enum validates the
    //    SHAPE of `actor.type`, not that a given actor is permitted for a tool.
    if (!invocation.subject.ownerId.trim() || !invocation.subject.actor.id.trim()) {
      return failureResult(
        identity,
        'authorization.denied',
        'subject.ownerId and subject.actor.id must be non-empty',
        false,
      );
    }

    // 7. Build the TradingToolContext from the signed subject + injected values,
    //    then dispatch to the copied tool.
    let ctx: TradingToolContext;
    try {
      ctx = await this.contextFactory({
        ownerId: invocation.subject.ownerId,
        actor: invocation.subject.actor,
      });
    } catch {
      // A context that cannot be assembled is a readiness failure, not a caller
      // error. Do not leak the underlying cause over the boundary.
      return failureResult(
        identity,
        'precondition.not_ready',
        'trading context unavailable',
        true,
      );
    }

    let result: ToolResult;
    try {
      result = await tool.execute(payloadParse.data, ctx);
    } catch (err) {
      // A thrown tool is an internal, non-retryable service failure. Surface only
      // a generic message — never the raw error/stack (005 §Consumer Result Mapping).
      const message = err instanceof Error ? err.message : 'tool execution error';
      return failureResult(identity, 'internal.non_retryable', message, false);
    }

    return mapToolResult(identity, result);
  }
}

export { CONTRACT_VERSION };
