import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDefaultNormalizer } from '@testing-library/react';
import { render, screen } from '@/test/utils';
import { axe } from '@/test/axe';
import * as ics from '@/components/booking/ics';
import { CALENDAR_EVENTS, track } from '@/lib/analytics';
import { AddToCalendarPanel, formatCallWindow } from './add-to-calendar-panel';

const EVENT = {
  title: 'Consultation with Northwind Industrial',
  startIso: '2099-03-02T22:00:00.000Z',
  endIso: '2099-03-02T23:00:00.000Z',
  details: 'CPQ rollout\n\nJoin: https://app.balo.expert/meetings/m-1/call',
  location: 'https://app.balo.expert/meetings/m-1/call',
};

/** The URL `globalThis.open` was handed when the named option was clicked. */
function openedUrlFor(name: RegExp): URL {
  const open = vi.spyOn(globalThis, 'open').mockReturnValue(null);
  screen.getByRole('button', { name }).click();
  const [url, target, features] = open.mock.calls.at(-1) ?? [];
  expect(target).toBe('_blank');
  expect(features).toBe('noopener,noreferrer');
  return new URL(String(url));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AddToCalendarPanel', () => {
  it('opens each web calendar on a pre-filled event carrying the token’s fields', () => {
    render(<AddToCalendarPanel event={EVENT} isPast={false} />);

    const google = openedUrlFor(/Google Calendar/);
    expect(google.hostname).toBe('calendar.google.com');
    expect(google.searchParams.get('text')).toBe(EVENT.title);
    expect(google.searchParams.get('dates')).toBe('20990302T220000Z/20990302T230000Z');
    expect(google.searchParams.get('details')).toBe(EVENT.details);
    expect(google.searchParams.get('location')).toBe(EVENT.location);

    expect(openedUrlFor(/Outlook\.com/).hostname).toBe('outlook.live.com');
    expect(openedUrlFor(/work or school/).hostname).toBe('outlook.office.com');
  });

  /**
   * ⚠ The event's contents must not sit in the DOM as an href: PostHog autocapture records an
   * anchor's href on click (`$external_click_url`, `$elements_chain`), out of reach of
   * `sanitizeAnalyticsEvent`.
   */
  it('puts no link to a calendar provider in the DOM', () => {
    const { container } = render(<AddToCalendarPanel event={EVENT} isPast={false} />);
    expect(container.querySelectorAll('a[href]')).toHaveLength(0);
    expect(container.innerHTML).not.toMatch(/calendar\.google\.com|outlook\.(live|office)\.com/);
  });

  it('downloads an .ics with the title, length, description and location', async () => {
    const spy = vi.spyOn(ics, 'downloadIcsEvent').mockImplementation(() => {});
    render(<AddToCalendarPanel event={EVENT} isPast={false} />);
    screen.getByRole('button', { name: /\.ics/ }).click();
    expect(spy).toHaveBeenCalledWith({
      summary: EVENT.title,
      startIso: EVENT.startIso,
      durationMinutes: 60,
      filename: 'balo-call.ics',
      description: EVENT.details,
      location: EVENT.location,
    });
  });

  it('tracks which option was chosen, on the invite page surface', () => {
    vi.spyOn(ics, 'downloadIcsEvent').mockImplementation(() => {});
    vi.spyOn(globalThis, 'open').mockReturnValue(null);
    render(<AddToCalendarPanel event={EVENT} isPast={false} />);
    screen.getByRole('button', { name: /Google Calendar/ }).click();
    screen.getByRole('button', { name: /\.ics/ }).click();
    expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.ADD_OPTION_CLICKED, {
      option: 'google',
      surface: 'invite_page',
    });
    expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.ADD_OPTION_CLICKED, {
      option: 'ics',
      surface: 'invite_page',
    });
  });

  it('a past call shows no calendar actions', () => {
    render(<AddToCalendarPanel event={EVENT} isPast />);
    expect(screen.getByText(/already taken place/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the call window in the reader’s own time zone once mounted', () => {
    render(<AddToCalendarPanel event={EVENT} isPast={false} />);
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // Intl's thin / narrow no-break spaces must survive — the default normaliser collapses them.
    const exact = getDefaultNormalizer({ trim: false, collapseWhitespace: false });
    expect(
      screen.getByText(formatCallWindow(EVENT.startIso, EVENT.endIso, zone), { normalizer: exact })
    ).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<AddToCalendarPanel event={EVENT} isPast={false} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('formatCallWindow', () => {
  it('formats the day and the time range in the given zone, and names the zone', () => {
    // Intl separates the range with thin / narrow no-break spaces — normalise before comparing.
    const out = formatCallWindow(EVENT.startIso, EVENT.endIso, 'Australia/Melbourne');
    expect(out.replace(/[\u2009\u202f\u00a0]/g, ' ')).toBe('Tue, Mar 3 · 9:00 – 10:00 AM GMT+11');
  });
});
