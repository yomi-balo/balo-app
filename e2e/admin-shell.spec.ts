import { test, expect } from './fixtures/auth';

/**
 * BAL-534 — the `/admin` gate from the outside.
 *
 * ⚠ NO "staff sees the group" ARM (orchestrator D2). `/api/auth/test-login` hardcodes
 * `platformRole: 'user'` and REFUSES before mutating if the derived account is elevated, and
 * the fixture exposes only `onboardingCompleted` — minting a staff session would mean widening
 * a deliberately hardened auth seam. The staff side is covered at the unit/component layer:
 * `nav-context.test.ts`, `nav-registry.test.ts`, `sidebar.test.tsx`, `mobile-more-sheet.test.tsx`,
 * `command-palette.test.tsx`, and the `/admin` layout + page suites.
 *
 * ⚠ BAL-551 EXTENDS THIS FILE WITH `/admin/lookup`'s NON-STAFF ARM ONLY, FOR THE SAME REASON.
 * The `persona: z.enum(['member','staff'])` fix that would unlock a staff arm here is BAL-548's,
 * already ruled as its own diff (BAL-551 scope ruling, cut 5) — widening the secret-gated,
 * prod-smoke-tested `test-login` route here would collide with it. Lookup's staff path is
 * covered at the unit/component layer instead: `page.test.tsx`, `load-lookup.test.ts`,
 * `lookup-shell.test.tsx` and the rest of the `admin/lookup` suite.
 */
test.describe('admin shell — signed out', () => {
  test('GET /admin/catalogue signed out lands on /login', async ({ page }) => {
    await page.goto('/admin/catalogue');
    await expect(page).toHaveURL(/\/login/);
  });

  test('GET /admin/lookup signed out lands on /login', async ({ page }) => {
    await page.goto('/admin/lookup');
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('admin shell — signed in, non-staff', () => {
  test.skip(!process.env.E2E_TEST_SECRET, 'requires the seeded-E2E harness env (E2E_TEST_SECRET)');

  test('non-staff is bounced from /admin/catalogue to /dashboard', async ({
    page,
    seedSession,
  }) => {
    await seedSession({ onboardingCompleted: true });
    await page.goto('/admin/catalogue');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('non-staff is bounced from the bare /admin to /dashboard', async ({ page, seedSession }) => {
    await seedSession({ onboardingCompleted: true });
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  // BAL-551 — no staff arm here (B4): see this file's header docblock.
  test('non-staff is bounced from /admin/lookup to /dashboard', async ({ page, seedSession }) => {
    await seedSession({ onboardingCompleted: true });
    await page.goto('/admin/lookup');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('non-staff sees no Balo admin group in the shell', async ({ page, seedSession }) => {
    await seedSession({ onboardingCompleted: true });
    await page.goto('/dashboard');
    await expect(page.getByTestId('sidebar-admin-group')).toHaveCount(0);
  });
});
