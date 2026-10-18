import type { Locator, Page } from '@playwright/test';
import { HELP_GUEST_TOKEN, HELP_IDS } from '../../../packages/db/src/help-seed/constants';
import { defineGuide } from '../guide';

/** Room above the headline for the check icon, beside and below the receipt line. */
const END_CARD_TOP_PX = 90;
const END_CARD_SIDE_PX = 40;
const END_CARD_BOTTOM_PX = 60;
const END_CARD_SETTLE_MS = 1500;
const LOBBY_ROUTE = `/join/m/${HELP_IDS.meeting}`;

/** The nearest rounded card around a heading. */
function cardAround(heading: Locator): Locator {
  return heading.locator('xpath=ancestor::*[contains(@class, "rounded-2xl")][1]');
}

/** Drops the focus ring the lobby's first field takes on load. */
async function blurFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
}

function lobbyCard(page: Page): Locator {
  return cardAround(page.getByRole('heading', { name: 'Join this meeting' }));
}

defineGuide('joining-a-call', [
  {
    section: 1,
    as: 'client',
    state: 'available',
    // The call page shows "This meeting isn't available to join" under the fixture (the join
    // action needs a WorkOS access token the test login does not mint), so the case page's
    // "Next consultation" banner stands in for the not-open-yet notice.
    route: `/cases/${HELP_IDS.engagement}`,
    target: (page) =>
      page
        .getByText(/^Next consultation/)
        .first()
        .locator('xpath=ancestor::*[contains(@class, "rounded")][1]'),
  },
  {
    section: 2,
    as: 'visitor',
    state: 'available',
    route: LOBBY_ROUTE,
    setup: blurFocus,
    target: lobbyCard,
  },
  {
    section: 3,
    as: 'visitor',
    state: 'available',
    route: LOBBY_ROUTE,
    setup: blurFocus,
    target: (page) => page.getByRole('button', { name: /Already asked to join/ }),
    crop: lobbyCard,
  },
  {
    section: 4,
    as: 'visitor',
    state: 'available',
    route: `/join/${HELP_GUEST_TOKEN}`,
    target: (page) => page.getByRole('button', { name: 'Join the call' }),
    crop: (page) => page.getByRole('article'),
    cropPadding: 0,
  },
  {
    section: 7,
    as: 'client',
    state: 'held',
    route: `/meetings/${HELP_IDS.meeting}/end`,
    // The card fades in; wait for the entrance to finish.
    setup: async (page) => {
      await page.waitForTimeout(END_CARD_SETTLE_MS);
    },
    target: (page) =>
      page
        .getByText(/Your recap and receipt are on the way/)
        .locator('xpath=ancestor::*[contains(@class, "rounded")][1]'),
    // From the headline down past the receipt line, kept narrower than the main column.
    cropArea: async (page, targetBox) => {
      const heading = await page
        .getByRole('heading', { name: 'Consultation complete' })
        .boundingBox();
      if (!heading) {
        throw new Error('End-of-call headline has no box');
      }
      const top = heading.y - END_CARD_TOP_PX;
      return {
        x: targetBox.x - END_CARD_SIDE_PX,
        y: top,
        width: targetBox.width + END_CARD_SIDE_PX * 2,
        height: targetBox.y + targetBox.height + END_CARD_BOTTOM_PX - top,
      };
    },
    cropPadding: 0,
  },
]);
