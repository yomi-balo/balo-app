import { test, expect } from '@playwright/test';

/**
 * BAL-493 — the marketing home route (`(marketing)/page.tsx`). Covers the anonymous-visitor
 * path only (`/` is in `PUBLIC_PATHS`); the signed-in/un-onboarded redirect variants are
 * already covered by `onboarding-gate.spec.ts`.
 */
test.describe('Homepage', () => {
  test('loads successfully with a Balo title', async ({ page }) => {
    await page.goto('/');
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
    const tile = page.locator('[data-bench-tile]').first();
    await tile.scrollIntoViewIfNeeded();
    await tile.click();
    await expect(page).toHaveURL(/\/experts\?.*products=/);
  });
});
