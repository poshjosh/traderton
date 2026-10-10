/**
 * `@traderton/contracts` — versioned wire-DTO contract package.
 *
 * Traderton is the sole producer of every shape here; herobids consumes them as a
 * published dependency (Brief B decision 5, `decisions/wire-dto-package-mechanics.md`).
 * Schemas + types only — no runtime SDK, no worker/domain imports.
 */

// Watch (C1.2)
export * from './trading/watch.js';
export * from './trading/watch-purpose.js';

// Scan state (C1.3)
export * from './trading/scan-state.js';
export * from './trading/pricing-identity.js';

// Wake envelope (C1.4)
export * from './trading/wake.js';

// Risk overrides (C1.6)
export * from './trading/risk-overrides.js';

// Assessment identity (C1.4 transitive dep)
export * from './assessment/identity.js';

// Regime & volatility (C1.5)
export * from './assessment/regime.js';
export * from './assessment/evidence.js';