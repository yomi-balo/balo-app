import type { Locator, Page } from '@playwright/test';
import { HELP_WORLD_IDS } from '../../../packages/db/src/help-seed/constants';
import { defineGuide } from '../guide';
import type { Box } from '../ring';

/**
 * The fixed-price "Sales Cloud territory planning" project. Only this client guide shows it, so
 * its client price never sits beside an expert-side figure for the same project.
 */
const PROJECT_ROUTE = `/engagements/${HELP_WORLD_IDS.territory.engagement}`;
/** The page's cards fade in; wait for the entrance to finish. */
const SETTLE_MS = 1500;
/** Space kept around a hand-computed crop (the runner pads by 0 for those). */
const GUTTER = 16;

async function settle(page: Page): Promise<void> {
  // The feedback launcher floats over the bottom-right corner of every page.
  await page.addStyleTag({ content: '#__ybug-launcher { display: none !important; }' });
  await page.waitForTimeout(SETTLE_MS);
  // Park the pointer so no row carries a hover tint.
  await page.mouse.move(0, 0);
}

/** Drops focus so the field or button just used shows no focus ring under the highlight. */
async function blur(page: Page): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      active.blur();
    }
  });
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(`approving-a-change-to-your-project: ${locator.toString()} has no box`);
  }
  return box;
}

const proposedChange = (page: Page): Locator =>
  page.getByRole('region', { name: 'Proposed change' });

const changeHistory = (page: Page): Locator =>
  page.getByRole('region', { name: 'Changes to this project' });

const requestField = (page: Page): Locator => page.getByLabel('What would you like to change?');

const declineField = (page: Page): Locator => page.getByLabel('Why are you declining?');

/** The proposed change from its price block down to its buttons. */
async function priceToActions(page: Page): Promise<Box> {
  const region = await boxOf(proposedChange(page));
  const price = await boxOf(
    proposedChange(page)
      .getByText(/^Project price /)
      .locator('xpath=..')
  );
  const y = price.y - GUTTER;
  return {
    x: region.x - GUTTER,
    y,
    width: region.width + GUTTER * 2,
    height: region.y + region.height + GUTTER - y,
  };
}

defineGuide('approving-a-change-to-your-project', [
  {
    section: 1,
    as: 'client',
    state: 'projects',
    route: PROJECT_ROUTE,
    setup: async (page) => {
      await settle(page);
      await page.getByRole('button', { name: 'Request a change' }).click();
      await requestField(page).fill(
        'Could you add a short training session for our two new sales managers?'
      );
      await blur(page);
    },
    target: requestField,
    crop: (page) =>
      requestField(page).locator('xpath=ancestor::div[contains(@class, "rounded-2xl")][1]'),
    cropPadding: GUTTER,
  },
  {
    section: 2,
    as: 'client',
    state: 'change-sent',
    route: PROJECT_ROUTE,
    setup: settle,
    target: (page) => proposedChange(page).getByRole('list').first(),
    crop: proposedChange,
    cropPadding: 12,
  },
  {
    section: 3,
    as: 'client',
    state: 'change-sent',
    route: PROJECT_ROUTE,
    setup: settle,
    target: (page) => page.getByRole('button', { name: 'Approve change' }),
    crop: proposedChange,
    cropArea: priceToActions,
    cropPadding: 0,
  },
  {
    section: 4,
    as: 'client',
    state: 'change-sent',
    route: PROJECT_ROUTE,
    setup: async (page) => {
      await settle(page);
      await page.getByRole('button', { name: 'Decline', exact: true }).click();
      await declineField(page).fill(
        "We'd like to keep the account data cleanup in the plan for now."
      );
      await blur(page);
    },
    target: declineField,
    crop: proposedChange,
    cropArea: priceToActions,
    cropPadding: 0,
  },
  {
    section: 5,
    as: 'client',
    state: 'projects',
    route: PROJECT_ROUTE,
    setup: async (page) => {
      await settle(page);
      await changeHistory(page).getByRole('button', { name: 'Details' }).click();
      await blur(page);
      await page.mouse.move(0, 0);
    },
    target: (page) => changeHistory(page).getByRole('listitem').filter({ hasText: 'Answered' }),
    crop: changeHistory,
    cropPadding: 12,
  },
]);
