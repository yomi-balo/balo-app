import type { Locator, Page } from '@playwright/test';
import { defineGuide } from '../guide';
import type { Box } from '../ring';

/** "CPQ rollout for the sales team": a new fixed-price proposal drafted from Dana's request. */
const DRAFTED_ROUTE =
  '/projects/b1a10598-0000-4000-8000-000000001304/proposal/b1a10598-0000-4000-8000-000000001305';
/** "Customer onboarding portal": fixed price, 30 / 40 / 30, milestones priced A$1,500 short. */
const FIXED_ROUTE =
  '/projects/b1a10598-0000-4000-8000-000000001308/proposal/b1a10598-0000-4000-8000-000000001309';
/** "Marketing Cloud journey support": a time-and-materials draft that is ready to send. */
const TM_ROUTE =
  '/projects/b1a10598-0000-4000-8000-000000001312/proposal/b1a10598-0000-4000-8000-000000001313';
/** "Sales Cloud lead scoring": version 2, revising after Dana asked for one change. */
const REVISE_ROUTE =
  '/projects/b1a10598-0000-4000-8000-000000001319/proposal/b1a10598-0000-4000-8000-00000000131a';
/** The composer fades in; wait for the entrance to finish. */
const SETTLE_MS = 1500;
/** Space kept around a hand-computed crop (the runner's `cropPadding` is 0 for those). */
const GUTTER = 24;

async function settle(page: Page): Promise<void> {
  // The feedback launcher floats over the bottom-right corner of every page.
  await page.addStyleTag({ content: '#__ybug-launcher { display: none !important; }' });
  // The Overview editor loads lazily and replaces a skeleton.
  await page.getByLabel('Proposal overview').first().waitFor();
  await page.waitForTimeout(SETTLE_MS);
  // Park the pointer so no row shows its hover-only controls.
  await page.mouse.move(0, 0);
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(`writing-and-sending-a-proposal: ${locator.toString()} has no box`);
  }
  return box;
}

const section = (page: Page, name: string): Locator => page.getByRole('region', { name });

/** The row of three property chips (Pricing method, Timeframe, Terms). */
const propertyBar = (page: Page): Locator =>
  page.getByRole('button', { name: /^(Fixed price|Time & materials)/ }).locator('xpath=..');

/** The proposal summary in the right-hand rail. */
const summary = (page: Page): Locator =>
  page.getByRole('complementary', { name: 'Proposal summary' });

/** Shrinks a right-aligned, full-width row to its contents so the ring hugs them; nothing moves. */
async function hugRight(locator: Locator): Promise<void> {
  await locator.evaluate((el) => {
    el.style.width = 'fit-content';
    el.style.marginLeft = 'auto';
  });
}

/**
 * Shrinks a row to its contents and pads its ends, with an equal negative margin so nothing moves,
 * so the ring clears the first and last pills instead of sitting on their borders.
 */
async function hugWithInset(locator: Locator): Promise<void> {
  await locator.evaluate((el) => {
    const { marginLeft, marginRight } = getComputedStyle(el);
    el.style.width = 'fit-content';
    el.style.paddingInline = '4px';
    el.style.marginLeft = `calc(${marginLeft} - 4px)`;
    el.style.marginRight = `calc(${marginRight} - 4px)`;
  });
}

/**
 * A composer section from just above its heading to its foot, so nothing from the section
 * above is cut at the top edge.
 */
async function sectionArea(page: Page, name: string): Promise<Box> {
  const region = await boxOf(section(page, name));
  const heading = await boxOf(section(page, name).getByRole('heading').first());
  return {
    x: region.x - GUTTER,
    y: heading.y - GUTTER,
    width: region.width + GUTTER * 2,
    height: region.y + region.height - heading.y + GUTTER * 2,
  };
}

/** A box spanning `from`'s top to `to`'s bottom, across `from`'s width, grown by GUTTER. */
function span(from: Box, to: Box): Box {
  return {
    x: from.x - GUTTER,
    y: from.y - GUTTER,
    width: from.width + GUTTER * 2,
    height: to.y + to.height - from.y + GUTTER * 2,
  };
}

