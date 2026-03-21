import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['apps/web', 'apps/api', 'packages/analytics', 'packages/db', 'packages/shared'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: ['node_modules', '**/test/**', '**/dist/**', '**/.next/**'],
    },
  },
});
