import { describe, expect, it } from 'vitest';
import { buildGoogleCalendarLink } from './google-calendar-link';

const START = new Date('2026-11-17T22:00:00.000Z');
const END = new Date('2026-11-17T23:00:00.000Z');

function parse(link: string): URL {
  return new URL(link);
}

describe('buildGoogleCalendarLink', () => {
  it('targets Google Calendar’s create-event form', () => {
    const url = parse(buildGoogleCalendarLink({ title: 'Consultation', start: START, end: END }));
    expect(`${url.origin}${url.pathname}`).toBe('https://calendar.google.com/calendar/render');
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
  });

  it('writes the window as UTC basic-format stamps joined by a slash', () => {
    const url = parse(buildGoogleCalendarLink({ title: 'Consultation', start: START, end: END }));
    expect(url.searchParams.get('dates')).toBe('20261117T220000Z/20261117T230000Z');
  });

  it('round-trips title, details and location through URL encoding', () => {
    const url = parse(
      buildGoogleCalendarLink({
        title: 'Consultation with Northwind, Inc. & Co',
        start: START,
        end: END,
        details: 'Line one\n\nJoin: https://app.balo.expert/meetings/m-1/call?x=1&y=2',
        location: 'https://app.balo.expert/meetings/m-1/call',
      })
    );
    expect(url.searchParams.get('text')).toBe('Consultation with Northwind, Inc. & Co');
    expect(url.searchParams.get('details')).toBe(
      'Line one\n\nJoin: https://app.balo.expert/meetings/m-1/call?x=1&y=2'
    );
    expect(url.searchParams.get('location')).toBe('https://app.balo.expert/meetings/m-1/call');
  });

  it('omits details and location when not given', () => {
    const url = parse(buildGoogleCalendarLink({ title: 'Consultation', start: START, end: END }));
    expect(url.searchParams.has('details')).toBe(false);
    expect(url.searchParams.has('location')).toBe(false);
  });
});
