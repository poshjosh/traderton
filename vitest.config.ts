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
      '@traderton/domain/config/load-providers': new URL('./packages/domain/src/config/load-providers.ts', import.meta.url).pathname,
      '@traderton/domain': new URL('./packages/domain/src/index.ts', import.meta.url).pathname,
    },
  },
});
