import type { Page } from '@playwright/test';
import { HELP_IDS } from '../../../packages/db/src/help-seed/constants';
import { defineGuide } from '../guide';

/** Pages fade their content in; wait for the entrance to finish before measuring. */
const SETTLE_MS = 1500;

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(SETTLE_MS);
}

const PROFILE_ROUTE = '/experts/priya-raman';
/** Vertical room around the length control: the label above, the billing note and calendar top below. */
const PICKER_ABOVE_PX = 40;
const PICKER_BELOW_PX = 260;
const CASE_ROUTE = `/cases/${HELP_IDS.engagement}`;

/** Opens the booking dialog from the expert profile and continues with the first 60-minute time. */
async function pickFirstTime(page: Page): Promise<void> {
  await settle(page);
  await page.getByRole('button', { name: 'Book a consultation' }).click();
  const dialog = page.getByRole('dialog');
  // The browser clock is frozen on the anchor Monday, so "Today" is the first bookable day.
  await dialog.getByRole('button', { name: /^Today, / }).click();
  await dialog
    .getByRole('list')
    .getByRole('button', { name: /^10:00 – 11:00 am/ })
    .click();
  await dialog.getByRole('button', { name: /^Continue with/ }).click();
}

defineGuide('booking-a-consultation', [
  {
    section: 1,
    as: 'client',
    state: 'available',
    route: PROFILE_ROUTE,
    setup: async (page) => {
      await settle(page);
      await page.getByRole('button', { name: 'Book a consultation' }).click();
    },
    target: (page) => page.getByRole('radiogroup', { name: 'How long do you need?' }),
    // The control is only as wide as its options at desktop widths, so the crop takes its
    // horizontal extent from the dialog: label above, billing note and top of the grid below.
    cropArea: async (page, targetBox) => {
      const dialog = await page.getByRole('dialog').boundingBox();
      if (!dialog) {
        throw new Error('Booking dialog has no box');
      }
      return {
        x: dialog.x,
        y: targetBox.y - PICKER_ABOVE_PX,
        width: dialog.width,
        height: targetBox.height + PICKER_BELOW_PX,
      };
    },
    cropPadding: 0,
  },
  {
    section: 3,
    as: 'client',
    state: 'available',
    route: PROFILE_ROUTE,
    setup: async (page) => {
      await pickFirstTime(page);
      // Open cases are listed per company, so the case choice appears once Northwind is chosen.
      await page.getByRole('combobox', { name: /Bill this session to/ }).click();
      await page.getByRole('option', { name: /Northwind Industrial/ }).click();
    },
    target: (page) => page.getByRole('combobox', { name: 'Which case is this for?' }),
    cropArea: async (page, targetBox) => {
      const dialog = await page.getByRole('dialog').boundingBox();
      if (!dialog) {
        throw new Error('Booking dialog has no box');
      }
      return {
        x: dialog.x,
        y: targetBox.y - 190,
        width: dialog.width,
        height: targetBox.height + 270,
      };
    },
    cropPadding: 0,
  },
  {
    section: 4,
    as: 'client',
    state: 'available',
    route: CASE_ROUTE,
    setup: async (page) => {
      await settle(page);
      await page.getByRole('button', { name: 'Reschedule', exact: true }).first().click();
      // The second suggested time: the seed anchor moves with the calendar, so never a fixed date.
      await page
        .getByRole('dialog')
        .getByRole('button', { name: / · \d+ min \(/ })
        .nth(1)
        .click();
    },
    target: (page) => page.getByRole('button', { name: 'Move consultation' }),
    crop: (page) => page.getByRole('dialog'),
    cropPadding: 8,
  },
  {
    section: 5,
    as: 'client',
    state: 'proposal',
    route: CASE_ROUTE,
    setup: settle,
    target: (page) => page.getByRole('region', { name: /Reschedule proposal/ }),
  },
  {
    section: 6,
    as: 'client',
    state: 'available',
    route: CASE_ROUTE,
    setup: async (page) => {
      await settle(page);
      await page.getByRole('button', { name: /^Actions for consultation/ }).click();
      await page.getByRole('menuitem', { name: 'Cancel consultation' }).click();
    },
    target: (page) => page.getByRole('alertdialog').or(page.getByRole('dialog')),
    cropPadding: 8,
  },
  {
    section: 7,
    as: 'client',
    state: 'paused',
    route: PROFILE_ROUTE,
    setup: settle,
    target: (page) =>
      page.locator('.bg-paused-hatch').filter({ hasText: "isn't taking on new work right now" }),
    crop: (page) =>
      page.locator('[data-slot="card"]').filter({ hasText: 'Not taking on new work right now' }),
  },
]);
