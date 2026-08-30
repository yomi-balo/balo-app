import { test, expect } from '@playwright/test';

/**
 * BAL-493 — the marketing home route (`(marketing)/page.tsx`). Covers the anonymous-visitor
 * path only (`/` is in `PUBLIC_PATHS`); the signed-in/un-onboarded redirect variants are
 * already covered by `onboarding-gate.spec.ts`.
 *
 * ⚠⚠ THE CI DATABASE HAS NO REFERENCE DATA. The E2E job brings up an ephemeral Postgres and
 * runs `db:migrate`, but there is NO seed step — "Run migrations against ephemeral Postgres" is
 * the only DB step in `ci.yml`. The "seeded-E2E harness" its env block refers to seeds a
 * SESSION via `/api/auth/test-login` (BAL-363), not `verticals` / `categories` / `products`.
 *
 * So on `/` in CI, `loadSearchTaxonomy()` returns an empty taxonomy, which BY DESIGN drops all
 * 18 bench tiles and all 7 "Popular" chips (plan §6.3 — the page degrades rather than throwing).
 * Everything asserted unconditionally here must therefore hold with ZERO reference data;
 * anything needing a populated taxonomy is guarded with `test.skip(...)` and a reason, the same
 * pattern `onboarding-gate.spec.ts:14` uses for its own environmental precondition.
 */
test.describe('Homepage', () => {
  test('serves / with a 200 and a Balo title, even with no seeded taxonomy', async ({ page }) => {
    // The status assertion is the point, not decoration: `loadHomeData()` fetches experts AND
    // the taxonomy server-side and MUST fail open (plan §6.3, hardened in the B3 fix — the
    // spotlight reads are `Promise.allSettled` and the mapper block is guarded). An empty
    // database is exactly the condition that would expose a throw, so this pins the fail-open
    // contract rather than merely smoke-testing that the route exists.
    const response = await page.goto('/');
    expect(response?.ok()).toBe(true);
    await expect(page).toHaveTitle(/Balo/);
  });

  test('has exactly one h1 announcing "on demand"', async ({ page }) => {
    await page.goto('/');
    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toHaveCount(1);
    await expect(h1).toContainText('on demand');
  });

  test('hero search submits to /experts', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('search')
      .getByRole('button', { name: /find experts/i })
      .click();
    await expect(page).toHaveURL(/\/experts/);
  });

  test('a bench tile navigates to /experts filtered by product', async ({ page }) => {
    await page.goto('/');
    const tiles = page.locator('[data-bench-tile]');

    // SKIPPED, not silently passed, wherever the taxonomy is empty — see the file docblock.
    // Tile resolution itself needs no database and is covered by
    // `lib/marketing/bench-tiles.test.ts` (whose fixture is built from `packages/db/src/seed.ts`'s
    // real 39 products, deliberately NOT from the constant under test), and the delegated click
    // by `_home/bench-rows.test.tsx`. This spec adds the one thing those cannot: that a real
    // built page navigates.
    const count = await tiles.count();
    test.skip(
      count === 0,
      'requires a seeded product taxonomy — the E2E job migrates but does not seed reference data'
    );

    const tile = tiles.first();
    await tile.scrollIntoViewIfNeeded();
    await tile.click();
    await expect(page).toHaveURL(/\/experts\?.*products=/);
  });
});
