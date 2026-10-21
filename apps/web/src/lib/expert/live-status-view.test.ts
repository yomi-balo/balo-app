import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { buildLiveStatusView, publicProfileHrefFor } from './live-status-view';

describe('publicProfileHrefFor', () => {
  it('links to the profile when searchable with a username', () => {
    expect(publicProfileHrefFor('dana', true)).toBe('/experts/dana');
  });

  it.each([
    [null, true],
    ['dana', false],
    [null, false],
    ['', true],
  ])('returns null for username=%s searchable=%s', (username, searchable) => {
    expect(publicProfileHrefFor(username, searchable)).toBeNull();
  });
});

describe('buildLiveStatusView', () => {
  it('returns null when there is no status', () => {
    expect(
      buildLiveStatusView({ liveStatus: null, username: 'dana', searchable: true })
    ).toBeNull();
  });

  it('carries the profile href for a listed state', () => {
    expect(
      buildLiveStatusView({
        liveStatus: { state: 'live', fixItem: null },
        username: 'dana',
        searchable: true,
      })
    ).toEqual({ state: 'live', fixItem: null, publicProfileHref: '/experts/dana' });
  });

  it('has no href for not_listed (searchable is false)', () => {
    expect(
      buildLiveStatusView({
        liveStatus: { state: 'not_listed', fixItem: 'calendar' },
        username: 'dana',
        searchable: false,
      })?.publicProfileHref
    ).toBeNull();
  });

  it('has no href for a null username', () => {
    expect(
      buildLiveStatusView({
        liveStatus: { state: 'paused', fixItem: null },
        username: null,
        searchable: true,
      })?.publicProfileHref
    ).toBeNull();
  });
});
