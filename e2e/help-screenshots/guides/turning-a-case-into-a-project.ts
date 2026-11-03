import type { Locator, Page } from '@playwright/test';
import { HELP_IDS, HELP_WORLD_IDS } from '../../../packages/db/src/help-seed/constants';
import { defineGuide } from '../guide';

const CASE_ROUTE = `/cases/${HELP_IDS.engagement}`;
/** The case page fades its cards in; wait for the entrance to finish. */
const SETTLE_MS = 1500;
const CASE_TITLE = 'Salesforce flow debugging';
const CONVERT = 'Convert to project';

/** What the editor holds: the AI draft with one edit (the closing sentence of "What's left"). */
const CURRENT_BRIEF =
  '<p><strong>The problem.</strong> Quotes with a discount above 20% stall in the approval flow ' +
  'and never reach a manager.</p>' +
  '<p><strong>Already resolved in the case.</strong> The missing fault path was found and patched, ' +
  'so standard quotes now route correctly.</p>' +
  "<p><strong>What's left.</strong> Rebuild the routing for multi-currency quotes and add fault " +
  'handling to the remaining approval flows. Document the fix for the admin team.</p>' +
  '<p><strong>Likely scope.</strong> Flow changes and testing in a sandbox, then a guided ' +
  'release.</p>';
/** The brief as the AI drafted it, before the edit above. */
const DRAFTED_BRIEF = CURRENT_BRIEF.replace(' Document the fix for the admin team.', '');

const ATTACHED_FILE = {
  r2Key: 'project-documents/help-fixture/flow-error-log.pdf',
  fileName: 'flow-error-log.pdf',
  contentType: 'application/pdf',
  sizeBytes: 421_888,
};

/**
 * A resumed case draft: a written brief (so opening the form never starts a generation), an AI
 * snapshot that differs from it (the AI draft chip, and Redraft asks before replacing edits) and
 * one case file already attached.
 */
const DRAFT = {
  routing: 'direct',
  title: CASE_TITLE,
  descriptionHtml: CURRENT_BRIEF,
  tagIds: [],
  productIds: [],
  documents: [],
  budgetMinCents: null,
  budgetMaxCents: null,
  timeline: null,
  caseFileSelections: { [`conversation:${HELP_WORLD_IDS.caseFiles.errorLog}`]: ATTACHED_FILE },
  caseBriefSnapshot: {
    title: CASE_TITLE,
    descriptionHtml: DRAFTED_BRIEF,
    tagIds: [],
    productIds: [],
  },
  source: 'manual',
  seededFrom: null,
};
const DRAFT_KEY = `balo:project-draft:case:${HELP_IDS.engagement}`;

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(SETTLE_MS);
}

function drawer(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Start a project' });
}

/** The description field: its label, AI draft chip, Redraft link, editor and helper line. */
function briefField(page: Page): Locator {
  return drawer(page)
    .getByText('Drafted from your case history', { exact: false })
    .locator('xpath=..');
}

/** Stores the draft, reloads so the form reads it, then opens the form. */
async function openDraft(page: Page): Promise<void> {
  await page.evaluate(([key, value]) => globalThis.localStorage.setItem(key, value), [
    DRAFT_KEY,
    JSON.stringify(DRAFT),
  ] as const);
  await page.reload();
  // The feedback launcher sits over the drawer's footer buttons.
  await page.addStyleTag({ content: '#__ybug-launcher { display: none !important; }' });
  await settle(page);
  await page.getByRole('button', { name: CONVERT }).click();
  await drawer(page).getByText('Drafted from your case history', { exact: false }).waitFor();
  await settle(page);
  await page.mouse.move(0, 0);
}

async function boxOf(
  locator: Locator,
  what: string
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(`${what} has no box`);
  }
  return box;
}

defineGuide('turning-a-case-into-a-project', [
  {
    section: 1,
    as: 'client',
    state: 'available',
    route: CASE_ROUTE,
    setup: settle,
    target: (page) => page.getByRole('button', { name: CONVERT }),
    crop: (page) =>
      page.getByRole('button', { name: CONVERT }).locator('xpath=ancestor::header[1]'),
    cropPadding: 16,
  },
  {
    section: 2,
    as: 'client',
    state: 'case-files',
    route: CASE_ROUTE,
    setup: async (page) => {
      await openDraft(page);
      // The title input is focused on open; move focus off it so it carries no focus ring.
      await page.locator(':focus').evaluate((el) => (el as HTMLElement).blur());
    },
    target: (page) =>
      briefField(page)
        .locator('.ProseMirror')
        .locator('xpath=ancestor::div[contains(@class, "rounded-[11px]")][1]'),
    crop: briefField,
    cropPadding: 16,
  },
  {
    section: 3,
    as: 'client',
    state: 'case-files',
    route: CASE_ROUTE,
    setup: async (page) => {
      await openDraft(page);
      await drawer(page).getByRole('button', { name: 'Redraft from case' }).click();
      await page.getByRole('dialog', { name: 'Redraft from case?' }).waitFor();
      await page.mouse.move(0, 0);
    },
    target: (page) =>
      page
        .getByRole('dialog', { name: 'Redraft from case?' })
        .getByRole('button', { name: 'Redraft', exact: true }),
    crop: (page) => page.getByRole('dialog', { name: 'Redraft from case?' }),
    // Flush to the window, so no half-covered drawer text shows around it.
    cropPadding: 0,
  },
  {
    section: 4,
    as: 'client',
    state: 'case-files',
    route: CASE_ROUTE,
    setup: openDraft,
    target: (page) => drawer(page).getByText('From this case', { exact: true }).locator('xpath=..'),
    // The drawer's width, from the Attach documents label and its hint down to just under the
    // list, so the upload dropzone below it stays out.
    cropArea: async (page, targetBox) => {
      const panel = await boxOf(drawer(page), 'Start a project drawer');
      const label = await boxOf(
        drawer(page)
          .getByText(/^Attach documents/)
          .first(),
        'Attach documents label'
      );
      return {
        x: panel.x,
        y: label.y - 16,
        width: panel.width,
        height: targetBox.y + targetBox.height + 16 - (label.y - 16),
      };
    },
    cropPadding: 0,
  },
  {
    section: 5,
    as: 'client',
    state: 'case-files',
    route: CASE_ROUTE,
    setup: async (page) => {
      await openDraft(page);
      await drawer(page).getByRole('button', { name: 'Review', exact: true }).last().click();
      await drawer(page).getByText(`Linked to case: ${CASE_TITLE}`).waitFor();
      await page.mouse.move(0, 0);
    },
    target: (page) => drawer(page).getByText(`Linked to case: ${CASE_TITLE}`),
    // The Documents card above the link line, at the drawer's width.
    cropArea: async (page, targetBox) => {
      const panel = await boxOf(drawer(page), 'Start a project drawer');
      const documents = await boxOf(
        drawer(page).getByText('flow-error-log.pdf', { exact: true }).last(),
        'Documents row'
      );
      // Just above the Documents card's top edge; the ring sets the bottom.
      const top = documents.y - 48;
      return {
        x: panel.x,
        y: top,
        width: panel.width,
        height: targetBox.y + targetBox.height - top,
      };
    },
    cropPadding: 0,
  },
]);
