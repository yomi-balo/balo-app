import { test, expect } from './fixtures/auth';

/**
 * BAL-361 (B1) — the signup/login → /onboarding redirect race. The `/signup` and
 * `/login` pages must bounce home ONLY on a genuine dismiss, and must NOT override the
 * auth step's `router.push('/onboarding')` on success. The deterministic guarantee is
 * fully covered by the component tests (auth-modal-provider + signup/login page state
 * machines); these E2E specs cover the real dismiss flow end-to-end.
 */
test.describe('signup/login dismiss returns home', () => {
  test('dismissing the signup modal returns to /', async ({ page }) => {
    await page.goto('/signup');
    // The auth modal renders as a dialog; wait for it, then dismiss with Escape.
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL('/');
  });

  test('dismissing the login modal returns to /', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL('/');
  });
});

/**
 * DEFERRED (tier 2): the success-race spec needs a server-side WorkOS stub behind
 * `E2E_MOCK_WORKOS=1` so `signUpAction`/`signInAction` can return
 * `{ success: true, verified: true, needsOnboarding: true }` without a real WorkOS
 * round-trip. Once that stub exists, fill the signup form, submit, assert the URL
 * settles on `/onboarding` and never bounces back to `/` (proving the timer is gone,
 * independent of `/onboarding` compile latency). Until then, the deterministic B1
 * guarantee is covered by the component tests (auth-modal-provider.test.tsx,
 * signup/page.test.tsx, login/page.test.tsx).
 */
test.fixme('signup success lands on /onboarding and never bounces back to / (needs E2E_MOCK_WORKOS)', async ({
  page,
}) => {
  await page.goto('/signup');
  // Intentionally unimplemented — see the comment above (deferred E2E_MOCK_WORKOS stub).
  await expect(page).toHaveURL(/\/onboarding/);
});

/**
 * BAL-361 (B2 companion) — a returning un-onboarded user cannot reach any non-onboarding
 * route: each attempt lands on `/onboarding`. Uses the seeded session (no WorkOS).
 */
test.describe('returning un-onboarded user is gated to /onboarding', () => {
  // Seeded via /api/auth/test-login (seeded-E2E CI harness). Skip in CI until BAL-363
  // lands; runs locally when E2E_TEST_SECRET is present. The dismiss describe above stays
  // unconditional.
  test.skip(!process.env.E2E_TEST_SECRET, 'needs seeded-E2E CI infra — BAL-363');

  for (const target of ['/dashboard', '/experts', '/pricing']) {
    test(`cannot reach ${target}`, async ({ page, seedSession }) => {
      await seedSession({ onboardingCompleted: false });
      await page.goto(target);
      await expect(page).toHaveURL(/\/onboarding/);
    });
  }
});
