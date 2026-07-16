import { describe, it, expect } from 'vitest';
import { shareDisplayName } from './share-view-types';

describe('shareDisplayName', () => {
  it('joins first and last name', () => {
    expect(shareDisplayName({ firstName: 'Dana', lastName: 'Okafor', email: 'd@x.com' })).toBe(
      'Dana Okafor'
    );
  });

  it('uses whichever name part is present', () => {
    expect(shareDisplayName({ firstName: 'Dana', lastName: null, email: 'd@x.com' })).toBe('Dana');
    expect(shareDisplayName({ firstName: '  ', lastName: 'Okafor', email: 'd@x.com' })).toBe(
      'Okafor'
    );
  });

  it('falls back to a neutral label (never the email) when no name is present', () => {
    expect(shareDisplayName({ firstName: null, lastName: '  ', email: 'd@x.com' })).toBe(
      'a colleague'
    );
  });
});
