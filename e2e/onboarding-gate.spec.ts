import { test, expect } from './fixtures/auth';

/**
 * BAL-361 (B2) — the fail-closed middleware onboarding gate. An authenticated but
 * un-onboarded user can reach ONLY onboarding routes; every other route (protected
 * AND public marketing/marketplace) redirects them to `/onboarding`. Onboarded users
 * browse normally. No WorkOS is needed — the session is seeded via `/api/auth/test-login`.
 */
test.describe('onboarding gate (fail-closed)', () => {
  test('un-onboarded user is redirected from a protected route to /onboarding', async ({
    page,
    seedSession,
  }) => {
    await seedSession({ onboardingCompleted: false });
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/onboarding/);
  });

  test('un-onboarded user is redirected from a public marketplace route (/experts)', async ({
    page,
    seedSession,
  }) => {
    await seedSession({ onboardingCompleted: false });
    await page.goto('/experts');
    await expect(page).toHaveURL(/\/onboarding/);
  });

  test('un-onboarded user is redirected from a public route (/pricing)', async ({
    page,
    seedSession,
  }) => {
    await seedSession({ onboardingCompleted: false });
    await page.goto('/pricing');
    await expect(page).toHaveURL(/\/onboarding/);
  });

  test('onboarded user still browses public routes (/experts stays)', async ({
    page,
    seedSession,
  }) => {
    await seedSession({ onboardingCompleted: true });
    await page.goto('/experts');
    await expect(page).toHaveURL(/\/experts/);
  });
});
