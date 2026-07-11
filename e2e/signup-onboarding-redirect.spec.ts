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
 * signup/page.test.tsx, login/page.test.tsx). The server-side WorkOS stub is tracked in
 * a follow-on ticket.
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
  // Seeded via /api/auth/test-login (seeded-E2E harness: ephemeral Postgres +
  // WORKOS_COOKIE_PASSWORD + E2E_TEST_SECRET). Runs green in CI, where E2E_TEST_SECRET is
  // set; `E2E_TEST_SECRET` doubles as the un-skip switch, so a bare local `pnpm test:e2e`
  // skips these instead of failing. The dismiss describe above stays unconditional.
  test.skip(!process.env.E2E_TEST_SECRET, 'requires the seeded-E2E harness env (E2E_TEST_SECRET)');

  for (const target of ['/dashboard', '/experts', '/pricing']) {
    test(`cannot reach ${target}`, async ({ page, seedSession }) => {
      await seedSession({ onboardingCompleted: false });
      await page.goto(target);
      await expect(page).toHaveURL(/\/onboarding/);
    });
  }
});
