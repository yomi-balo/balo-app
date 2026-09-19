import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // ⚠ `*.react-server.test.ts` belongs to the SECOND project (BAL-568 H2,
    // `vitest.rsc.config.ts`), which resolves React with the `react-server` condition.
    // Those suites render through the Flight server, which refuses to start against the client
    // build this project loads — so they must not be collected here.
    exclude: [...configDefaults.exclude, 'src/**/*.react-server.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: ['node_modules', 'src/test'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'server-only': path.resolve(__dirname, './src/test/server-only-stub.ts'),
    },
  },
});
