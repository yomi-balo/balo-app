import type { Page } from '@playwright/test';
import { defineGuide } from '../guide';

const SETTINGS_ROUTE = '/expert/settings';
/** Settings tabs fade their cards in; wait for the entrance to finish. */
const SETTLE_MS = 1500;

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(SETTLE_MS);
}

defineGuide('rate-and-payouts', [
  {
    section: 1,
    as: 'expert',
    state: 'available',
    route: `${SETTINGS_ROUTE}?tab=rate`,
    setup: settle,
    target: (page) => page.getByRole('radiogroup', { name: 'Enter your rate' }),
    // The rate card only: it stops above the "What clients see" box and starts below the page
    // header, so no client price or fee wording enters the frame.
    cropArea: async (page, targetBox) => {
      const card = await page
        .locator('[data-slot="card"]')
        .filter({ hasText: 'Your Rate' })
        .first()
        .boundingBox();
      const conversion = await page.locator('p[aria-live="polite"]').first().boundingBox();
      if (!card || !conversion) {
        throw new Error('Rate card or its conversion line has no box');
      }
      return {
        x: card.x,
        y: targetBox.y - 24,
        width: card.width,
        height: conversion.y + conversion.height + 16 - (targetBox.y - 24),
      };
    },
    cropPadding: 0,
  },
  {
    section: 2,
    as: 'expert',
    state: 'available',
    route: `${SETTINGS_ROUTE}?tab=payouts`,
    setup: settle,
    target: (page) => page.getByRole('button', { name: 'Edit payout details' }),
    crop: (page) =>
      page.locator('[data-slot="card"]').filter({ hasText: 'Edit payout details' }).first(),
  },
  {
    section: 3,
    as: 'expert',
    state: 'available',
    route: SETTINGS_ROUTE,
    // The line spans the whole content width; shrink it to its text so the ring hugs the words.
    setup: async (page) => {
      await settle(page);
      await page.getByText("You're appearing in search.").evaluate((el) => {
        el.style.width = 'fit-content';
        el.style.padding = '4px 10px';
      });
    },
    target: (page) => page.getByText("You're appearing in search."),
    cropArea: async (_page, targetBox) => ({
      x: targetBox.x - 40,
      y: Math.max(targetBox.y - 40, 0),
      width: targetBox.width + 80,
      height: 110,
    }),
    cropPadding: 0,
  },
]);
