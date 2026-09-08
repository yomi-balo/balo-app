import { test, expect } from './fixtures/auth';

/**
 * BAL-534 — the `/admin` gate from the outside.
 *
 * BAL-548 opened a persona seam on `/api/auth/test-login`: the request body can select a
 * CLOSED `persona` (`'member' | 'staff'`), and `'staff'` mints a session with
 * `platformRole: 'admin'` (never `'super_admin'`) on a fixed `staff-e2e@balo.test` identity —
 * the route still refuses before mutating if the derived account's existing role doesn't match
 * the persona's expected role, in both directions. That closes the gap this file used to
 * document: the "staff sees the group" arm below now exercises the real `/admin` gate end to
 * end, on top of the unit/component coverage that already existed
 * (`nav-context.test.ts`, `nav-registry.test.ts`, `sidebar.test.tsx`, `mobile-more-sheet.test.tsx`,
 * `command-palette.test.tsx`, and the `/admin` layout + page suites).
 *
 * ⚠ BAL-551 landed `/admin/lookup`'s NON-STAFF arm only, and deferred the staff arm to exactly
 * this seam (BAL-551 scope ruling, cut 5 — "the `persona` fix that would unlock a staff arm
 * here is BAL-548's"). The seam now exists, so a lookup staff arm is UNBLOCKED. It is
 * deliberately not added here — out of BAL-548's scope — so lookup's staff path stays covered
 * at the unit/component layer for now: `page.test.tsx`, `load-lookup.test.ts`,
 * `lookup-shell.test.tsx` and the rest of the `admin/lookup` suite. Adding it is a one-line
 * `persona: 'staff'` change to a seeded fixture whenever someone picks it up.
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

test.describe('admin shell — signed in, staff', () => {
  test.skip(!process.env.E2E_TEST_SECRET, 'requires the seeded-E2E harness env (E2E_TEST_SECRET)');

  test('staff sees the Balo admin group in the shell', async ({ page, seedSession }) => {
    await seedSession({ onboardingCompleted: true, persona: 'staff' });
    await page.goto('/dashboard');
    await expect(page.getByTestId('sidebar-admin-group')).toBeVisible();
  });

  test('staff reaches /admin/catalogue instead of being bounced', async ({ page, seedSession }) => {
    await seedSession({ onboardingCompleted: true, persona: 'staff' });
    await page.goto('/admin/catalogue');
    await expect(page).toHaveURL(/\/admin\/catalogue/);
    // BAL-548 F5: the URL alone is satisfied by a 404 — `notFound()` in
    // `(dashboard)/admin/layout.tsx` renders Next's built-in 404 AT THE SAME URL (its own
    // docblock says so), and the layout's gate is a separate call site from middleware's. Assert
    // the page actually RENDERED: the page-level `<h2>` at `admin/catalogue/page.tsx:44`.
    // `level: 2` is required — the shell's breadcrumb renders an `<h1>` with the same text
    // ("Config & catalogue"), so an unqualified name match would be ambiguous between the two.
    await expect(page.getByRole('heading', { level: 2, name: 'Config & catalogue' })).toBeVisible();
  });
});
