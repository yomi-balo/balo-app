import { test, expect } from '@playwright/test';

test.describe('Homepage', () => {
  test('loads successfully', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Balo/);
  });

  test('shows main content', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Get started by editing')).toBeVisible();
  });
});
