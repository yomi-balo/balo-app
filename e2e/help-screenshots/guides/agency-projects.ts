import type { Locator, Page } from '@playwright/test';
import { defineGuide } from '../guide';
import type { Box } from '../ring';

const AGENCY_ROUTE = '/projects?lens=agency';
const LIVE_LIST = 'All live projects';
/** The dash fades in and the tiles stagger in; wait for the entrance to finish. */
const SETTLE_MS = 1500;
/** Space kept around a hand-computed crop (the runner's `cropPadding` is 0 for those). */
const GUTTER = 24;

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(SETTLE_MS);
  // Park the pointer so no row carries a hover tint.
  await page.mouse.move(0, 0);
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(`agency-projects: ${locator.toString()} has no box`);
  }
  return box;
}

/** An open Select marks the rest of the page aria-hidden, so crop lookups include hidden nodes. */
const tilesGrid = (page: Page): Locator =>
  page.getByRole('button', { name: /^Changes requested/, includeHidden: true }).locator('xpath=..');

const firstLiveRow = (page: Page): Locator =>
  page
    .getByRole('region', { name: LIVE_LIST, includeHidden: true })
    .getByRole('link', { includeHidden: true })
    .first();

/** The "Viewing as" pill row that heads the Projects page, above the title. */
const lensRow = (page: Page): Locator =>
  page
    .getByText('Viewing as', { exact: true })
    .locator('xpath=ancestor::div[contains(@class, "mb-4")][1]');

defineGuide('agency-projects', [
  {
    section: 1,
    as: 'expert',
    state: 'agency',
    route: '/projects',
    setup: settle,
    target: (page) =>
      page.getByRole('tablist', { name: 'Portfolio lens' }).getByRole('tab', { name: 'Agency' }),
    cropArea: async (page) => {
      const row = await boxOf(lensRow(page));
      const heading = await boxOf(
        page.locator('h2', { hasText: /^Projects$/ }).locator('xpath=..')
      );
      return {
        x: row.x,
        y: row.y,
        width: row.width,
        height: heading.y + heading.height - row.y,
      };
    },
    cropPadding: 16,
  },
  {
    section: 2,
    as: 'expert',
    state: 'agency',
    route: AGENCY_ROUTE,
    setup: settle,
    target: (page) => page.getByRole('button', { name: /^Changes requested/ }),
    // Centring the first row scrolls the page so the tiles and all five rows fit together, clear
    // of the sticky top bar.
    crop: firstLiveRow,
    cropArea: async (page) => {
      const tiles = await boxOf(tilesGrid(page));
      const lastRow = await boxOf(
        page.getByRole('region', { name: LIVE_LIST }).getByRole('link').last()
      );
      // A smaller gap below the list keeps the collapsed "Completed and cancelled" card out.
      return {
        x: tiles.x - GUTTER,
        y: tiles.y - GUTTER,
        width: tiles.width + GUTTER * 2,
        height: lastRow.y + lastRow.height - tiles.y + GUTTER + 12,
      };
    },
    cropPadding: 0,
  },
  {
    section: 3,
    as: 'expert',
    state: 'agency',
    route: AGENCY_ROUTE,
    setup: async (page) => {
      await settle(page);
      const trigger = await boxOf(page.getByRole('combobox', { name: /^Delivered by:/ }));
      await page.getByRole('combobox', { name: /^Delivered by:/ }).click();
      const list = page.getByRole('listbox');
      await list.waitFor();
      // The item-aligned list is 280px wide and spills 4px past a 1280px window. Line its right
      // edge up with the trigger's, where `align="end"` places it once it fits.
      await list.evaluate((el, right) => {
        const wrapper = el.parentElement;
        if (wrapper) {
          wrapper.style.left = `${right - el.getBoundingClientRect().width}px`;
        }
      }, trigger.x + trigger.width);
    },
    target: (page) => page.getByRole('listbox'),
    cropArea: async (page) => {
      const tiles = await boxOf(tilesGrid(page));
      const firstRow = await boxOf(firstLiveRow(page));
      // Whole pixels, so sub-pixel drift in the list's position cannot change the PNG's size.
      const x = Math.round(tiles.x - GUTTER);
      const y = Math.round(tiles.y - GUTTER);
      return {
        x,
        y,
        width: Math.round(tiles.x + tiles.width + GUTTER) - x,
        height: Math.round(firstRow.y + firstRow.height) - y,
      };
    },
    cropPadding: 0,
  },
  {
    section: 4,
    as: 'expert',
    state: 'agency',
    route: AGENCY_ROUTE,
    setup: settle,
    // Tom's name and the marker under it.
    target: (page) => page.getByText('No longer at CloudPeak Consulting').locator('xpath=..'),
    crop: (page) => page.getByRole('link', { name: /^CPQ pricing rules cleanup/ }),
    cropPadding: 16,
  },
  {
    section: 5,
    as: 'expert',
    state: 'agency-multi',
    route: AGENCY_ROUTE,
    setup: async (page) => {
      await settle(page);
      await page.getByRole('combobox', { name: /^Agency:/ }).click();
    },
    target: (page) => page.getByRole('listbox'),
    cropArea: async (page) => {
      const row = await boxOf(lensRow(page));
      const tiles = await boxOf(tilesGrid(page));
      // A smaller gap below the tiles keeps the list's header row out.
      return {
        x: row.x - GUTTER,
        y: row.y - GUTTER,
        width: row.width + GUTTER * 2,
        height: tiles.y + tiles.height - row.y + GUTTER + 12,
      };
    },
    cropPadding: 0,
  },
  {
    section: 6,
    as: 'expert',
    state: 'agency',
    route: AGENCY_ROUTE,
    setup: async (page) => {
      await settle(page);
      await page.getByRole('button', { name: /unread notifications?$/ }).click();
    },
    target: (page) =>
      page
        .getByRole('dialog', { name: 'Notifications' })
        .getByRole('button', { name: /^Changes requested/ }),
    // From the top bar (search and bell) down to the panel's foot, starting just left of the
    // list's "Delivered by" column heading so no text under the panel is cut at the edge.
    cropArea: async (page) => {
      const panel = await boxOf(page.getByRole('dialog', { name: 'Notifications' }));
      const heading = await boxOf(
        page
          .getByRole('region', { name: LIVE_LIST })
          .locator('div[aria-hidden="true"] > span')
          .nth(1)
      );
      const x = heading.x - 3;
      return {
        x,
        y: 0,
        width: panel.x + panel.width + 16 - x,
        height: panel.y + panel.height + 8,
      };
    },
    cropPadding: 0,
  },
]);
