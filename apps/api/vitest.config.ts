import { configDefaults, defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.{test,spec}.ts'],
    /**
     * ⚠ BAL-428 — LOAD-BEARING. `include` above matches `*.integration.test.ts` too, and
     * an integration test needs a real Postgres that THIS config never starts. Those files
     * run from `packages/db/vitest.config.integration.ts`, which owns the testcontainer,
     * the migrations and the per-test transaction rollback, and whose `include` was widened
     * to cover `apps/api`. Without this exclusion the unit job picks the same file up with
     * no database and fails.
     *
     * `configDefaults.exclude` is spread back in DELIBERATELY: setting `exclude` REPLACES
     * vitest's defaults rather than extending them, so dropping it would un-ignore
     * `node_modules` and `dist`.
     */
    exclude: [...configDefaults.exclude, 'src/**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
