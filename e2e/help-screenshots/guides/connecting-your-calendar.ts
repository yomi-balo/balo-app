import type { Page } from '@playwright/test';
import { defineGuide } from '../guide';

const SCHEDULE_ROUTE = '/expert/settings?tab=schedule';
/** Settings cards fade in; wait for the entrance to finish. */
const SETTLE_MS = 1500;

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(SETTLE_MS);
}

async function openAddMenu(page: Page): Promise<void> {
  await settle(page);
  await page.getByRole('button', { name: 'Add calendar' }).click();
}

function calendarsCard(page: Page): ReturnType<Page['locator']> {
  return page
    .locator('[aria-labelledby]')
    .filter({ has: page.getByRole('heading', { name: 'Calendars' }) })
    .last();
}

defineGuide('connecting-your-calendar', [
  {
    section: 1,
    as: 'expert',
    state: 'available',
    route: SCHEDULE_ROUTE,
    setup: openAddMenu,
    target: (page) => page.getByRole('menu'),
    cropPadding: 40,
  },
  {
    section: 2,
    as: 'expert',
    state: 'available',
    route: SCHEDULE_ROUTE,
    setup: settle,
    target: (page) => page.getByRole('listitem').filter({ hasText: 'Connected' }).first(),
  },
  {
    section: 3,
    as: 'expert',
    state: 'calendar-pending',
    route: SCHEDULE_ROUTE,
    setup: settle,
    target: (page) => page.getByRole('button', { name: 'Fix permissions' }),
    crop: (page) =>
      page
        .getByRole('listitem')
        .filter({ has: page.getByRole('button', { name: 'Fix permissions' }) })
        .first(),
    cropPadding: 8,
  },
  {
    section: 4,
    as: 'expert',
    state: 'available',
    route: SCHEDULE_ROUTE,
    setup: async (page) => {
      await openAddMenu(page);
      await page.getByRole('menuitem', { name: /Microsoft Outlook/ }).click();
    },
    target: (page) => page.getByRole('button', { name: 'Continue to Microsoft 365' }),
    crop: (page) => page.getByRole('dialog'),
    cropPadding: 8,
  },
  {
    section: 5,
    as: 'expert',
    state: 'available',
    route: `${SCHEDULE_ROUTE}&calendar_error=o365_admin_approval`,
    setup: settle,
    target: (page) => page.getByRole('button', { name: 'Try connecting again' }),
    crop: (page) =>
      page
        .getByRole('listitem')
        .filter({ has: page.getByRole('button', { name: 'Try connecting again' }) })
        .first(),
    cropPadding: 8,
  },
  {
    section: 6,
    as: 'expert',
    state: 'available',
    route: SCHEDULE_ROUTE,
    setup: settle,
    target: (page) => page.getByText(/Events on any connected calendar block that time/),
    crop: (page) => calendarsCard(page),
    cropPadding: 8,
  },
]);
