import { expect, type Locator, type Page } from '@playwright/test';
import { defineGuide } from '../guide';
import type { Box } from '../ring';

/** The time and materials "Service Cloud case routing" project (`HELP_WORLD_IDS`). */
const PROJECT_ROUTE = '/engagements/b1a10598-0000-4000-8000-000000001204';
const COMPOSER_ROUTE = `${PROJECT_ROUTE}/change-order`;
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

/** Waits until the element and every ancestor are fully opaque: the entrance fade has ended. */
async function waitForOpaque(locator: Locator): Promise<void> {
  await expect
    .poll(() =>
      locator.evaluate((el) => {
        let opacity = 1;
        for (let node: Element | null = el; node !== null; node = node.parentElement) {
          opacity *= Number(getComputedStyle(node).opacity);
        }
        return opacity;
      })
    )
    .toBe(1);
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(`proposing-a-change-to-a-live-project: ${locator.toString()} has no box`);
  }
  return box;
}

const deliveryPlan = (page: Page): Locator =>
  page.locator('[data-slot="card"]').filter({ hasText: 'Delivery plan' });

/** Settles, then waits for each listed element's entrance fade to end. */
function settleOn(...parts: ((page: Page) => Locator)[]): (page: Page) => Promise<void> {
  return async (page) => {
    await settle(page);
    for (const part of parts) {
      await waitForOpaque(part(page));
    }
  };
}

/** A milestone row on the delivery plan, from its rail node to its actions. */
const milestoneRow = (page: Page, title: string): Locator =>
  deliveryPlan(page)
    .getByText(title, { exact: true })
    .locator('xpath=ancestor::div[contains(@class, "gap-4")][1]');

const changeRequest = (page: Page): Locator => page.getByRole('region', { name: 'Change request' });

const draftBanner = (page: Page): Locator => page.getByRole('region', { name: 'Draft change' });

const sentBanner = (page: Page): Locator => page.getByRole('region', { name: 'Change sent' });

const outcomeBanner = (page: Page): Locator => page.getByRole('region', { name: 'Change outcome' });

const finishCard = (page: Page): Locator =>
  page.locator('[data-slot="card"]').filter({ hasText: 'Finish the project' });

const summary = (page: Page): Locator =>
  page.getByRole('complementary', { name: 'Summary of the change' });

/**
 * From a banner down to "Case routing rules" on the delivery plan, ending under the milestone's
 * description, so the frame shows the banner, the badge the milestone carries and what it
 * delivers. The plan card is cut there: its full height would not fit under the top bar.
 */
async function bannerToRoutingRules(page: Page, target: Box): Promise<Box> {
  const description = await boxOf(
    milestoneRow(page, 'Case routing rules').getByText(/^Route each new case/)
  );
  const y = target.y - GUTTER;
  return {
    x: target.x - GUTTER,
    y,
    width: target.width + GUTTER * 2,
    height: description.y + description.height + 12 - y,
  };
}

defineGuide('proposing-a-change-to-a-live-project', [
  {
    section: 1,
    as: 'expert',
    state: 'change-requested',
    route: PROJECT_ROUTE,
    setup: settleOn(changeRequest),
    target: changeRequest,
    cropPadding: 16,
  },
  {
    section: 2,
    as: 'expert',
    state: 'change-draft',
    route: COMPOSER_ROUTE,
    setup: async (page) => {
      await settleOn(summary, changeRequest)(page);
      // The frame is taller than the space under the sticky top bar, so its top edge would
      // otherwise catch the bar's lower border. Nothing inside the frame sits under the bar.
      await page.addStyleTag({ content: 'header.sticky { visibility: hidden !important; }' });
    },
    target: (page) => summary(page).getByRole('status'),
    // The frame runs from the summary's top across both columns and stops under the edited
    // milestone's estimate, so the Unchanged and Edited rows show beside the cap prompt.
    crop: summary,
    cropArea: async (page) => {
      const aside = await boxOf(summary(page));
      const left = await boxOf(changeRequest(page));
      const estimate = await boxOf(page.getByText(/^was \d+ hrs$/).locator('xpath=..'));
      const x = left.x - 12;
      const y = aside.y - 10;
      return {
        x,
        y,
        width: aside.x + aside.width + 12 - x,
        height: estimate.y + estimate.height + 12 - y,
      };
    },
    cropPadding: 0,
  },
  {
    section: 3,
    as: 'expert',
    state: 'change-draft',
    route: PROJECT_ROUTE,
    setup: settleOn(draftBanner),
    target: draftBanner,
    // The over-estimate banner sits 20px above; the ring's reach alone stops short of it.
    cropPadding: 16,
  },
  {
    section: 4,
    as: 'expert',
    state: 'change-sent',
    route: PROJECT_ROUTE,
    setup: settleOn(sentBanner, deliveryPlan),
    target: sentBanner,
    // Centring the plan's heading brings the banner and the milestone into view together.
    crop: (page) => deliveryPlan(page).getByText('Delivery plan', { exact: true }),
    cropArea: bannerToRoutingRules,
    cropPadding: 0,
  },
  {
    section: 5,
    as: 'expert',
    state: 'change-approved',
    route: PROJECT_ROUTE,
    setup: settleOn(outcomeBanner, deliveryPlan),
    target: outcomeBanner,
    crop: (page) => deliveryPlan(page).getByText('Delivery plan', { exact: true }),
    cropArea: bannerToRoutingRules,
    cropPadding: 0,
  },
  {
    section: 6,
    as: 'expert',
    state: 'agency',
    route: '/projects?lens=agency',
    setup: async (page) => {
      await settle(page);
      // The title and tiles fade in after the lens row; the frame needs all of them.
      await waitForOpaque(page.getByRole('main').locator('h2', { hasText: /^Projects$/ }));
      await waitForOpaque(page.getByRole('button', { name: /^Changes requested/ }));
    },
    target: (page) =>
      page.getByRole('tablist', { name: 'Portfolio lens' }).getByRole('tab', { name: 'Agency' }),
    cropArea: async (page) => {
      const lens = await boxOf(
        page
          .getByText('Viewing as', { exact: true })
          .locator('xpath=ancestor::div[contains(@class, "mb-4")][1]')
      );
      const firstRow = await boxOf(
        page.getByRole('region', { name: 'All live projects' }).getByRole('link').first()
      );
      return {
        x: lens.x - GUTTER,
        y: lens.y - GUTTER,
        width: lens.width + GUTTER * 2,
        height: firstRow.y + firstRow.height + 8 - (lens.y - GUTTER),
      };
    },
    cropPadding: 0,
  },
  {
    section: 7,
    as: 'expert',
    state: 'change-requested',
    route: PROJECT_ROUTE,
    setup: settleOn(finishCard),
    target: finishCard,
    cropPadding: 16,
  },
]);
