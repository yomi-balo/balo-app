import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: process.env.CI ? 'pnpm build && pnpm start' : 'pnpm dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    cwd: './apps/web',
    /**
     * ⚠ MUST be set explicitly. Playwright's default is 60_000ms, and in CI this command is
     * a FULL Next production build (`pnpm build`) before `pnpm start` ever binds the port —
     * so the default budgets a whole production build at one minute.
     *
     * That default was never comfortable, it was merely *survivable*: main's build landed a
     * few seconds under 60s, so the job passed and the margin was invisible. BAL-408 added a
     * route (`/join/[token]`), a Sentry-scrubbing module and their tests, the build crossed
     * 60s, and E2E failed with `Timed out waiting 60000ms from config.webServer` having run
     * ZERO tests — a failure that names nothing about the change that caused it.
     *
     * The next PR to add a route would have hit this regardless of BAL-408, so the timeout is
     * the defect, not the build. 300s leaves real headroom on a cold CI runner; if a build
     * ever genuinely needs more than that, the build is the thing to fix.
     */
    timeout: 300_000,
  },
});
