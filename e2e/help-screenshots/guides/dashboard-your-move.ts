import type { Locator, Page } from '@playwright/test';
import { defineGuide } from '../guide';
import type { Box } from '../ring';

/** The dashboard panels fade in; wait for the entrance, then park the pointer off every card. */
const SETTLE_MS = 1500;
const VIEWPORT_HEIGHT = 800;
/** Keeps the clamped crop clear of the viewport's bottom edge. */
const BOTTOM_SLACK_PX = 8;
const TRACK_SIDE_PX = 16;
const TRACK_TOP_PX = 8;
const POPOVER_NUDGE_PX = 4;

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(SETTLE_MS);
  await page.mouse.move(0, 0);
}

function yourMove(page: Page): Locator {
  return page.getByRole('region', { name: 'Your move', exact: true });
}

function projectTrack(page: Page): Locator {
  return page.getByRole('region', { name: 'Where your projects stand' });
}

function deliveryExplanation(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Delivery' });
}

function filterChips(page: Page): Locator {
  return page.getByRole('group', { name: 'Filter by type' });
}

function featuredCard(page: Page): Locator {
  return page.locator('li[data-featured="true"]');
}

/**
 * Shrinks the full-width chip group to the chips themselves, so the ring hugs them. The chips sit
 * at the group's start, so nothing visible moves.
 */
async function settleWithChipsHugged(page: Page): Promise<void> {
  await settle(page);
  await filterChips(page).evaluate((el) => {
    el.style.width = 'fit-content';
    el.style.paddingRight = '0';
  });
}

/**
 * The runner centres the target with `scrollIntoView`, which also scrolls the card's
 * `overflow: hidden` box sideways and drags the ticket notches off its edges. `overflow: clip`
 * draws the same but cannot be scrolled.
 */
async function settleWithCardUnscrollable(page: Page): Promise<void> {
  await settle(page);
  await featuredCard(page)
    .locator('article')
    .evaluate((el) => {
      el.style.overflow = 'clip';
    });
}

/** The Your move panel, cut off at the viewport's bottom edge if it runs past it. */
async function yourMovePanel(page: Page): Promise<Box> {
  const panel = await yourMove(page).boundingBox();
  if (!panel) {
    throw new Error('Your move panel has no box');
  }
  return {
    x: panel.x,
    y: panel.y,
    width: panel.width,
    height: Math.min(panel.height, VIEWPORT_HEIGHT - panel.y - BOTTOM_SLACK_PX),
  };
}

/**
 * The track card. Only 16px separates it from the Your move panel above, so the top gets less
 * room than the sides and bottom to keep that panel's border out of frame.
 */
async function projectTrackCard(page: Page): Promise<Box> {
  const card = await projectTrack(page).boundingBox();
  if (!card) {
    throw new Error('Project track has no box');
  }
  return {
    x: card.x - TRACK_SIDE_PX,
    y: card.y - TRACK_TOP_PX,
    width: card.width + TRACK_SIDE_PX * 2,
    height: card.height + TRACK_TOP_PX + TRACK_SIDE_PX,
  };
}

defineGuide('dashboard-your-move', [
  {
    section: 1,
    as: 'expert',
    state: 'dashboards',
    route: '/dashboard',
    setup: settleWithChipsHugged,
    target: filterChips,
    crop: yourMove,
    cropArea: yourMovePanel,
    cropPadding: 8,
  },
  {
    section: 2,
    as: 'expert',
    state: 'dashboards',
    route: '/dashboard',
    setup: settleWithCardUnscrollable,
    target: (page) => featuredCard(page).getByRole('link', { name: 'Review invitation' }),
    crop: featuredCard,
    // The chips above and the next card beside it are both 14px away.
    cropPadding: 8,
  },
  {
    section: 3,
    as: 'expert',
    state: 'dashboards',
    route: '/dashboard',
    setup: async (page) => {
      await settle(page);
      const track = projectTrack(page);
      // The last stage: its explanation covers only its own projects, never a neighbour's.
      await track.getByRole('button', { name: 'Delivery', exact: true }).click();
      // A click-opened explanation stays open once the pointer leaves; park it on the heading.
      await track.getByRole('heading', { name: 'Where your projects stand' }).hover();
      // The popover sits against the viewport's 16px collision padding, so its ring would end 1px
      // past the viewport. Nudge it left a few px; margin survives Radix repositioning it.
      await deliveryExplanation(page)
        .locator('xpath=ancestor::*[@data-radix-popper-content-wrapper]')
        .evaluate((el, nudge) => {
          el.style.marginLeft = `-${nudge}px`;
        }, POPOVER_NUDGE_PX);
    },
    target: deliveryExplanation,
    crop: projectTrack,
    cropArea: projectTrackCard,
    cropPadding: 0,
  },
]);
