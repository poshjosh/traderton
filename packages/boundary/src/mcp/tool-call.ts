// AUTHORED (Phase 3 T2.2) — the `tools/call` ↔ 005 envelope mapping.
// Field mapping and result encoding are normative in herobids Step 10 §2.5.
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/server';
import type { TradertonInvokeResponseV1 } from '../contract.js';

/** The envelope fields carried in `params._meta`; any other `_meta` key is ignored. */
export const ENVELOPE_META_KEYS = [
  'contractVersion',
  'requestId',
  'idempotencyKey',
  'correlationId',
  'issuedAt',
  'deadlineAt',
  'caller',
  'subject',
] as const;

/**
 * Rebuild the 005 invocation envelope from a `tools/call`. No validation here:
 * the dispatcher's strict envelope schema is the single validator, as on REST.
 */
export function envelopeFromToolCall(params: CallToolRequest['params']): Record<string, unknown> {
  const meta: Record<string, unknown> = params._meta ?? {};
  const envelope: Record<string, unknown> = {};
  for (const key of ENVELOPE_META_KEYS) {
    if (key in meta) envelope[key] = meta[key];
  }
  envelope['toolName'] = params.name;
  envelope['payload'] = params.arguments;
  return envelope;
}

/**
 * Encode a 005 response as an MCP tool result: `structuredContent` is the 005
 * body verbatim; `isError` iff the outcome is a failure; the `in_progress`
 * status shape carries no `isError` (REST's discriminator: `'state' in body`).
 */
export function toCallToolResult(response: TradertonInvokeResponseV1): CallToolResult {
  const isFailure = !('state' in response) && response.outcome.kind === 'failure';
  return {
    content: [{ type: 'text', text: JSON.stringify(response) }],
    structuredContent: response,
    ...(isFailure ? { isError: true } : {}),
  };
}
