import type { Locator, Page } from '@playwright/test';
import { defineGuide } from '../guide';
import type { Box } from '../ring';

/** The fixed-price "Sales Cloud rollout" project (`HELP_WORLD_IDS`). */
const PROJECT_ROUTE = '/engagements/b1a10598-0000-4000-8000-00000000110a';
/** The page's cards fade in; wait for the entrance to finish. */
const SETTLE_MS = 1500;
/** Space kept around a hand-computed crop. */
const GUTTER = 16;
/** Side and bottom space around a banner: clears its highlight ring and glow. */
const BANNER_GUTTER = 20;

async function settle(page: Page): Promise<void> {
  // The feedback launcher floats over the bottom-right corner of every page.
  await page.addStyleTag({ content: '#__ybug-launcher { display: none !important; }' });
  await page.waitForTimeout(SETTLE_MS);
  // Park the pointer so no row carries a hover tint.
  await page.mouse.move(0, 0);
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(`handling-a-change-request: ${locator.toString()} has no box`);
  }
  return box;
}

const banner = (page: Page, text: string): Locator =>
  page.getByRole('region', { name: 'Change request' }).filter({ hasText: text });

const deliveryPlan = (page: Page): Locator =>
  page.locator('[data-slot="card"]').filter({ hasText: 'Delivery plan' });

/** A milestone row on the delivery plan, from its rail node to its actions. */
const milestoneRow = (page: Page, title: string): Locator =>
  deliveryPlan(page)
    .getByText(title, { exact: true })
    .locator('xpath=ancestor::div[contains(@class, "gap-4")][1]');

/**
 * From the project's title down to the banner, so the frame says which page it is. The top edge
 * sits just above the title, clear of the back link over it (the runner pads by 0 here).
 */
async function titleToBanner(page: Page, target: Box): Promise<Box> {
  const title = await boxOf(
    page.getByRole('main').getByRole('heading', { name: 'Sales Cloud rollout' })
  );
  const y = title.y - 4;
  return {
    x: target.x - BANNER_GUTTER,
    y,
    width: target.width + BANNER_GUTTER * 2,
    // Just the ring's reach below the banner: the next card's border starts 20px down.
    height: target.y + target.height + 17 - y,
  };
}

defineGuide('handling-a-change-request', [
  {
    section: 1,
    as: 'expert',
    state: 'change-round',
    route: PROJECT_ROUTE,
    setup: settle,
    target: (page) => banner(page, 'requested changes'),
    cropArea: titleToBanner,
    cropPadding: 0,
  },
  {
    section: 2,
    as: 'expert',
    state: 'change-round',
    route: PROJECT_ROUTE,
    setup: settle,
    target: (page) => page.getByText(/^Dana requested changes · /).locator('xpath=..'),
    // Centring the reopened milestone's description leaves the plan, from its heading down to the
    // last milestone's dates, clear of the sticky top bar.
    crop: (page) => milestoneRow(page, 'Build and configure').getByText(/^Opportunity stages/),
    cropArea: async (page) => {
      const card = await boxOf(deliveryPlan(page));
      const lastDates = await boxOf(
        milestoneRow(page, 'Data migration').getByText(/^Started .* Completed /)
      );
      // Ends just under the last milestone's dates, above its "Move back to in progress".
      return {
        x: card.x - 8,
        y: card.y - 8,
        width: card.width + 16,
        height: lastDates.y + lastDates.height + 8 - (card.y - 8),
      };
    },
    cropPadding: 0,
  },
  {
    section: 3,
    as: 'expert',
    state: 'change-round',
    route: PROJECT_ROUTE,
    setup: settle,
    target: (page) =>
      milestoneRow(page, 'Discovery and design').getByRole('button', {
        name: 'Move back to in progress',
      }),
    crop: (page) => milestoneRow(page, 'Discovery and design'),
    // The row's own bottom padding is the gap before the next milestone; stop there.
    cropArea: async (page) => {
      const row = await boxOf(milestoneRow(page, 'Discovery and design'));
      return {
        x: row.x - GUTTER,
        y: row.y - GUTTER,
        width: row.width + GUTTER * 2,
        height: row.height + GUTTER - 4,
      };
    },
    cropPadding: 0,
  },
  {
    section: 4,
    as: 'expert',
    state: 'changes-made',
    route: PROJECT_ROUTE,
    setup: settle,
    target: (page) => banner(page, 'Changes made'),
    cropArea: titleToBanner,
    cropPadding: 0,
  },
  {
    section: 5,
    as: 'expert',
    state: 'changes-made',
    route: PROJECT_ROUTE,
    setup: async (page) => {
      await settle(page);
      await banner(page, 'Changes made')
        .getByRole('button', { name: 'Mark project ready again' })
        .click();
      await page.getByRole('dialog').waitFor();
    },
    target: (page) =>
      page
        .getByRole('dialog')
        .getByRole('button', { name: "Send for Northwind Industrial's review" }),
    // Only the window: the dimmed page around it would be cut mid-line.
    crop: (page) => page.getByRole('dialog'),
    cropPadding: 0,
  },
]);
