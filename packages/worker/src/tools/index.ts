// Trading-tool barrel — trimmed subset of the herobids worker tools/index.ts.
//
// Phase 9a copies only the trading tool modules; the platform tools
// (browser/code/email/filesystem/http-client/memory/messaging/shell/skills/
// tasks/web-access/workspace/platform-docs/assess-strategy-preset/
// change-strategy-preset) are DELETE-side, and the message-broker-coupled
// bots/trading tools (AGENT_MESSAGE_TYPES) are deferred to 9b. The source
// barrel's `createToolRegistry` (which registers the full 25-tool catalog and
// runs `assertToolCatalogMatchesRegistry` against the platform-owned
// TOOL_CATALOG / KNOWN_AGENT_TOOL_NAMES) is therefore NOT copied here — the
// full composition root is 9b authoring. This barrel re-exports exactly the
// trading tools that copy green in 9a plus the registry surface.

export { accountTools } from './account.js';
export { analyticsTools } from './analytics.js';
export { botManagementTools } from './bots.js';
export { instrumentTools } from './find-instrument.js';
export { marketDataTools } from './market-data.js';
export { priceTools } from './price.js';
export { resolverTools } from './resolvers.js';
export { riskLimitsTools } from './risk-limits.js';
export { schemaTools } from './schema.js';
export { tradingTools } from './trading.js';
export { watchTools } from './watch.js';

export { ToolRegistry, convertZodToJsonSchema } from './registry.js';
export type { AgentTool, ToolDefinition, ToolResult, TradingToolContext, ToolCategory } from '@traderton/domain';
