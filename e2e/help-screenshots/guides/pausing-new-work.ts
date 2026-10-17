import { defineGuide } from '../guide';

/** Room under the paused note for the heading, eyebrow and two dimmed day rows. */
const ROWS_BELOW_NOTE_PX = 190;
/** Reaches back over the calendar's time-label gutter. */
const CALENDAR_GUTTER_PX = 90;
const SCHEDULE_ROUTE = '/expert/settings?tab=schedule';

defineGuide('pausing-new-work', [
  {
    section: 1,
    as: 'expert',
    state: 'available',
    route: SCHEDULE_ROUTE,
    target: (page) => page.getByRole('switch', { name: 'Available for new work' }),
    crop: (page) => page.locator('section[aria-label="Availability for new work"]'),
    radius: 999,
  },
  {
    section: 2,
    as: 'visitor',
    state: 'paused',
    route: '/experts/priya-raman',
    target: (page) =>
      page.locator('.bg-paused-hatch').filter({ hasText: "isn't taking on new work right now" }),
    crop: (page) =>
      page.locator('[data-slot="card"]').filter({ hasText: 'Not taking on new work right now' }),
  },
  {
    section: 3,
    as: 'expert',
    state: 'paused',
    route: (anchor) => `/expert/calendar?week=${anchor}`,
    // The accessible name is "<time range>, <type> with <client company>" (meeting-block.tsx).
    target: (page) =>
      page
        .getByRole('link', { name: /with Northwind Industrial/ })
        .or(page.getByRole('article', { name: /with Northwind Industrial/ }))
        .first(),
    // Time gutter on the left and the neighbouring day columns on the right, kept below the
    // day headers so no dates appear.
    cropArea: async (_page, targetBox) => ({
      x: targetBox.x - CALENDAR_GUTTER_PX,
      y: targetBox.y - 90,
      width: 600,
      height: targetBox.height + 180,
    }),
    cropPadding: 0,
  },
  {
    section: 4,
    as: 'expert',
    state: 'paused',
    route: SCHEDULE_ROUTE,
    // The paused note is ringed. The clip is the Availability card's width, from its top down to
    // two weekly-hour rows below the note, so no sidebar or neighbouring card enters the frame.
    target: (page) => page.locator('#schedule-paused-note'),
    cropArea: async (page, targetBox) => {
      const card = await page
        .locator('[aria-labelledby="schedule-availability-heading"]')
        .boundingBox();
      if (!card) {
        throw new Error('Availability card has no box');
      }
      const bottom = targetBox.y + targetBox.height + ROWS_BELOW_NOTE_PX;
      return { x: card.x, y: card.y, width: card.width, height: bottom - card.y };
    },
    cropPadding: 0,
  },
]);
