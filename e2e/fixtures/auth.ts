import { test as base, expect } from '@playwright/test';

/**
 * E2E auth fixture. Seeds an iron-session cookie for a deterministic test user in a
 * chosen onboarding state by POSTing to the secret-gated `/api/auth/test-login` route
 * (WorkOS is bypassed). The route is guarded by a server-side secret: it is inert (404)
 * whenever `E2E_TEST_SECRET` is unset (production), independent of `NODE_ENV`/platform.
 * This fixture authenticates by sending the matching secret in the `x-e2e-secret` header,
 * so it only succeeds against a server that has `E2E_TEST_SECRET` set (the seeded-E2E
 * harness: ephemeral Postgres + `WORKOS_COOKIE_PASSWORD` + `E2E_TEST_SECRET`).
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
        headers: { 'x-e2e-secret': process.env.E2E_TEST_SECRET ?? '' },
        data: { onboardingCompleted },
      });
      if (!response.ok()) {
        throw new Error(
          `test-login seeding failed (${response.status()}) — is the seeded-E2E harness up ` +
            `(E2E_TEST_SECRET set on the server + matching header, plus a reachable Postgres)?`
        );
      }
    });
  },
});

export { expect };
