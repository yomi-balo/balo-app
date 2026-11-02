import { expect, type Locator, type Page } from '@playwright/test';
import { defineGuide } from '../guide';
import type { Box } from '../ring';

/** The time and materials "Service Cloud case routing" project (`HELP_WORLD_IDS`). */
const PROJECT_ROUTE = '/engagements/b1a10598-0000-4000-8000-000000001204';
/** The page's cards fade in; wait for the entrance to finish. */
const SETTLE_MS = 1500;

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
    throw new Error(`understanding-the-hours-on-your-project: ${locator.toString()} has no box`);
  }
  return box;
}

/** Settles, then waits for the given element's entrance fade to end. */
function settleOn(part: (page: Page) => Locator): (page: Page) => Promise<void> {
  return async (page) => {
    // The feedback launcher floats over the bottom-right corner of every page.
    await page.addStyleTag({ content: '#__ybug-launcher { display: none !important; }' });
    await page.waitForTimeout(SETTLE_MS);
    await waitForOpaque(part(page));
    // Park the pointer so no row carries a hover tint.
    await page.mouse.move(0, 0);
  };
}

const deliveryPlan = (page: Page): Locator =>
  page.locator('[data-slot="card"]').filter({ hasText: 'Delivery plan' });

/** "Case routing rules" on the delivery plan, from its rail node to its status badge. */
const routingRulesRow = (page: Page): Locator =>
  deliveryPlan(page)
    .getByText('Case routing rules', { exact: true })
    .locator('xpath=ancestor::div[contains(@class, "gap-4")][1]');

const routingRulesLogToggle = (page: Page): Locator =>
  routingRulesRow(page).getByText(/^Time log \(\d+\)$/);

/** The open time log of "Case routing rules": its entries and who logged them. */
const routingRulesLog = (page: Page): Locator =>
  routingRulesRow(page).getByRole('list').locator('xpath=..');

const hoursTotals = (page: Page): Locator =>
  page.getByRole('region', { name: 'Hours on this project' });

const overEstimateBanner = (page: Page): Locator =>
  page.getByRole('status').filter({ hasText: 'has gone over estimate' });

const requestChangeCard = (page: Page): Locator =>
  page
    .getByText('Need something different from the plan?', { exact: true })
    .locator('xpath=ancestor::div[contains(@class, "p-5")][1]');

defineGuide('understanding-the-hours-on-your-project', [
  {
    section: 1,
    as: 'client',
    state: 'projects',
    route: PROJECT_ROUTE,
    setup: async (page) => {
      await settleOn(routingRulesRow)(page);
      await routingRulesLogToggle(page).click();
      await page.evaluate(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement) {
          active.blur();
        }
      });
      await page.mouse.move(0, 0);
    },
    // The open log, under the hours bar it explains. Ringing the bar instead would put the badge
    // on its "left of estimate" label and the glow on the log toggle.
    target: routingRulesLog,
    crop: routingRulesRow,
    // From the milestone's title to its start date: the rows either side would be cut mid-line.
    cropArea: async (page) => {
      const row = await boxOf(routingRulesRow(page));
      const title = await boxOf(
        routingRulesRow(page).getByText('Case routing rules', { exact: true })
      );
      const started = await boxOf(routingRulesRow(page).getByText(/^Started /));
      const y = title.y - 14;
      return {
        x: row.x - 12,
        y,
        width: row.width + 24,
        height: started.y + started.height + 12 - y,
      };
    },
    cropPadding: 0,
  },
  {
    section: 2,
    as: 'client',
    state: 'projects',
    route: PROJECT_ROUTE,
    setup: settleOn(hoursTotals),
    target: hoursTotals,
    // From the last milestone down to the foot of the delivery plan, so the hours read as part
    // of the plan.
    cropArea: async (page) => {
      const card = await boxOf(deliveryPlan(page));
      const lastTitle = await boxOf(
        deliveryPlan(page).getByText('Agent console setup', { exact: true })
      );
      const y = lastTitle.y - 20;
      return {
        x: card.x - 8,
        y,
        width: card.width + 16,
        height: card.y + card.height + 8 - y,
      };
    },
    cropPadding: 0,
  },
  {
    section: 3,
    as: 'client',
    state: 'projects',
    route: PROJECT_ROUTE,
    setup: settleOn(overEstimateBanner),
    target: overEstimateBanner,
    cropPadding: 16,
  },
  {
    section: 4,
    as: 'client',
    state: 'projects',
    route: PROJECT_ROUTE,
    setup: settleOn(requestChangeCard),
    target: (page) => page.getByRole('button', { name: 'Request a change' }),
    crop: requestChangeCard,
    cropPadding: 16,
  },
]);
