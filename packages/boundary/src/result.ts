// AUTHORED (Phase 9b item F1) — helpers that build the terminal
// `TradertonToolResultV1` envelope (005 §Invocation Contract, §Consumer Result
// Mapping). Boundary machinery only.

import type {
  TradertonBoundaryFailureCode,
  TradertonToolResultV1,
  TradertonToolInvocationStatusV1,
} from './contract.js';
import { CONTRACT_VERSION } from './contract.js';

/** Identity of the request a result envelope is being built for. */
export interface ResultIdentity {
  requestId: string;
  correlationId: string;
}

export function successResult(
  identity: ResultIdentity,
  payload: unknown,
): TradertonToolResultV1 {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: identity.requestId,
    correlationId: identity.correlationId,
    outcome: { kind: 'success', payload },
  };
}

export function failureResult(
  identity: ResultIdentity,
  code: TradertonBoundaryFailureCode,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>,
): TradertonToolResultV1 {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: identity.requestId,
    correlationId: identity.correlationId,
    outcome: {
      kind: 'failure',
      code,
      message,
      retryable,
      ...(details ? { details } : {}),
    },
  };
}

/**
 * The `in_progress` status shape (005 §Invocation Contract): returned when a
 * request reuses an idempotency key whose original invocation is still running,
 * or by the status endpoint for an in-flight row. No second side effect.
 */
export function inProgressStatus(
  identity: ResultIdentity,
): TradertonToolInvocationStatusV1 {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: identity.requestId,
    correlationId: identity.correlationId,
    state: 'in_progress',
  };
}

/**
 * The `terminal` status shape (005 §Invocation Contract): the status endpoint
 * wraps a stored terminal `TradertonToolResultV1` in this envelope.
 */
export function terminalStatus(
  identity: ResultIdentity,
  result: TradertonToolResultV1,
): TradertonToolInvocationStatusV1 {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: identity.requestId,
    correlationId: identity.correlationId,
    state: 'terminal',
    result,
  };
}

/**
 * A pre-dispatch failure that carries no envelope identity yet (e.g. an auth
 * failure detected before the body is trusted). The route layer maps this onto
 * whatever identity it can safely surface.
 */
export class BoundaryFailure extends Error {
  constructor(
    public readonly code: TradertonBoundaryFailureCode,
    message: string,
    public readonly retryable: boolean,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BoundaryFailure';
  }
}
