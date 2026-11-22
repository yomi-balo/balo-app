import type { Locator, Page } from '@playwright/test';
import { HELP_WORLD_IDS } from '../../../packages/db/src/help-seed/constants';
import { defineGuide } from '../guide';
import type { Box } from '../ring';

const D = HELP_WORLD_IDS.dashboards;

/**
 * "Quote approval workflow": Priya's fixed-price proposal, sent and waiting on Dana. No other guide
 * shows it, and every frame here keeps its client price out of view.
 */
const PROPOSAL_ROUTE = `/projects/${D.approval}/proposal/${D.approvalRelationship}`;
/** The proposal fades in; wait for the entrance to finish. */
const SETTLE_MS = 1500;
/** Space kept around a hand-computed crop (the runner pads by 0 for those). */
const GUTTER = 16;

async function settle(page: Page): Promise<void> {
  // The feedback launcher floats over the bottom-right corner of every page.
  await page.addStyleTag({ content: '#__ybug-launcher { display: none !important; }' });
  await docSection(page, 'overview').waitFor();
  await page.waitForTimeout(SETTLE_MS);
  // Park the pointer so no row carries a hover tint.
  await page.mouse.move(0, 0);
}

/** Drops focus so the control just used shows no focus ring under the highlight. */
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
    throw new Error(`reviewing-a-proposal: ${locator.toString()} has no box`);
  }
  return box;
}

/**
 * Pads an element on every side with an equal negative margin, so nothing moves and the ring
 * clears its contents instead of sitting on them.
 */
async function inset(locator: Locator, x: number, y: number): Promise<void> {
  await locator.evaluate(
    (el, [dx, dy]) => {
      const style = getComputedStyle(el);
      el.style.padding = `calc(${style.paddingTop} + ${dy}px) calc(${style.paddingRight} + ${dx}px) calc(${style.paddingBottom} + ${dy}px) calc(${style.paddingLeft} + ${dx}px)`;
      el.style.margin = `calc(${style.marginTop} - ${dy}px) calc(${style.marginRight} - ${dx}px) calc(${style.marginBottom} - ${dy}px) calc(${style.marginLeft} - ${dx}px)`;
    },
    [x, y]
  );
}

/**
 * A proposal document section; its id is `sec-<proposalId>-<key>`. The page renders the document
 * once per layout, so only the visible copy counts.
 */
const docSection = (page: Page, key: string): Locator =>
  page.locator(`section[id="sec-${D.approvalProposal}-${key}"]:visible`);

const dialog = (page: Page): Locator => page.getByRole('dialog');

/** "What you're agreeing to" in the accept dialog, from its heading to the end of its block. */
const agreeingTo = (page: Page): Locator =>
  dialog(page).getByRole('heading', { name: 'What you’re agreeing to' }).locator('xpath=..');

/** The acknowledgement checkbox's row. */
const acknowledgement = (page: Page): Locator =>
  dialog(page).locator('label').filter({ hasText: 'I agree to' });

defineGuide('reviewing-a-proposal', [
  {
    section: 1,
    as: 'client',
    state: 'dashboards',
    route: PROPOSAL_ROUTE,
    setup: async (page) => {
      await settle(page);
      await docSection(page, 'scope').scrollIntoViewIfNeeded();
      // A side inset keeps the ring off the text; none vertically, or the ring's reach takes in
      // the sections above and below.
      await inset(docSection(page, 'scope'), 12, 0);
    },
    target: (page) => docSection(page, 'scope'),
    radius: 12,
    cropPadding: GUTTER,
  },
  {
    section: 2,
    as: 'client',
    state: 'dashboards',
    route: PROPOSAL_ROUTE,
    setup: async (page) => {
      await settle(page);
      await page.getByRole('button', { name: 'Request changes' }).click();
      await page.getByRole('combobox', { name: 'What needs work?' }).click();
      await page.getByRole('option', { name: 'Assumptions and exclusions' }).click();
      await page
        .getByLabel('Your note')
        .fill('Exclusion 2: could contract approvals be included as well?');
      await blur(page);
      await inset(page.locator('#changes-section-hint'), 6, 2);
      await page.waitForTimeout(300);
    },
    target: (page) => page.locator('#changes-section-hint'),
    radius: 8,
    crop: dialog,
    cropPadding: 0,
  },
  {
    section: 3,
    as: 'client',
    state: 'dashboards',
    route: PROPOSAL_ROUTE,
    setup: async (page) => {
      await settle(page);
      await page.getByRole('button', { name: 'Accept this proposal' }).click();
      await agreeingTo(page).waitFor();
      // The dialog body scrolls; bring the block and the checkbox below it into view.
      await acknowledgement(page).scrollIntoViewIfNeeded();
      // The price rows sit just above the block. A client price must never appear in a help
      // shot, so hide them; visibility keeps the layout, so nothing moves.
      await dialog(page)
        .locator('dl')
        .first()
        .evaluate((el) => {
          el.style.visibility = 'hidden';
        });
      await inset(agreeingTo(page), 4, 8);
      await page.waitForTimeout(300);
    },
    target: agreeingTo,
    radius: 12,
    // From "What you're agreeing to" down to the acknowledgement, across the dialog's width.
    cropArea: async (page) => {
      const block = await boxOf(agreeingTo(page));
      const ack = await boxOf(acknowledgement(page));
      const box = await boxOf(dialog(page));
      return {
        x: box.x,
        y: block.y - GUTTER,
        width: box.width,
        height: ack.y + ack.height - block.y + GUTTER * 2,
      };
    },
    cropPadding: 0,
  },
  {
    section: 4,
    as: 'client',
    state: 'dashboards',
    route: PROPOSAL_ROUTE,
    setup: async (page) => {
      await settle(page);
      await docSection(page, 'attachments').scrollIntoViewIfNeeded();
    },
    target: (page) => page.getByRole('button', { name: 'Download Approval matrix.pdf' }),
    crop: (page) => docSection(page, 'attachments'),
    cropPadding: GUTTER,
  },
]);
