import { test as base, expect } from '@playwright/test';

/**
 * E2E auth fixture. Seeds an iron-session cookie for a deterministic test user in a
 * chosen onboarding state by POSTing to the env-guarded `/api/auth/test-login` route
 * (WorkOS is bypassed). The route is inert unless `E2E_TEST_AUTH=1` and
 * `NODE_ENV !== 'production'`, so this fixture only works against a test build.
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
          `test-login seeding failed (${response.status()}) — is E2E_TEST_AUTH=1 set on the server?`
        );
      }
    });
  },
});

export { expect };
