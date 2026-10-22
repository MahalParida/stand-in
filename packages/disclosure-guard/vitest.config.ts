import { defineConfig } from 'vitest/config';

// Used when this package runs on its own (standalone repo or `npm test` here).
// The Stand-In monorepo runs these tests through its root vitest.config.ts.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
  },
});
