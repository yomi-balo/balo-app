import { describe, expect, it } from 'vitest';
import { HELP_CATEGORIES, isHelpCategoryId } from './categories';

describe('HELP_CATEGORIES', () => {
  it('lists the reference ids per side, in order 1..5', () => {
    expect(HELP_CATEGORIES.client.map((category) => category.id)).toEqual([
      'getting-started',
      'calls',
      'cases-projects',
      'credit-billing',
      'your-company',
    ]);
    expect(HELP_CATEGORIES.expert.map((category) => category.id)).toEqual([
      'getting-started',
      'getting-booked',
      'calls-cases',
      'projects',
      'getting-paid',
    ]);
    for (const side of Object.values(HELP_CATEGORIES)) {
      expect(side.map((category) => category.order)).toEqual([1, 2, 3, 4, 5]);
    }
  });
});

describe('isHelpCategoryId', () => {
  it('checks the id against the given side only', () => {
    expect(isHelpCategoryId('client', 'calls')).toBe(true);
    expect(isHelpCategoryId('expert', 'calls')).toBe(false);
    expect(isHelpCategoryId('expert', 'getting-paid')).toBe(true);
  });
});
