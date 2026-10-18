import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Help-screenshot runner. Deliberately separate from the root `playwright.config.ts`, which
 * `testIgnore`s this folder: it seeds a fixture into the DB and writes PNGs into the repo, so it
 * must only ever run on request (`pnpm help:screenshots [slug]`). The positional `[slug]` is
 * Playwright's file filter over `guides/<slug>.ts`.
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'guides/*.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  use: { baseURL: 'http://localhost:3000' },
  projects: (['light', 'dark'] as const).map((colorScheme) => ({
    name: colorScheme,
    // The device spread comes FIRST: it carries its own viewport and DPR, which would otherwise
    // override these.
    use: {
      ...devices['Desktop Chrome'],
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
      contextOptions: { reducedMotion: 'reduce' as const },
      locale: 'en-AU',
      timezoneId: 'UTC',
      colorScheme,
    },
  })),
  webServer: {
    command: 'pnpm build && pnpm start',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    cwd: path.resolve(__dirname, '../../apps/web'),
    timeout: 900_000,
  },
});
