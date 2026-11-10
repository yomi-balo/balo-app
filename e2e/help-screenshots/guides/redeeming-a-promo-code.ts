import { defineGuide } from '../guide';

defineGuide('redeeming-a-promo-code', [
  {
    section: 1,
    as: 'client',
    state: 'available',
    route: '/redeem',
    setup: async (page) => {
      // A typed code turns Redeem on; nothing is submitted.
      const field = page.getByLabel('Promo code');
      await field.fill('WELCOME50');
      await field.blur();
      await page.mouse.move(0, 0);
    },
    target: (page) => page.getByRole('button', { name: 'Redeem', exact: true }),
    crop: (page) =>
      page
        .getByRole('heading', { name: 'Redeem a promo code' })
        .locator('xpath=ancestor::div[contains(@class, "rounded-2xl")][1]'),
    cropPadding: 16,
  },
  {
    section: 3,
    as: 'client',
    state: 'available',
    route: '/settings/billing',
    setup: async (page) => {
      await page.mouse.move(0, 0);
    },
    target: (page) =>
      page
        .getByRole('main')
        .getByText('Visa •••• 4242', { exact: true })
        .locator('xpath=ancestor::div[contains(@class, "rounded-xl")][1]'),
    crop: (page) =>
      page
        .getByRole('main')
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: 'Payment method', level: 2 }) }),
    cropPadding: 8,
  },
]);
