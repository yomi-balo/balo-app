import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.mocks.ts', './src/test/setup.ts'],
    // BAL-605 — jsdom + jest-dom + RTL cost every file, so only `.tsx` suites run here. `.ts`
    // suites run in `vitest.node.config.ts` (project `web-node`): a test that needs the DOM must
    // be a `.tsx` file.
    include: ['src/**/*.{test,spec}.tsx'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'server-only': path.resolve(__dirname, './src/test/server-only-stub.ts'),
    },
  },
});
