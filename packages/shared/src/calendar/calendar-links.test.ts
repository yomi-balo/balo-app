import { describe, expect, it } from 'vitest';
import { buildGoogleCalendarLink, buildOutlookCalendarLink } from './calendar-links';

const START = new Date('2026-11-17T22:00:00.000Z');
const END = new Date('2026-11-17T23:00:00.000Z');
const FULL = {
  title: 'Consultation with Northwind, Inc. & Co',
  start: START,
  end: END,
  details: 'Line one\n\nJoin: https://app.balo.expert/meetings/m-1/call?x=1&y=2',
  location: 'https://app.balo.expert/meetings/m-1/call',
};

describe('buildGoogleCalendarLink', () => {
  it('targets Google Calendar’s create-event form', () => {
    const url = new URL(buildGoogleCalendarLink({ title: 'Consultation', start: START, end: END }));
    expect(`${url.origin}${url.pathname}`).toBe('https://calendar.google.com/calendar/render');
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
  });

  it('writes the window as UTC basic-format stamps joined by a slash', () => {
    const url = new URL(buildGoogleCalendarLink({ title: 'Consultation', start: START, end: END }));
    expect(url.searchParams.get('dates')).toBe('20261117T220000Z/20261117T230000Z');
  });

  it('round-trips title, details and location through URL encoding', () => {
    const url = new URL(buildGoogleCalendarLink(FULL));
    expect(url.searchParams.get('text')).toBe(FULL.title);
    expect(url.searchParams.get('details')).toBe(FULL.details);
    expect(url.searchParams.get('location')).toBe(FULL.location);
  });

  it('omits details and location when not given', () => {
    const url = new URL(buildGoogleCalendarLink({ title: 'Consultation', start: START, end: END }));
    expect(url.searchParams.has('details')).toBe(false);
    expect(url.searchParams.has('location')).toBe(false);
  });
});

describe('buildOutlookCalendarLink', () => {
  it.each([
    ['personal', 'https://outlook.live.com/calendar/0/action/compose'],
    ['work', 'https://outlook.office.com/calendar/0/action/compose'],
  ] as const)('%s targets %s', (kind, base) => {
    const url = new URL(buildOutlookCalendarLink(FULL, kind));
    expect(`${url.origin}${url.pathname}`).toBe(base);
    expect(url.searchParams.get('rru')).toBe('addevent');
  });

  it('writes the window as ISO 8601 UTC and round-trips the text fields', () => {
    const url = new URL(buildOutlookCalendarLink(FULL, 'personal'));
    expect(url.searchParams.get('startdt')).toBe('2026-11-17T22:00:00Z');
    expect(url.searchParams.get('enddt')).toBe('2026-11-17T23:00:00Z');
    expect(url.searchParams.get('subject')).toBe(FULL.title);
    expect(url.searchParams.get('body')).toBe(FULL.details);
    expect(url.searchParams.get('location')).toBe(FULL.location);
  });

  it('omits body and location when not given', () => {
    const url = new URL(
      buildOutlookCalendarLink({ title: 'Consultation', start: START, end: END }, 'work')
    );
    expect(url.searchParams.has('body')).toBe(false);
    expect(url.searchParams.has('location')).toBe(false);
  });
});
