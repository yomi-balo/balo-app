import type { Page } from '@playwright/test';
import { defineGuide } from '../guide';

const SCHEDULE_ROUTE = '/expert/settings?tab=schedule';
/** Settings cards fade in; wait for the entrance to finish. */
const SETTLE_MS = 1500;

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(SETTLE_MS);
}

async function openTimeOff(page: Page): Promise<void> {
  await settle(page);
  const addButton = page.getByRole('button', { name: 'Add time off' });
  // Bring the card to the top of the viewport so the popover opens fully on screen.
  await addButton.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await addButton.click();
}

/** "Monday, October 19th, 2026": the accessible name of that day in the date picker. */
function dayButtonName(isoDate: string): RegExp {
  const date = new Date(`${isoDate}T00:00:00Z`);
  const day = date.getUTCDate();
  const suffix =
    day % 10 === 1 && day !== 11
      ? 'st'
      : day % 10 === 2 && day !== 12
        ? 'nd'
        : day % 10 === 3 && day !== 13
          ? 'rd'
          : 'th';
  const weekday = date.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const month = date.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  return new RegExp(`${weekday}, ${month} ${day}${suffix}, ${date.getUTCFullYear()}`);
}

defineGuide('weekly-schedule', [
  {
    section: 1,
    as: 'expert',
    state: 'available',
    route: SCHEDULE_ROUTE,
    setup: settle,
    target: (page) => page.getByText('Weekly hours', { exact: true }).locator('xpath=..'),
  },
  {
    section: 2,
    as: 'expert',
    state: 'available',
    route: SCHEDULE_ROUTE,
    setup: settle,
    target: (page) => page.getByText(/^Hours are set in/).locator('xpath=ancestor::div[1]'),
  },
  {
    section: 3,
    as: 'expert',
    state: 'overnight',
    route: SCHEDULE_ROUTE,
    setup: settle,
    target: (page) => page.getByText('Continues into Saturday'),
    crop: (page) =>
      page
        .getByText('Continues into Saturday')
        .locator('xpath=ancestor::div[contains(@class, "group/day")][1]'),
  },
  {
    section: 4,
    as: 'expert',
    state: 'available',
    route: SCHEDULE_ROUTE,
    setup: openTimeOff,
    target: (page) => page.getByRole('dialog'),
    cropPadding: 24,
  },
  {
    section: 5,
    as: 'expert',
    state: 'available',
    route: SCHEDULE_ROUTE,
    setup: async (page) => {
      await openTimeOff(page);
      await page
        .getByRole('dialog')
        .getByRole('button', { name: dayButtonName(process.env.HELP_ANCHOR ?? '') })
        .click();
      await page.getByRole('button', { name: 'Block these dates' }).click();
    },
    target: (page) => page.getByRole('alertdialog'),
    cropPadding: 24,
  },
]);
