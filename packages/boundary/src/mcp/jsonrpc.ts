// AUTHORED (Phase 3 T2.2) — minimal JSON-RPC frame inspection the route needs
// BEFORE the SDK sees the frame (auth assertions + error ids).

export type JsonRpcId = string | number;

export interface ToolsCallFrame {
  method: 'tools/call';
  params: { _meta?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isToolsCallFrame(frame: unknown): frame is ToolsCallFrame {
  return isRecord(frame) && frame['method'] === 'tools/call' && isRecord(frame['params']);
}

/** The id of a JSON-RPC request frame; undefined for notifications and non-frames. */
export function requestIdOf(frame: unknown): JsonRpcId | undefined {
  if (!isRecord(frame) || typeof frame['method'] !== 'string') return undefined;
  const id = frame['id'];
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

/**
 * A JSON-RPC notification: a frame with a `method` but no `id`. The route treats
 * a notification that fails authentication as unreplyable (401, id:null) — it
 * carries no request id to answer under.
 */
export function isNotificationFrame(frame: unknown): boolean {
  return isRecord(frame) && typeof frame['method'] === 'string' && requestIdOf(frame) === undefined;
}

export function jsonRpcErrorBody(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}
