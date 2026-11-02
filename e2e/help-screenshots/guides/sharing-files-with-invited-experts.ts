import type { Locator, Page } from '@playwright/test';
import { defineGuide } from '../guide';
import type { Box } from '../ring';

/** "Streamline our quote approvals": matched to Priya, Marcus Chen and Aisha Okafor. */
const MATCHED_REQUEST_ROUTE = '/projects/b1a10598-0000-4000-8000-000000001322';
/** The request page's cards fade in; wait for the entrance to finish. */
const SETTLE_MS = 1500;
/** Space kept around a hand-computed crop (the runner's `cropPadding` is 0 for those). */
const GUTTER = 16;

async function settle(page: Page): Promise<void> {
  // The feedback launcher floats over the bottom-right corner of every page.
  await page.addStyleTag({ content: '#__ybug-launcher { display: none !important; }' });
  await page.waitForTimeout(SETTLE_MS);
  // Park the pointer so nothing carries a hover tint.
  await page.mouse.move(0, 0);
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(`sharing-files-with-invited-experts: ${locator.toString()} has no box`);
  }
  return box;
}

const shareButton = (page: Page): Locator => page.getByRole('button', { name: 'Share a file' });

/** The message box row under Priya's thread. */
const composer = (page: Page): Locator =>
  shareButton(page).locator('xpath=ancestor::div[contains(@class,"border-t")][1]');

/** Dana's shared screenshot in Priya's thread. */
const sharedFile = (page: Page): Locator =>
  page.getByText('Here is how approvals look today. The hold-up is step 3.');

/**
 * Scrolls Priya's thread to its foot: it opens a few pixels short, which hides the audience
 * badge under Dana's file.
 */
async function scrollThreadToEnd(page: Page): Promise<void> {
  await sharedFile(page).evaluate((el) => {
    let node: HTMLElement | null = el.parentElement;
    while (node && !/(auto|scroll)/.test(getComputedStyle(node).overflowY)) {
      node = node.parentElement;
    }
    node?.scrollTo({ top: node.scrollHeight, behavior: 'instant' });
  });
}

/** The "Marcus Chen only" and "Priya Raman only" labels on the spreadsheet's row in All files. */
const audienceLabels = (page: Page): Locator =>
  page
    .getByRole('dialog')
    .getByRole('listitem')
    .filter({ hasText: 'Quote-approval-matrix.xlsx' })
    .getByText('Marcus Chen only')
    .locator('xpath=ancestor::div[contains(@class,"flex-wrap")][1]');

defineGuide('sharing-files-with-invited-experts', [
  {
    section: 1,
    as: 'client',
    state: 'requests',
    route: MATCHED_REQUEST_ROUTE,
    setup: async (page) => {
      await settle(page);
      await scrollThreadToEnd(page);
    },
    target: shareButton,
    // Priya's question, Dana's file with its note and audience, and the message box.
    cropArea: async (page) => {
      const question = await boxOf(page.getByText(/^Happy to help\. Could you send a screenshot/));
      const row = await boxOf(composer(page));
      return {
        x: row.x,
        y: question.y - GUTTER,
        width: row.width,
        height: row.y + row.height - question.y + GUTTER,
      };
    },
    cropPadding: 0,
  },
  {
    section: 2,
    as: 'client',
    state: 'requests',
    route: MATCHED_REQUEST_ROUTE,
    setup: async (page) => {
      await settle(page);
      // Hold every server action from here on, so picking a file starts no upload: the window
      // opens at once and its upload waits at 0%, out of frame.
      await page.route('**/*', (route) => {
        const request = route.request();
        if (request.method() === 'POST' && request.headers()['next-action'] !== undefined) {
          return;
        }
        return route.fallback();
      });
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        shareButton(page).click(),
      ]);
      await chooser.setFiles({
        name: 'Quote-approval-matrix.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: Buffer.from('help'),
      });
      await page.getByRole('dialog').getByRole('radiogroup').waitFor();
      // The held upload would sit at 0% for ever; the file's name stays, its progress bar goes.
      await page.addStyleTag({
        content: '[role="dialog"] div:has(> [role="progressbar"]) { display: none !important; }',
      });
      await settle(page);
      // Padding offset by an equal negative margin widens the group's box without moving its
      // contents, so the ring clears the "Who can see it" label and the last option's border.
      await page
        .getByRole('dialog')
        .getByRole('radiogroup')
        .evaluate((el) => {
          el.style.padding = '4px';
          el.style.margin = '0 -4px -4px';
        });
    },
    target: (page) => page.getByRole('dialog').getByRole('radiogroup'),
    radius: 12,
    // The window from its "Share a file" title and the picked file to its buttons, inside its
    // rounded corners so none of the dimmed page behind it shows.
    cropArea: async (page) => {
      const dialog = await boxOf(page.getByRole('dialog'));
      const title = await boxOf(
        page.getByRole('dialog').getByRole('heading', { name: 'Share a file' })
      );
      const share = await boxOf(
        page.getByRole('dialog').getByRole('button', { name: /^Share with Priya/ })
      );
      const top = title.y - GUTTER;
      return {
        x: dialog.x,
        y: top,
        width: dialog.width,
        height: share.y + share.height + GUTTER - top,
      };
    },
    cropPadding: 0,
  },
  {
    section: 3,
    as: 'client',
    state: 'requests',
    route: MATCHED_REQUEST_ROUTE,
    setup: async (page) => {
      await settle(page);
      await page.getByRole('button', { name: /^All files · \d+$/ }).click();
      await page.getByRole('dialog').waitFor();
      await settle(page);
      // The labels' row spans the column; shrink it to the labels so the ring hugs them, with
      // side padding offset by an equal negative margin so the ring clears the pills' outlines. A
      // generous scroll margin stops the runner's centring from scrolling the file list, which
      // would cut the line at its top.
      await audienceLabels(page).evaluate((el) => {
        const { marginLeft, marginRight } = getComputedStyle(el);
        el.style.width = 'fit-content';
        el.style.paddingInline = '4px';
        el.style.marginLeft = `calc(${marginLeft} - 4px)`;
        el.style.marginRight = `calc(${marginRight} - 4px)`;
        el.style.scrollMarginTop = '400px';
      });
    },
    // The row runs edge to edge in the sheet, so the ring goes on its audience labels instead.
    target: audienceLabels,
    radius: 12,
    crop: (page) => page.getByRole('dialog'),
    cropPadding: 0,
  },
]);
