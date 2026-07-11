import { test as base, expect } from '@playwright/test';

/**
 * E2E auth fixture. Seeds an iron-session cookie for a deterministic test user in a
 * chosen onboarding state by POSTing to the env-guarded `/api/auth/test-login` route
 * (WorkOS is bypassed). The route is inert unless `E2E_TEST_AUTH=1` AND
 * `NODE_ENV !== 'production'`, so this fixture only works against a non-prod build. The
 * seeded specs that use this fixture are skipped in CI until the seeded-E2E harness
 * (ephemeral Postgres + session secret + flag) lands in BAL-363; they run locally when
 * `E2E_TEST_SECRET` is set (and the server has `E2E_TEST_AUTH=1`).
 */
type SeedOptions = { onboardingCompleted: boolean };

type AuthFixtures = {
  /** Seed the browser context with a session in the given onboarding state. */
  seedSession: (opts: SeedOptions) => Promise<void>;
};

export const test = base.extend<AuthFixtures>({
  seedSession: async ({ page }, use) => {
    await use(async ({ onboardingCompleted }: SeedOptions) => {
      const response = await page.request.post('/api/auth/test-login', {
        data: { onboardingCompleted },
      });
      if (!response.ok()) {
        throw new Error(
          `test-login seeding failed (${response.status()}) — is the seeded-E2E harness up ` +
            `(E2E_TEST_AUTH=1 on a non-prod server, Postgres + session secret)? See BAL-363.`
        );
      }
    });
  },
});

export { expect };
