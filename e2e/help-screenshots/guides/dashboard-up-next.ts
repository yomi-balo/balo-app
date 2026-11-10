import type { Locator, Page } from '@playwright/test';
import { defineGuide } from '../guide';
import type { Box } from '../ring';

/** The dashboard cards fade in; wait for the entrance, then park the pointer off every row. */
const SETTLE_MS = 1500;
/** Room around the card: the next dashboard card sits only a few px past its right edge. */
const SIDE_PX = 8;
const END_PX = 16;

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(SETTLE_MS);
  await page.mouse.move(0, 0);
}

function upNext(page: Page): Locator {
  return page.getByRole('region', { name: 'Up next' });
}

/** The consultation row: the parent of the link that carries its title. */
function consultationRow(page: Page): Locator {
  return upNext(page)
    .getByRole('link', { name: /Salesforce flow debugging/ })
    .locator('xpath=..');
}

async function upNextBox(page: Page): Promise<Box> {
  const card = await upNext(page).boundingBox();
  if (!card) {
    throw new Error('Up next card has no box');
  }
  return card;
}

/** The whole Up next card, with less room at the sides than above and below it. */
async function upNextCard(page: Page): Promise<Box> {
  const card = await upNextBox(page);
  return {
    x: card.x - SIDE_PX,
    y: card.y - END_PX,
    width: card.width + SIDE_PX * 2,
    height: card.height + END_PX * 2,
  };
}

/**
 * The card from its top down to just past the target row. On the expert dashboard the card is
 * stretched to its grid neighbour's height, so the full card would be mostly blank.
 */
async function upNextCardToRow(page: Page, row: Box): Promise<Box> {
  const card = await upNextBox(page);
  const top = card.y - END_PX;
  return {
    x: card.x - SIDE_PX,
    y: top,
    width: card.width + SIDE_PX * 2,
    height: row.y + row.height + END_PX - top,
  };
}

defineGuide('dashboard-up-next', [
  {
    section: 1,
    as: 'client',
    state: 'proposal',
    route: '/dashboard',
    setup: settle,
    target: consultationRow,
    // `crop` centres the card in the viewport; `cropArea` frames it.
    crop: upNext,
    cropArea: upNextCard,
    cropPadding: 0,
  },
  {
    section: 2,
    as: 'expert',
    state: 'dashboards',
    route: '/dashboard',
    setup: settle,
    target: consultationRow,
    // `crop` centres the card in the viewport; `cropArea` frames its top down to the row.
    crop: upNext,
    cropArea: upNextCardToRow,
    cropPadding: 0,
  },
]);
