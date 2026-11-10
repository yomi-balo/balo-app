import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { defineGuide } from '../guide';
import type { Box } from '../ring';

const PRIYA_PROFILE = '/experts/priya-raman';
/** "Field Service scheduling setup": Dana's direct request to Priya, no call booked yet. */
const DIRECT_REQUEST_ROUTE = '/projects/b1a10598-0000-4000-8000-000000001301';
/** The profile and the drawer animate in; wait for the entrance to finish. */
const SETTLE_MS = 1500;
/** Space kept below a hand-computed crop (the runner's `cropPadding` is 0 for those). */
const GUTTER = 16;
/**
 * The fixture's avatar is the repo-served Balo icon. The drawer's recipient card resolves every
 * non-http avatar through the image CDN, which has no such file, so the CDN request is answered
 * with the same icon the other pages show.
 */
const FIXTURE_AVATAR = path.resolve(__dirname, '../../../apps/web/public/brand/balo-icon.png');

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(SETTLE_MS);
  // Park the pointer so nothing carries a hover tint.
  await page.mouse.move(0, 0);
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(`requesting-a-project: ${locator.toString()} has no box`);
  }
  return box;
}

const drawer = (page: Page): Locator => page.getByRole('dialog', { name: 'Start a project' });

/** The "Send request to" group on the Describe step: heading, label, recipient block and toggle. */
const sendToGroup = (page: Page): Locator =>
  drawer(page).locator('div.space-y-2').filter({ hasText: 'Send request to' }).first();

/** The drawer from its stepper down to the end of the "Send request to" group, full width. */
async function drawerTop(page: Page): Promise<Box> {
  const sheet = await boxOf(drawer(page));
  const group = await boxOf(sendToGroup(page));
  return {
    x: sheet.x,
    y: sheet.y,
    width: sheet.width,
    height: group.y + group.height + GUTTER - sheet.y,
  };
}

/** Opens the drawer with `open`, then the Describe step, and leaves no field focused. */
async function openDescribeStep(page: Page, open: Locator): Promise<void> {
  await page.route('**/cdn-cgi/image/**/brand/balo-icon.png', (route) =>
    route.fulfill({ path: FIXTURE_AVATAR, contentType: 'image/png' })
  );
  await settle(page);
  await open.click();
  await drawer(page)
    .getByRole('button', { name: /^Describe it yourself/ })
    .click();
  await sendToGroup(page).waitFor();
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      active.blur();
    }
  });
  await settle(page);
}

defineGuide('requesting-a-project', [
  {
    section: 1,
    as: 'client',
    state: 'available',
    route: '/projects',
    setup: (page) =>
      openDescribeStep(
        page,
        page.getByRole('button', { name: /^(New request|Raise a project request)$/ })
      ),
    target: (page) =>
      drawer(page).locator('[aria-live="polite"]').filter({ hasText: 'Find me an expert' }),
    cropArea: drawerTop,
    cropPadding: 0,
  },
  {
    section: 2,
    as: 'client',
    state: 'available',
    route: PRIYA_PROFILE,
    setup: async (page) => {
      await openDescribeStep(
        page,
        page.getByRole('button', { name: /^Start a project Get a scoped proposal/ })
      );
      // The toggle sits flush under the helper line; a little room keeps the ring off that text.
      // Side padding offset by an equal negative margin widens its box without moving the words,
      // so the ring clears them.
      await drawer(page)
        .getByRole('button', { name: 'Get matched with someone else instead' })
        .evaluate((el) => {
          el.style.padding = '0 8px';
          el.style.margin = '10px -8px 0';
        });
    },
    target: (page) =>
      drawer(page).getByRole('button', { name: 'Get matched with someone else instead' }),
    cropArea: drawerTop,
    cropPadding: 0,
  },
  {
    section: 3,
    as: 'client',
    state: 'paused',
    route: PRIYA_PROFILE,
    // The Quick Starts button: its exact name leaves out the booking card, which a pause hides.
    setup: (page) =>
      openDescribeStep(page, page.getByRole('button', { name: 'Start a project', exact: true })),
    target: (page) =>
      drawer(page)
        .getByText("Priya isn't taking on new work right now.")
        .locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]'),
    cropArea: drawerTop,
    cropPadding: 0,
  },
  {
    section: 4,
    as: 'client',
    state: 'requests',
    route: DIRECT_REQUEST_ROUTE,
    setup: settle,
    // The conversation header (the nudge's own button is "Book a call with Priya").
    target: (page) => page.getByRole('button', { name: 'Book a call', exact: true }),
    // The header row and the "Your next step" card under it, which says calls are free.
    cropArea: async (page) => {
      const header = await boxOf(
        page
          .getByRole('button', { name: 'Book a call', exact: true })
          .locator('xpath=ancestor::div[contains(@class,"border-b")][1]')
      );
      const reply = await boxOf(page.getByRole('button', { name: 'Reply by message' }));
      return {
        x: header.x,
        y: header.y,
        width: header.width,
        // Ends at the card's foot, above the expression of interest below it.
        height: reply.y + reply.height + GUTTER - header.y,
      };
    },
    cropPadding: 12,
  },
]);
