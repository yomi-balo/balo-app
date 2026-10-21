import { describe, expect, it } from 'vitest';
import { TOP_UP_LIMITS_MINOR } from '@balo/shared/credit';
import { offersPayAfter, resolveFundingDisposition } from './funding-disposition';
import { refusedView } from './funding-fixtures';

describe('resolveFundingDisposition', () => {
  it.each([
    ['no answer yet', null],
    ['clear', { kind: 'clear' } as const],
    ['unavailable', { kind: 'unavailable' } as const],
  ])('is none for %s', (_label, view) => {
    expect(resolveFundingDisposition(view)).toBe('none');
  });

  it('is inline for a billing manager of the active company', () => {
    expect(resolveFundingDisposition(refusedView())).toBe('inline');
  });

  it('is inline for a manager exactly at one top-up', () => {
    expect(
      resolveFundingDisposition(refusedView({ suggestedTopUpMinor: TOP_UP_LIMITS_MINOR.max }))
    ).toBe('inline');
  });

  it('is panel for a manager when the amount is one step above a single top-up', () => {
    expect(
      resolveFundingDisposition(
        refusedView({ suggestedTopUpMinor: TOP_UP_LIMITS_MINOR.max + TOP_UP_LIMITS_MINOR.step })
      )
    ).toBe('panel');
  });

  it('is panel for a manager when the refusing company is not the active workspace', () => {
    expect(
      resolveFundingDisposition(
        refusedView({ company: { id: 'company-2', name: 'Contoso', isActive: false } })
      )
    ).toBe('panel');
  });

  it('is panel for a manager with no wallet to pay with', () => {
    expect(resolveFundingDisposition(refusedView({ wallet: null }))).toBe('panel');
  });

  it('is inline for a member on a non-active company', () => {
    expect(
      resolveFundingDisposition(
        refusedView({
          canManageBilling: false,
          wallet: null,
          company: { id: 'company-2', name: 'Contoso', isActive: false },
        })
      )
    ).toBe('inline');
  });

  it('is inline for a member whatever the amount', () => {
    expect(
      resolveFundingDisposition(
        refusedView({
          canManageBilling: false,
          wallet: null,
          suggestedTopUpMinor: TOP_UP_LIMITS_MINOR.max * 2,
        })
      )
    ).toBe('inline');
  });
});

describe('offersPayAfter', () => {
  it.each([
    ['setup', true],
    ['reserved', true],
    ['hold', false],
  ] as const)('for a manager on the %s arm is %s', (arm, expected) => {
    expect(offersPayAfter(refusedView({ arm }))).toBe(expected);
  });

  it('is false for a member on every arm', () => {
    for (const arm of ['setup', 'reserved', 'hold'] as const) {
      expect(offersPayAfter(refusedView({ arm, canManageBilling: false, wallet: null }))).toBe(
        false
      );
    }
  });
});
