import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'apps/web',
      // BAL-568 (H2) — a second `apps/web` project that resolves React with the `react-server`
      // condition, for the suites that must observe what `React.cache()` really does. Listed
      // explicitly because a project is one config file, and `apps/web/vitest.config.ts` (which
      // excludes these suites) is the default one.
      'apps/web/vitest.rsc.config.ts',
      'apps/api',
      'packages/analytics',
      'packages/db',
      'packages/shared',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: ['node_modules', '**/test/**', '**/dist/**', '**/.next/**'],
    },
  },
});
