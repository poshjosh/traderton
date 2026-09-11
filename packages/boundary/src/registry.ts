// AUTHORED (Phase 9b item F1) — assemble a `ToolRegistry` from the already-copied
// trading tool exports (`@traderton/worker`). This registers the tools; it
// authors NO tool behaviour. The boundary dispatches against this registry.
//
// This mirrors the shape of the (uncopied) herobids `createToolRegistry` barrel
// but WITHOUT the platform catalog assertion (`assertToolCatalogMatchesRegistry`)
// — that catalog is platform-owned and DELETE-side (see worker tools/index.ts).

import {
  ToolRegistry,
  accountTools,
  analyticsTools,
  botManagementTools,
  instrumentTools,
  marketDataTools,
  priceTools,
  provisioningTools,
  resolverTools,
  riskLimitsTools,
  schemaTools,
  strategyTools,
  tradingTools,
  watchTools,
} from '@traderton/worker';

/**
 * Build a `ToolRegistry` holding all copied trading tools. The boundary's F1
 * read-only gate (`getReadOnlyToolNames`) then restricts which of these are
 * invokable — side-effecting tools are registered but rejected by the gate until
 * F2.
 */
export function buildToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const allTools = [
    ...accountTools,
    ...analyticsTools,
    ...botManagementTools,
    ...instrumentTools,
    ...marketDataTools,
    ...priceTools,
    ...provisioningTools,
    ...resolverTools,
    ...riskLimitsTools,
    ...schemaTools,
    ...strategyTools,
    ...tradingTools,
    ...watchTools,
  ];
  for (const tool of allTools) {
    registry.register(tool);
  }
  return registry;
}
