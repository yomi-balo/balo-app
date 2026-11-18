import { describe, expect, it } from 'vitest';
import { canBookInPage } from './book-in-page';

describe('canBookInPage', () => {
  it('is true for a client on an open case with a public expert profile', () => {
    expect(canBookInPage({ lens: 'client', isOpen: true, hasPublicProfile: true })).toBe(true);
  });

  it.each([
    ['an expert viewer', { lens: 'expert', isOpen: true, hasPublicProfile: true }],
    ['a closed case', { lens: 'client', isOpen: false, hasPublicProfile: true }],
    ['an expert with no public profile', { lens: 'client', isOpen: true, hasPublicProfile: false }],
  ] as const)('is false for %s', (_label, input) => {
    expect(canBookInPage(input)).toBe(false);
  });
});
