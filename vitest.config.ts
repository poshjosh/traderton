import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**', '.ignore/**'],
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      '@traderton/domain/config/presets-loader': new URL('./packages/domain/src/config/presets-loader.ts', import.meta.url).pathname,
      '@traderton/domain': new URL('./packages/domain/src/index.ts', import.meta.url).pathname,
      '@traderton/db/schema': new URL('./packages/db/src/schema/index.ts', import.meta.url).pathname,
      '@traderton/db': new URL('./packages/db/src/index.ts', import.meta.url).pathname,
    },
  },
});
