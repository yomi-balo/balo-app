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
 */
test.describe('admin shell — signed out', () => {
  test('GET /admin/catalogue signed out lands on /login', async ({ page }) => {
    await page.goto('/admin/catalogue');
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

  test('non-staff sees no Balo admin group in the shell', async ({ page, seedSession }) => {
    await seedSession({ onboardingCompleted: true });
    await page.goto('/dashboard');
    await expect(page.getByTestId('sidebar-admin-group')).toHaveCount(0);
  });
});
