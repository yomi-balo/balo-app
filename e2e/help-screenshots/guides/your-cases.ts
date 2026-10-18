import { defineGuide } from '../guide';

const FEATURED_TICKET = 'article';

defineGuide('your-cases', [
  {
    section: 1,
    as: 'client',
    state: 'available',
    route: '/cases',
    target: (page) =>
      page.locator(FEATURED_TICKET).filter({ hasText: 'Your next consultation' }).first(),
  },
  {
    section: 2,
    as: 'expert',
    state: 'available',
    route: '/cases',
    target: (page) =>
      page.locator(FEATURED_TICKET).filter({ hasText: 'Your next consultation' }).first(),
  },
  {
    section: 3,
    as: 'client',
    state: 'auto-closed',
    route: '/cases',
    setup: async (page) => {
      await page.getByRole('button', { name: /^Resolved/ }).click();
      // Park the pointer so no row carries a hover tint.
      await page.mouse.move(0, 0);
    },
    target: (page) => page.getByText('Closed automatically on').first(),
    crop: (page) =>
      page
        .getByText('Closed automatically on')
        .first()
        .locator('xpath=ancestor::div[contains(@class, "divide-border")][1]'),
    cropPadding: 16,
  },
]);
