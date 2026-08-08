import { describe, expect, it } from 'vitest';
import {
  expandOverrideBlocks,
  toResolverConsultations,
  toResolverRules,
} from './resolver-inputs.js';

/**
 * The row → resolver-input projections, extracted by BAL-129 so `resolveAndCacheAvailability`
 * (which computes what every surface ADVERTISES) and `isWindowAvailableForExpert` (which
 * decides what a booking is ACCEPTED against) share ONE definition. If they ever disagreed,
 * the platform would accept a booking for a window it advertises as blocked, or refuse one it
 * advertises as free.
 */
describe('toResolverRules', () => {
  it('narrows a rule row to exactly the three fields the resolver interprets', () => {
    // The narrowing is the point: an availability rule row also carries ids, timestamps and
    // soft-delete columns, and none of them may reach a pure function that only understands a
    // weekday and two wall-clock times.
    expect(
      toResolverRules([
        {
          dayOfWeek: 1,
          startTime: '09:00:00',
          endTime: '17:00:00',
          id: 'rule_1',
          deletedAt: null,
        } as never,
      ])
    ).toEqual([{ dayOfWeek: 1, startTime: '09:00:00', endTime: '17:00:00' }]);
  });

  it('returns [] for no rules', () => {
    expect(toResolverRules([])).toEqual([]);
  });
});

describe('toResolverConsultations', () => {
  it('narrows a consultation row to its window alone', () => {
    const startAt = new Date('2026-09-07T09:00:00.000Z');
    const endAt = new Date('2026-09-07T10:00:00.000Z');

    expect(
      toResolverConsultations([
        { startAt, endAt, expertProfileId: 'e1', status: 'confirmed' } as never,
      ])
    ).toEqual([{ startAt, endAt }]);
  });

  it('returns [] for no consultations', () => {
    expect(toResolverConsultations([])).toEqual([]);
  });
});

describe('expandOverrideBlocks', () => {
  it('treats `endDate` as INCLUSIVE — the interval runs to midnight of the FOLLOWING day', () => {
    // The load-bearing property. An exclusive reading would leave the last day of every
    // holiday bookable.
    expect(
      expandOverrideBlocks([{ startDate: '2026-09-07', endDate: '2026-09-07' }], 'UTC')
    ).toEqual([
      {
        startAt: new Date('2026-09-07T00:00:00.000Z'),
        endAt: new Date('2026-09-08T00:00:00.000Z'),
      },
    ]);
  });

  it('spans a multi-day block end to end', () => {
    expect(
      expandOverrideBlocks([{ startDate: '2026-09-07', endDate: '2026-09-09' }], 'UTC')
    ).toEqual([
      {
        startAt: new Date('2026-09-07T00:00:00.000Z'),
        endAt: new Date('2026-09-10T00:00:00.000Z'),
      },
    ]);
  });

  it('anchors midnight in the EXPERT’s timezone, not UTC', () => {
    // Midnight on 2026-09-07 in Sydney (AEST, UTC+10) is 2026-09-06T14:00Z.
    expect(
      expandOverrideBlocks([{ startDate: '2026-09-07', endDate: '2026-09-07' }], 'Australia/Sydney')
    ).toEqual([
      {
        startAt: new Date('2026-09-06T14:00:00.000Z'),
        endAt: new Date('2026-09-07T14:00:00.000Z'),
      },
    ]);
  });

  it('rolls a month boundary correctly', () => {
    expect(
      expandOverrideBlocks([{ startDate: '2026-09-30', endDate: '2026-09-30' }], 'UTC')
    ).toEqual([
      {
        startAt: new Date('2026-09-30T00:00:00.000Z'),
        endAt: new Date('2026-10-01T00:00:00.000Z'),
      },
    ]);
  });

  it('returns [] for no overrides', () => {
    expect(expandOverrideBlocks([], 'UTC')).toEqual([]);
  });

  it('THROWS on a malformed date rather than dropping the block', () => {
    // Unreachable from a Postgres DATE column, but the failure mode matters: returning the input
    // unchanged would yield a zero-length interval, silently dropping the block and leaving the
    // expert bookable during their own leave.
    expect(() =>
      expandOverrideBlocks([{ startDate: '2026-09-07', endDate: 'oops' }], 'UTC')
    ).toThrow(/expected YYYY-MM-DD/);
  });
});
