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

function filterChips(page: Page): Locator {
  return page.getByRole('group', { name: 'Filter by type' });
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

function proposalCard(page: Page): Locator {
  return page.getByRole('listitem', { name: /^Proposal to review:/ });
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

defineGuide('dashboard-your-move-for-clients', [
  {
    section: 1,
    as: 'client',
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
    as: 'client',
    state: 'dashboards',
    route: '/dashboard',
    setup: settle,
    target: (page) => proposalCard(page).getByRole('link', { name: 'Review proposal' }),
    crop: proposalCard,
    // The chips above and the cards beside it are both 14px away.
    cropPadding: 8,
  },
  {
    section: 3,
    as: 'client',
    state: 'dashboards',
    route: '/dashboard',
    setup: async (page) => {
      await settle(page);
      const track = projectTrack(page);
      // Scoped to the track: the rail's filter chip is also called Proposals.
      await track.getByRole('button', { name: 'Proposals', exact: true }).click();
      // A click-opened explanation stays open once the pointer leaves; park it on the heading.
      await track.getByRole('heading', { name: 'Where your projects stand' }).hover();
    },
    target: (page) => page.getByRole('dialog', { name: 'Proposals' }),
    crop: projectTrack,
    cropArea: projectTrackCard,
    cropPadding: 0,
  },
]);
