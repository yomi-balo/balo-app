import type { Locator, Page } from '@playwright/test';
import { defineGuide } from '../guide';
import type { Box } from '../ring';

/** "Field Service scheduling setup": Northwind's direct request, waiting on Priya's choice. */
const DIRECT_REQUEST_ROUTE = '/projects/b1a10598-0000-4000-8000-000000001301';
/** "CPQ rollout for the sales team": proposal requested, no proposal sent yet. */
const PROPOSAL_REQUESTED_ROUTE = '/projects/b1a10598-0000-4000-8000-000000001304';
/** The request page's cards fade in; wait for the entrance to finish. */
const SETTLE_MS = 1500;

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(SETTLE_MS);
  // Park the pointer so nothing carries a hover tint.
  await page.mouse.move(0, 0);
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(`project-requests-for-experts: ${locator.toString()} has no box`);
  }
  return box;
}

/** The "Your next step" card that opens a direct request with its two choices. */
const directChoiceCard = (page: Page): Locator =>
  page.locator('div.bg-card.rounded-2xl').filter({ hasText: 'asked for you directly' }).first();

/** The Files card's invitation line under "No documents attached." */
const filesNote = (page: Page): Locator =>
  page.getByText('Share a file from the conversation. It goes to the client only.');

/** The right column's Files card. */
const filesCard = (page: Page): Locator =>
  page
    .locator('div.bg-card.rounded-2xl')
    .filter({ hasText: 'It goes to the client only.' })
    .first();

/** The right column's quiet control (the phone sheet's copy is hidden at this width). */
const passControl = (page: Page): Locator =>
  page.getByRole('button', { name: 'Pass on this project' });

defineGuide('project-requests-for-experts', [
  {
    section: 1,
    as: 'expert',
    state: 'requests',
    route: DIRECT_REQUEST_ROUTE,
    setup: async (page) => {
      // The card's buttons appear once the conversation has hydrated.
      await directChoiceCard(page).getByRole('button', { name: 'Propose times' }).waitFor();
      await settle(page);
    },
    target: directChoiceCard,
    // Keeps the cards below out of frame.
    cropPadding: 16,
  },
  {
    section: 2,
    as: 'expert',
    state: 'requests',
    route: DIRECT_REQUEST_ROUTE,
    setup: async (page) => {
      await settle(page);
      // Padding offset by an equal negative margin widens the note's box sideways without moving
      // its text, so the ring clears the words; the top margin is the card's own.
      await filesNote(page).evaluate((el) => {
        el.style.padding = '0 8px';
        el.style.margin = '12px -8px 0';
      });
    },
    target: filesNote,
    radius: 8,
    crop: (page) => filesCard(page),
    // The conversation's message box with its paperclip on the left, and the Details and Files
    // cards on the right, so the note is seen beside where a file is attached.
    cropArea: async (page) => {
      const conversation = await boxOf(
        page
          .getByPlaceholder(/^Message the client/)
          .locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]')
      );
      const details = await boxOf(
        page.locator('div.bg-card.rounded-2xl').filter({ hasText: 'Timeline' }).first()
      );
      const files = await boxOf(filesCard(page));
      return {
        x: conversation.x,
        y: details.y,
        width: files.x + files.width - conversation.x,
        height: files.y + files.height - details.y,
      };
    },
    // Keeps the request card above the Details card out of frame.
    cropPadding: 12,
  },
  {
    section: 3,
    as: 'expert',
    state: 'requests',
    route: PROPOSAL_REQUESTED_ROUTE,
    setup: settle,
    target: passControl,
    // The right column from the Build proposal button, past the control, to the name of the request
    // in the card below it.
    crop: passControl,
    cropArea: async (page) => {
      const card = await boxOf(
        page.locator('div.bg-card.rounded-2xl').filter({ hasText: 'Interest sent' }).first()
      );
      // Several controls read "Build proposal"; the right column's is the one above the card.
      const builds = await Promise.all(
        (await page.getByText('Build proposal', { exact: true }).all()).map((locator) =>
          locator.boundingBox()
        )
      );
      const build = builds.find(
        (box): box is Box => box !== null && box.x >= card.x && box.y < card.y
      );
      if (build === undefined) {
        throw new Error('project-requests-for-experts: no Build proposal above the right column');
      }
      const title = await boxOf(
        page
          .locator('div.bg-card.rounded-2xl')
          .filter({ hasText: 'The request' })
          .first()
          .getByRole('heading', { name: 'CPQ rollout for the sales team' })
      );
      return {
        x: card.x,
        y: build.y,
        width: card.width,
        height: title.y + title.height - build.y,
      };
    },
    cropPadding: 16,
  },
]);
