import { describe, it, expect } from 'vitest';
import { TOP_UP_LIMITS_MINOR } from '@balo/shared/credit';
import { buildTopUpFigure, resolveFundingBlockNotice } from './top-up-figure.js';

const AS_OF_ISO = '2026-09-23T14:05:00.000Z';
const AS_OF_LABEL = '2:05 pm UTC, 23 September 2026';

describe('buildTopUpFigure', () => {
  it('quotes the amount with cents and dates it', () => {
    expect(buildTopUpFigure(27_500, AS_OF_ISO)).toEqual({
      amount: 'A$275.00',
      asOf: AS_OF_LABEL,
      exceedsSingleTopUp: false,
      maxTopUp: 'A$10,000',
    });
  });

  it('renders the per-top-up maximum in whole dollars while the amount keeps its cents', () => {
    const figure = buildTopUpFigure(TOP_UP_LIMITS_MINOR.max + 1, AS_OF_ISO);
    expect(figure?.maxTopUp).toBe('A$10,000');
    expect(figure?.amount).toBe('A$10,000.01');
    expect(figure?.exceedsSingleTopUp).toBe(true);
  });

  it('treats the maximum itself as a single top-up', () => {
    const figure = buildTopUpFigure(TOP_UP_LIMITS_MINOR.max, AS_OF_ISO);
    expect(figure?.amount).toBe('A$10,000.00');
    expect(figure?.exceedsSingleTopUp).toBe(false);
  });

  it.each([
    ['zero', 0, AS_OF_ISO],
    ['negative', -1, AS_OF_ISO],
    ['non-finite', Number.NaN, AS_OF_ISO],
    ['undated', 27_500, undefined],
    ['empty-dated', 27_500, ''],
    ['non-string-dated', 27_500, 42],
  ])('is null for a %s figure', (_label, minor, asOfIso) => {
    expect(buildTopUpFigure(minor, asOfIso)).toBeNull();
  });
});

describe('resolveFundingBlockNotice', () => {
  describe('account_on_hold', () => {
    it('with a dated positive figure is the hold arm', () => {
      const notice = resolveFundingBlockNotice('account_on_hold', 27_500, AS_OF_ISO, 0);
      expect(notice).toEqual({ variant: 'hold', figure: buildTopUpFigure(27_500, AS_OF_ISO) });
    });

    it.each([
      ['an absent figure', Number.NaN, AS_OF_ISO],
      ['a zero figure', 0, AS_OF_ISO],
      ['a zero figure with no instant', 0, undefined],
      ['a negative figure', -5, AS_OF_ISO],
    ])('with %s is the failed-heal fallback', (_label, minor, asOfIso) => {
      expect(resolveFundingBlockNotice('account_on_hold', minor, asOfIso, 0)).toEqual({
        variant: 'hold_fallback',
      });
    });

    it.each([
      ['no instant', undefined],
      ['an empty instant', ''],
      ['a non-string instant', 42],
    ])('with a positive figure but %s degrades to unfunded, never the fallback', (_label, asOf) => {
      expect(resolveFundingBlockNotice('account_on_hold', 27_500, asOf, 0)).toEqual({
        variant: 'unfunded',
      });
    });
  });

  describe('reserved_by_upcoming', () => {
    it('with a dated figure and a count is the reserved arm', () => {
      const notice = resolveFundingBlockNotice('reserved_by_upcoming', 12_000, AS_OF_ISO, 2);
      expect(notice).toEqual({
        variant: 'reserved',
        figure: buildTopUpFigure(12_000, AS_OF_ISO),
        count: 2,
      });
    });

    it.each([
      ['no count', 12_000, AS_OF_ISO, 0],
      ['no figure', 0, AS_OF_ISO, 2],
      ['no instant', 12_000, undefined, 2],
    ])('with %s degrades to unfunded', (_label, minor, asOfIso, count) => {
      expect(resolveFundingBlockNotice('reserved_by_upcoming', minor, asOfIso, count)).toEqual({
        variant: 'unfunded',
      });
    });
  });

  it.each([['unfunded'], [undefined], ['something_new'], [null]])(
    'a %s block kind is the unfunded arm even when a figure is present',
    (blockKind) => {
      expect(resolveFundingBlockNotice(blockKind, 27_500, AS_OF_ISO, 3)).toEqual({
        variant: 'unfunded',
      });
    }
  );
});