defineGuide('writing-and-sending-a-proposal', [
  {
    section: 1,
    as: 'expert',
    state: 'requests',
    route: DRAFTED_ROUTE,
    setup: settle,
    target: (page) => page.getByText("Drafted from Dana's request"),
    // From the chips and the brief, through the drafted Overview, to the Milestones heading.
    cropArea: async (page) => {
      const bar = await boxOf(propertyBar(page));
      const milestones = await boxOf(section(page, 'Milestones').getByText(/^What you'll deliver/));
      // A short gap below the help line keeps the milestone list's top edge out.
      const area = span(bar, milestones);
      return { ...area, height: area.height - GUTTER + 8 };
    },
    cropPadding: 0,
  },
  {
    section: 2,
    as: 'expert',
    state: 'requests',
    route: DRAFTED_ROUTE,
    setup: async (page) => {
      await settle(page);
      // The row stretches across the column for an empty status slot; shrink it to its chips.
      await hugWithInset(propertyBar(page));
    },
    target: propertyBar,
    radius: 12,
    // The "Proposal for" line and title above the chips.
    cropArea: async (page) => {
      const intro = await boxOf(page.getByText('Proposal for', { exact: false }).first());
      const bar = await boxOf(propertyBar(page));
      const brief = await boxOf(page.getByRole('button', { name: 'Show brief' }));
      // A tighter top keeps the back link above out; the ring's own reach sets the bottom.
      return {
        x: intro.x - GUTTER,
        y: intro.y - 14,
        width: brief.x + brief.width - intro.x + GUTTER * 2,
        height: bar.y + bar.height - intro.y + 14,
      };
    },
    cropPadding: 0,
  },
  {
    section: 3,
    as: 'expert',
    state: 'requests',
    route: FIXED_ROUTE,
    setup: async (page) => {
      await settle(page);
      await hugWithInset(page.getByRole('group', { name: 'Payment presets' }));
    },
    target: (page) => page.getByRole('group', { name: 'Payment presets' }),
    radius: 12,
    crop: (page) => section(page, 'Price and payments'),
    cropArea: (page) => sectionArea(page, 'Price and payments'),
    cropPadding: 0,
  },
  {
    section: 4,
    as: 'expert',
    state: 'requests',
    route: FIXED_ROUTE,
    setup: async (page) => {
      await settle(page);
      const output = page.locator('output').filter({ hasText: 'price left to assign' });
      await hugRight(output);
      // Room on both sides, offset by an equal negative right margin, so the ring clears the text.
      await output.evaluate((el) => {
        const { paddingLeft, paddingRight, marginRight } = getComputedStyle(el);
        el.style.paddingLeft = `calc(${paddingLeft} + 6px)`;
        el.style.paddingRight = `calc(${paddingRight} + 6px)`;
        el.style.marginRight = `calc(${marginRight} - 6px)`;
      });
    },
    target: (page) => page.locator('output').filter({ hasText: 'price left to assign' }),
    radius: 8,
    crop: (page) => section(page, 'Milestones'),
    cropArea: (page) => sectionArea(page, 'Milestones'),
    cropPadding: 0,
  },
  {
    section: 5,
    as: 'expert',
    state: 'requests',
    route: TM_ROUTE,
    setup: settle,
    target: (page) =>
      page
        .getByText('Estimated total', { exact: true })
        .locator('xpath=ancestor::div[contains(@class,"rounded-[12px]")][1]'),
    crop: (page) => section(page, 'Rates and billing'),
    cropArea: (page) => sectionArea(page, 'Rates and billing'),
    cropPadding: 0,
  },
  {
    section: 6,
    as: 'expert',
    state: 'requests',
    route: DRAFTED_ROUTE,
    setup: settle,
    target: (page) => page.getByText(/left before you can send/).locator('xpath=..'),
    radius: 8,
    // The summary rows, the checklist and Preview and send. Starts just below the rows' top
    // divider, so the frame does not open on a bare line.
    cropArea: async (page) => {
      const rows = await boxOf(summary(page).locator('dl').first());
      const card = await boxOf(summary(page));
      return {
        x: card.x,
        y: rows.y + 6,
        width: card.width,
        height: card.y + card.height - rows.y - 6,
      };
    },
    cropPadding: 0,
  },
  {
    section: 8,
    as: 'expert',
    state: 'requests',
    route: REVISE_ROUTE,
    setup: settle,
    target: (page) => page.locator('#proposal-change-note'),
    // Centring the brief keeps the chips clear of the sticky top bar.
    crop: (page) => page.getByRole('button', { name: 'Show brief' }),
    // From the chips and "Not saved until you resend" down to the bottom of the note.
    cropArea: async (page) =>
      span(await boxOf(propertyBar(page)), await boxOf(page.locator('#proposal-change-note'))),
    cropPadding: 0,
  },
]);
