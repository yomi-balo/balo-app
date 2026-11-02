import type { Locator, Page } from '@playwright/test';
import { defineGuide } from '../guide';

/** The fixed-price "Sales Cloud rollout" project (`HELP_WORLD_IDS`). */
const PROJECT_ROUTE = '/engagements/b1a10598-0000-4000-8000-00000000110a';
/** The page's cards fade in; wait for the entrance to finish. */
const SETTLE_MS = 1500;

async function settle(page: Page): Promise<void> {
  // The feedback launcher floats over the bottom-right corner of every page.
  await page.addStyleTag({ content: '#__ybug-launcher { display: none !important; }' });
  await page.waitForTimeout(SETTLE_MS);
  // Park the pointer so no row carries a hover tint.
  await page.mouse.move(0, 0);
}

/** "Data migration" on the delivery plan, from its rail node to its actions. */
const dataMigrationRow = (page: Page): Locator =>
  page
    .locator('[data-slot="card"]')
    .filter({ hasText: 'Delivery plan' })
    .getByText('Data migration', { exact: true })
    .locator('xpath=ancestor::div[contains(@class, "gap-4")][1]');

defineGuide('editing-milestones-after-acceptance', [
  {
    section: 1,
    as: 'expert',
    state: 'projects',
    route: PROJECT_ROUTE,
    setup: async (page) => {
      await settle(page);
      await dataMigrationRow(page).getByText('What changed', { exact: true }).click();
      await page.evaluate(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement) {
          active.blur();
        }
      });
      await page.mouse.move(0, 0);
    },
    target: (page) => dataMigrationRow(page).getByText('Changed since proposal', { exact: true }),
    crop: dataMigrationRow,
    cropPadding: 16,
  },
  {
    section: 2,
    as: 'expert',
    state: 'projects',
    route: PROJECT_ROUTE,
    setup: async (page) => {
      await settle(page);
      await page.getByRole('button', { name: 'Remove Data migration' }).click();
      await page.getByRole('dialog').waitFor();
    },
    target: (page) => page.getByRole('dialog').getByRole('link', { name: 'Propose a change' }),
    // Only the window: the dimmed page around it would be cut mid-line.
    crop: (page) => page.getByRole('dialog'),
    cropPadding: 0,
  },
]);
