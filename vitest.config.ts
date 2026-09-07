import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**', '.ignore/**', '**/_deferred-config/**', '**/_deferred-authoring/**'],
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      '@traderton/domain/config/presets-loader': new URL('./packages/domain/src/config/presets-loader.ts', import.meta.url).pathname,
      '@traderton/domain': new URL('./packages/domain/src/index.ts', import.meta.url).pathname,
      '@traderton/db/schema': new URL('./packages/db/src/schema/index.ts', import.meta.url).pathname,
      '@traderton/db': new URL('./packages/db/src/index.ts', import.meta.url).pathname,
      '@traderton/engine': new URL('./packages/engine/src/index.ts', import.meta.url).pathname,
      '@traderton/market-data': new URL('./packages/market-data/src/index.ts', import.meta.url).pathname,
      '@traderton/strategy': new URL('./packages/strategy/src/index.ts', import.meta.url).pathname,
      '@traderton/venues': new URL('./packages/venues/src/index.ts', import.meta.url).pathname,
      '@traderton/backtesting': new URL('./packages/backtesting/src/index.ts', import.meta.url).pathname,
      '@traderton/worker': new URL('./packages/worker/src/index.ts', import.meta.url).pathname,
      '@traderton/tests': new URL('./tests', import.meta.url).pathname,
    },
  },
});
