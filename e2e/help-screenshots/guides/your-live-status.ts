import type { Locator, Page } from '@playwright/test';
import { defineGuide } from '../guide';
import type { Box } from '../ring';

const SCHEDULE_ROUTE = '/expert/settings?tab=schedule';
/** Settings cards fade in; wait for the entrance to finish. */
const SETTLE_MS = 1000;
/** The popover zooms and fades in after the click. */
const POPOVER_SETTLE_MS = 300;

function statusPanel(page: Page, title: string): Locator {
  return page.getByRole('dialog', { name: title });
}

/** Opens the status pill under Priya's name in the sidebar. */
async function openPill(page: Page, label: string, title: string): Promise<void> {
  await page.waitForTimeout(SETTLE_MS);
  // The panel overhangs the page beside the sidebar; blank that page so its text is not cut
  // mid-word at the frame's right edge. Layout is unchanged (visibility only).
  await page.addStyleTag({ content: 'aside + div > * { visibility: hidden !important; }' });
  await page.locator('aside').getByRole('button', { name: label, exact: true }).click();
  await statusPanel(page, title).waitFor();
  await page.waitForTimeout(POPOVER_SETTLE_MS);
  await page.mouse.move(0, 0);
}

/** From the sidebar's top-left (logo, avatar, name and pill) to the open panel's far corner. */
async function sidebarToPanel(page: Page, title: string): Promise<Box> {
  const [sidebar, panel] = await Promise.all([
    page.locator('aside').first().boundingBox(),
    statusPanel(page, title).boundingBox(),
  ]);
  if (!sidebar || !panel) {
    throw new Error('Sidebar or status panel has no box');
  }
  return {
    x: sidebar.x,
    y: sidebar.y,
    width: panel.x + panel.width + 16 - sidebar.x,
    height: panel.y + panel.height + 16 - sidebar.y,
  };
}

const AWAY_TITLE = "You're not taking on new work";
const LIVE_TITLE = "You're live on the marketplace";

defineGuide('your-live-status', [
  {
    section: 1,
    as: 'expert',
    state: 'paused',
    route: SCHEDULE_ROUTE,
    setup: (page) => openPill(page, 'Not taking work', AWAY_TITLE),
    target: (page) => statusPanel(page, AWAY_TITLE),
    cropArea: (page) => sidebarToPanel(page, AWAY_TITLE),
    cropPadding: 0,
  },
  {
    section: 2,
    as: 'expert',
    state: 'available',
    route: SCHEDULE_ROUTE,
    setup: (page) => openPill(page, 'Live', LIVE_TITLE),
    target: (page) =>
      statusPanel(page, LIVE_TITLE).getByRole('link', { name: /View public profile/ }),
    cropArea: (page) => sidebarToPanel(page, LIVE_TITLE),
    cropPadding: 0,
  },
]);
