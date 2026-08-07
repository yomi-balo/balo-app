import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/db
const repoRoot = path.resolve(here, '../..');

export default defineConfig({
  test: {
    root: repoRoot, // ⇐ makes SF: paths repo-root-relative (the load-bearing line)
    include: [
      'packages/db/src/**/*.integration.test.ts', // root-anchored to match new root
      /**
       * BAL-428 widened this beyond `@balo/db`. `apps/api`'s booking↔availability
       * end-to-end test needs a REAL Postgres, and running it here means ONE
       * testcontainer for the whole integration job — a second config would roughly
       * double that job's CI time for a single file.
       *
       * It works because of the three lines around it: `root` is the repo root (so this
       * glob resolves), `globalSetup`/`setupFiles` are ABSOLUTE (so they load regardless
       * of which package a test file lives in), and `@balo/db`'s `main` is `./src/index.ts`
       * — raw TypeScript, resolved to the SAME module instance `setup-integration.ts`
       * hands the per-test transaction to via `_setDb`. An `apps/api` service calling
       * `@balo/db` therefore reads and writes inside the same rolled-back transaction.
       *
       * ⚠ MANDATORY COMPANION CHANGE, already made: `apps/api/vitest.config.ts` now
       * EXCLUDES `src/**‍/*.integration.test.ts`. Its `include` (`src/**‍/*.{test,spec}.ts`)
       * matches `*.integration.test.ts` too, so without that exclusion the unit job would
       * also run this file — with no database, and no container to give it one.
       */
      'apps/api/src/**/*.integration.test.ts',
    ],
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
      /**
       * Relative to `root` (= repoRoot) → root-relative `SF:` paths, which is what Sonar
       * needs to match these against `sonar.sources`.
       *
       * ⚠ WIDENED TO TRACK `include` ABOVE. BAL-428 added `apps/api/src/**` to the test
       * `include`, and leaving this at `packages/db/src/**` meant the ONE thing that file
       * proves end-to-end — `services/meetings/meeting-availability.ts` and
       * `services/availability/resolve-and-cache.ts` driving a real booking through a real
       * resolver — contributed ZERO covered lines to the report. Sonar's LCOV importer
       * MERGES `coverage/lcov.info` (the unit run) with `coverage-integration/lcov.info`
       * (this one) and takes a line as covered if ANY report covers it, so widening can
       * only add coverage; the 0-hit records this now emits for `apps/api` files the
       * integration run never touches cannot un-cover what the unit run already covered.
       */
      include: ['packages/db/src/**', 'apps/api/src/**'],
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
