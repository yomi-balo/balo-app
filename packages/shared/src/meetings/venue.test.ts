import { describe, expect, it } from 'vitest';
import { dailyRoomNameForMeeting } from './room-name';
import {
  MEETING_PROVISION_TRIGGERS,
  isMeetingVenueReady,
  meetingVenueReadyAt,
  type MeetingVenueFields,
  type MeetingVenueStampFields,
} from './venue';

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const OTHER_MEETING_ID = 'ffffffff-0000-4000-8000-123456789abc';
const DERIVED = dailyRoomNameForMeeting(MEETING_ID);
const OTHER_DERIVED = dailyRoomNameForMeeting(OTHER_MEETING_ID);
const JOIN_URL = 'https://balo.daily.co/balo-0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d';

const STAMP_AT_BOOKING = new Date('2026-01-01T00:00:00.000Z');
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

/**
 * BAL-581 — THE PIN for {@link isMeetingVenueReady}: the exact predicate the join path, the
 * lifecycle sweep, the absence recheck and `load-case.ts` all share. Every not-ready row exists
 * to keep a partially-stamped or misnamed room from ever reading as ready.
 */
describe('isMeetingVenueReady', () => {
  it.each([
    { label: 'neither column stamped', dailyRoomName: null, joinUrl: null, ready: false },
    {
      label: 'room name stamped, no join url',
      dailyRoomName: DERIVED,
      joinUrl: null,
      ready: false,
    },
    {
      label: 'join url stamped, no room name',
      dailyRoomName: null,
      joinUrl: JOIN_URL,
      ready: false,
    },
    {
      label: 'both columns stamped, name matches',
      dailyRoomName: DERIVED,
      joinUrl: JOIN_URL,
      ready: true,
    },
    {
      label: "both columns stamped, but the name is ANOTHER meeting's",
      dailyRoomName: OTHER_DERIVED,
      joinUrl: JOIN_URL,
      ready: false,
    },
    {
      label: 'both columns stamped, name differs only by case',
      dailyRoomName: DERIVED.toUpperCase(),
      joinUrl: JOIN_URL,
      ready: false,
    },
  ])('$label → ready === $ready', ({ dailyRoomName, joinUrl, ready }) => {
    const meeting: MeetingVenueFields = { id: MEETING_ID, dailyRoomName, joinUrl };
    expect(isMeetingVenueReady(meeting)).toBe(ready);
  });

  it('is false when the fixture OMITS `joinUrl` entirely, not merely when it is null', () => {
    // ⚠ `typeof … === 'string'`, not `!== null` — an untyped fixture missing the column reads
    // `undefined`, which must read as "not ready" rather than slipping through the guard.
    const meeting = { id: MEETING_ID, dailyRoomName: DERIVED } as unknown as MeetingVenueFields;
    expect(isMeetingVenueReady(meeting)).toBe(false);
  });
});

describe('meetingVenueReadyAt', () => {
  it('returns null for a not-ready row, even one carrying a stamp', () => {
    const meeting: MeetingVenueStampFields = {
      id: MEETING_ID,
      dailyRoomName: null,
      joinUrl: null,
      venueProvisionedAt: STAMP_AT_BOOKING,
      createdAt: CREATED_AT,
    };
    expect(meetingVenueReadyAt(meeting)).toBeNull();
  });

  it('returns the stamp when ready and the column is populated', () => {
    const readyAt = new Date('2026-02-02T10:00:00.000Z');
    const meeting: MeetingVenueStampFields = {
      id: MEETING_ID,
      dailyRoomName: DERIVED,
      joinUrl: JOIN_URL,
      venueProvisionedAt: readyAt,
      createdAt: CREATED_AT,
    };
    expect(meetingVenueReadyAt(meeting)).toBe(readyAt);
  });

  it('falls back to createdAt when ready but the stamp column is null', () => {
    const meeting: MeetingVenueStampFields = {
      id: MEETING_ID,
      dailyRoomName: DERIVED,
      joinUrl: JOIN_URL,
      venueProvisionedAt: null,
      createdAt: CREATED_AT,
    };
    expect(meetingVenueReadyAt(meeting)).toBe(CREATED_AT);
  });
});

describe('MEETING_PROVISION_TRIGGERS', () => {
  it('is exactly the three triggers, in order', () => {
    expect(MEETING_PROVISION_TRIGGERS).toEqual(['booking', 'replay', 'repair']);
  });
});
