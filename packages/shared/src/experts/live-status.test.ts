import { describe, it, expect } from 'vitest';
import { deriveExpertLiveStatus, isExpertLiveStatusVisible } from './live-status';

const base = {
  allComplete: true,
  liveCelebrationSeen: false,
  searchable: true,
  availableForWork: true,
  failingItems: [] as const,
  hasUnreadableBusyTarget: false,
};

describe('isExpertLiveStatusVisible', () => {
  it.each([
    [false, false, false],
    [true, false, true],
    [false, true, true],
    [true, true, true],
  ])('allComplete=%s seen=%s -> %s', (allComplete, liveCelebrationSeen, expected) => {
    expect(isExpertLiveStatusVisible({ allComplete, liveCelebrationSeen })).toBe(expected);
  });
});

describe('deriveExpertLiveStatus', () => {
  it('is null before go-live', () => {
    expect(
      deriveExpertLiveStatus({ ...base, allComplete: false, liveCelebrationSeen: false })
    ).toBeNull();
  });

  it('stays visible after a regression (incomplete but seen)', () => {
    expect(
      deriveExpertLiveStatus({
        ...base,
        allComplete: false,
        liveCelebrationSeen: true,
        searchable: false,
        failingItems: ['payouts'],
      })
    ).toEqual({ state: 'not_listed', fixItem: 'payouts' });
  });

  it('returns live when everything is healthy', () => {
    expect(deriveExpertLiveStatus(base)).toEqual({ state: 'live', fixItem: null });
  });

  it('not_listed beats away and paused', () => {
    expect(
      deriveExpertLiveStatus({
        ...base,
        searchable: false,
        availableForWork: false,
        hasUnreadableBusyTarget: true,
      })?.state
    ).toBe('not_listed');
  });

  it('away beats paused', () => {
    expect(
      deriveExpertLiveStatus({ ...base, availableForWork: false, hasUnreadableBusyTarget: true })
    ).toEqual({ state: 'away', fixItem: null });
  });

  it('paused when a busy target is unreadable', () => {
    expect(deriveExpertLiveStatus({ ...base, hasUnreadableBusyTarget: true })).toEqual({
      state: 'paused',
      fixItem: null,
    });
  });

  it('fixItem prefers calendar over an earlier failing item', () => {
    expect(
      deriveExpertLiveStatus({
        ...base,
        searchable: false,
        failingItems: ['payouts', 'calendar'],
      })?.fixItem
    ).toBe('calendar');
  });

  it('fixItem is the first failing item when calendar is not failing', () => {
    expect(
      deriveExpertLiveStatus({
        ...base,
        searchable: false,
        failingItems: ['availability', 'payouts'],
      })?.fixItem
    ).toBe('availability');
  });

  it('fixItem is null for a failed reconcile with no failing items', () => {
    expect(deriveExpertLiveStatus({ ...base, searchable: false })).toEqual({
      state: 'not_listed',
      fixItem: null,
    });
  });
});
