import { describe, it, expect } from 'vitest';
import { buildConsultationEvent } from './event-mapper.js';

const BASE_INPUT = {
  title: 'Consultation with Dana',
  startAt: new Date('2026-08-20T10:00:00.000Z'),
  endAt: new Date('2026-08-20T10:30:00.000Z'),
  baloBookingId: 'booking-123',
  joinUrl: 'https://balo.expert/meetings/abc/call',
};

describe('buildConsultationEvent (BAL-396 §5/§10.6)', () => {
  it('sets transparency opaque and tags privateExtendedProperties.baloBookingId', () => {
    const event = buildConsultationEvent(BASE_INPUT);
    expect(event.transparency).toBe('opaque');
    expect(event.privateExtendedProperties).toEqual({ baloBookingId: 'booking-123' });
  });

  it('carries the Daily join URL in both description and location', () => {
    const event = buildConsultationEvent(BASE_INPUT);
    expect(event.description).toBe(BASE_INPUT.joinUrl);
    expect(event.location).toBe(BASE_INPUT.joinUrl);
  });

  // BAL-400 (D2) — the case-title widening. `location` is UNCHANGED either way: it always
  // carries the bare join URL (some calendar clients surface `location` as a map/dial-in
  // field, where a case title would be noise).
  it('BAL-400: prefixes description with caseTitle when present, leaves location as the bare URL', () => {
    const event = buildConsultationEvent({ ...BASE_INPUT, caseTitle: 'Salesforce CPQ rollout' });
    expect(event.description).toBe(`Salesforce CPQ rollout\n\n${BASE_INPUT.joinUrl}`);
    expect(event.location).toBe(BASE_INPUT.joinUrl);
  });

  it('BAL-400: description is exactly the join URL when caseTitle is omitted (BAL-396 shape, unchanged)', () => {
    const event = buildConsultationEvent(BASE_INPUT);
    expect(event.description).toBe(BASE_INPUT.joinUrl);
  });

  it('encodes start/end as ISO dateTime with timeZone UTC', () => {
    const event = buildConsultationEvent(BASE_INPUT);
    expect(event.start).toEqual({ dateTime: '2026-08-20T10:00:00.000Z', timeZone: 'UTC' });
    expect(event.end).toEqual({ dateTime: '2026-08-20T10:30:00.000Z', timeZone: 'UTC' });
  });

  it('⚠ never sets an id — a derived id is not a portable idempotency lever (§M1)', () => {
    const event = buildConsultationEvent(BASE_INPUT);
    expect(event.id).toBeUndefined();
  });

  it('⚠ never adds the client as an attendee — comms stay in Balo', () => {
    const event = buildConsultationEvent(BASE_INPUT);
    expect(event.attendees).toBeUndefined();
  });

  it('⚠ never requests vendor meeting generation — Daily is the venue, Microsoft has none anyway', () => {
    const event = buildConsultationEvent(BASE_INPUT);
    expect(event.generateMeetingUrlProvider).toBeUndefined();
  });

  it('a 152-char opaque Microsoft-style calendar id is never touched by the mapper itself', () => {
    // The mapper builds the EVENT body, not a URL — a long opaque calendar id is passed
    // through untouched by whoever calls `events.create(endUserAccountId, calendarId, …)`.
    // Pinned here as documentation that the mapper has no calendar-id-shaped field at all.
    const event = buildConsultationEvent(BASE_INPUT);
    expect(Object.keys(event)).not.toContain('calendarId');
  });
});
