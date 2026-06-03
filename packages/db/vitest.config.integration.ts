import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/db
const repoRoot = path.resolve(here, '../..');

export default defineConfig({
  test: {
    root: repoRoot, // ⇐ makes SF: paths repo-root-relative (the load-bearing line)
    include: ['packages/db/src/**/*.integration.test.ts'], // root-anchored to match new root
    globalSetup: path.join(here, 'src/test/global-setup.ts'), // absolute → root-independent
    setupFiles: [path.join(here, 'src/test/setup-integration.ts')], // absolute → root-independent
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    passWithNoTests: true,
    coverage: {
      enabled: false, // off by default; turned on via --coverage flag in CI only
      provider: 'v8',
      reporter: ['lcov'], // lcov only — Sonar consumes lcov; no html/json noise
      reportsDirectory: path.join(repoRoot, 'coverage-integration'),
      include: ['packages/db/src/**'], // relative to root (=repoRoot) → root-relative SF paths
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        'packages/db/src/test/**',
        'packages/db/src/client.ts',
        'packages/db/src/schema/helpers.ts',
        '**/*.integration.test.ts',
        '**/*.test.ts',
      ],
    },
  },
});
