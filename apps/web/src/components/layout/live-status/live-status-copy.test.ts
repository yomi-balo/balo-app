import { describe, it, expect } from 'vitest';
import { LIVE_STATUS_TOKENS, liveStatusCopyFor } from './live-status-copy';

describe('liveStatusCopyFor', () => {
  it('live has the design copy and no primary action', () => {
    expect(liveStatusCopyFor({ state: 'live', fixItem: null })).toEqual({
      pill: 'Live',
      title: "You're live on the marketplace",
      body: 'Clients can find you in search and book you.',
      primary: null,
    });
  });

  it('paused points at calendar reconnection', () => {
    const copy = liveStatusCopyFor({ state: 'paused', fixItem: null });
    expect(copy.pill).toBe('Bookings paused');
    expect(copy.title).toBe('Bookings are paused');
    expect(copy.body).toBe(
      "You still appear in search, but clients can't book you until your calendar is reconnected."
    );
    expect(copy.primary).toEqual({
      label: 'Reconnect calendar',
      action: 'reconnect_calendar',
      href: '/expert/settings?tab=schedule&setup=calendar',
    });
  });

  it('away points at the schedule tab', () => {
    const copy = liveStatusCopyFor({ state: 'away', fixItem: null });
    expect(copy.pill).toBe('Not taking work');
    expect(copy.title).toBe("You're not taking on new work");
    expect(copy.body).toBe(
      'You still appear in search, but clients are offered a similar expert instead of booking you.'
    );
    expect(copy.primary).toEqual({
      label: 'Change availability',
      action: 'change_availability',
      href: '/expert/settings?tab=schedule',
    });
  });

  it('not_listed from a calendar break uses the design copy as-is', () => {
    const copy = liveStatusCopyFor({ state: 'not_listed', fixItem: 'calendar' });
    expect(copy.pill).toBe('Not listed');
    expect(copy.title).toBe("You're not in search right now");
    expect(copy.body).toBe("Clients can't find you until your calendar is reconnected.");
    expect(copy.primary?.label).toBe('Reconnect calendar');
  });

  it('not_listed from another item names that item and deep-links to it', () => {
    const copy = liveStatusCopyFor({ state: 'not_listed', fixItem: 'payouts' });
    expect(copy.body).toBe("Clients can't find you until your setup is complete.");
    expect(copy.primary).toEqual({
      label: 'Set up payouts',
      action: 'finish_setup',
      href: '/expert/settings?tab=payouts&setup=payouts',
    });
  });

  it('not_listed with no failing item has no action', () => {
    const copy = liveStatusCopyFor({ state: 'not_listed', fixItem: null });
    expect(copy.body).toBe("Clients can't find you right now.");
    expect(copy.primary).toBeNull();
  });

  it('has a token entry for every state', () => {
    expect(Object.keys(LIVE_STATUS_TOKENS).sort()).toEqual([
      'away',
      'live',
      'not_listed',
      'paused',
    ]);
  });
});
