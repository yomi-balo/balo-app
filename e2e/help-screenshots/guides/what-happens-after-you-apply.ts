import { defineGuide } from '../guide';

/** The page's entrance animations finish by about 2 s. */
const SUCCESS_SETTLE_MS = 2500;

defineGuide('what-happens-after-you-apply', [
  {
    section: 1,
    as: 'expert',
    state: 'available',
    route: '/expert/apply/success',
    setup: async (page) => {
      await page.waitForTimeout(SUCCESS_SETTLE_MS);
    },
    target: (page) => page.getByText(/within 2.3 business days/),
    crop: (page) => page.getByRole('heading', { name: 'Application Received!' }),
    cropPadding: 120,
  },
  {
    section: 3,
    as: 'expert',
    state: 'setup-incomplete',
    route: '/expert/settings',
    target: (page) =>
      page
        .getByText(/Not visible to clients yet/)
        .locator('xpath=ancestor::*[contains(@class, "rounded-[10px]")][1]'),
  },
  {
    section: 4,
    as: 'expert',
    state: 'rejected',
    route: '/expert/apply',
    target: (page) => page.getByRole('button', { name: /Start a new application/ }),
    crop: (page) =>
      page
        .getByRole('button', { name: /Start a new application/ })
        .locator('xpath=ancestor::div[contains(@class, "rounded")][1]'),
    cropPadding: 16,
  },
]);
