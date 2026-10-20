import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

/**
 * Node-environment project for the `apps/web` `.test.ts` suites (BAL-605).
 *
 * ⚠ WHY IT EXISTS: `vitest.config.ts` (project `web`) loads jsdom, jest-dom and React Testing
 * Library for every file it runs. The `.ts` suites need none of them, so they run here instead
 * and skip that per-file cost. The split is by extension: `.test.ts` → node, `.test.tsx` → jsdom,
 * so a test that needs the DOM must be a `.tsx` file.
 *
 * ⚠ THE FILE IS NAMED `vitest.node.config.ts` BECAUSE VITEST CONSTRAINS IT: a config named in a
 * root `projects` array must match `^vite(?:st)?(?:\.\w+)?\.config\.` (see the note in
 * `vitest.rsc.config.ts`).
 *
 * ⚠ `react()` IS REQUIRED: tsconfig sets `jsx: preserve`, and `.ts` suites import `.tsx`
 * modules, so the React plugin must still transform JSX.
 *
 * `*.react-server.test.ts` belongs to `vitest.rsc.config.ts`, which resolves React with the
 * `react-server` condition.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    name: 'web-node',
    environment: 'node',
    globals: true,
    setupFiles: ['./src/test/setup.mocks.ts'],
    include: ['src/**/*.{test,spec}.ts'],
    exclude: [...configDefaults.exclude, 'src/**/*.react-server.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'server-only': path.resolve(__dirname, './src/test/server-only-stub.ts'),
    },
  },
});
