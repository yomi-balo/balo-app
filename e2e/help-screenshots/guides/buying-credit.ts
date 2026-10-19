import { defineGuide } from '../guide';

const TOP_UP_ROUTE = '/billing/top-up';

defineGuide('buying-credit', [
  {
    section: 1,
    as: 'client',
    state: 'available',
    route: TOP_UP_ROUTE,
    target: (page) => page.getByText('Choose an amount', { exact: true }).locator('xpath=..'),
  },
  {
    section: 2,
    as: 'client',
    state: 'available',
    route: TOP_UP_ROUTE,
    setup: async (page) => {
      await page.getByRole('button', { name: 'Have a promo code?' }).click();
    },
    target: (page) => page.locator('#promo-disclosure'),
  },
  {
    section: 3,
    as: 'client',
    state: 'available',
    route: TOP_UP_ROUTE,
    target: (page) => page.locator('div.sticky').filter({ hasText: 'Paying with' }).first(),
  },
  {
    section: 4,
    as: 'client',
    state: 'available',
    route: TOP_UP_ROUTE,
    target: (page) => page.locator('[aria-labelledby="low-balance-mode-label"]'),
  },
  {
    section: 5,
    as: 'client',
    state: 'client-member',
    route: TOP_UP_ROUTE,
    target: (page) =>
      page
        .locator('div')
        .filter({ hasText: 'Team balance' })
        .filter({ hasText: 'billing admin manages top-ups' })
        .last(),
  },
]);
