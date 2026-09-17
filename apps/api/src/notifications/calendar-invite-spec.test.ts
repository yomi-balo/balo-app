import { describe, expect, it } from 'vitest';
import {
  CALENDAR_INVITE_METHOD,
  calendarInviteRecipientId,
  calendarInviteRecipientKey,
  readCalendarInviteSpec,
  type CalendarInviteSpec,
} from './calendar-invite-spec.js';

const VALID_USER_SPEC: CalendarInviteSpec = {
  meetingId: 'meeting-1',
  party: 'client',
  calendarEventId: 'row-1',
  method: CALENDAR_INVITE_METHOD,
  transition: 'booked',
  recipient: { kind: 'user', userId: 'user-1' },
  contextType: 'case',
};

const VALID_GUEST_SPEC: CalendarInviteSpec = {
  meetingId: 'meeting-1',
  party: 'expert',
  calendarEventId: 'row-2',
  method: CALENDAR_INVITE_METHOD,
  transition: 'guest_added',
  recipient: { kind: 'guest', guestId: 'guest-1' },
  contextType: null,
};

describe('readCalendarInviteSpec', () => {
  it('accepts a well-formed user-recipient spec', () => {
    expect(readCalendarInviteSpec(VALID_USER_SPEC)).toEqual(VALID_USER_SPEC);
  });

  it('accepts a well-formed guest-recipient spec', () => {
    expect(readCalendarInviteSpec(VALID_GUEST_SPEC)).toEqual(VALID_GUEST_SPEC);
  });

  it('rejects a non-object', () => {
    expect(readCalendarInviteSpec(undefined)).toBeUndefined();
    expect(readCalendarInviteSpec(null)).toBeUndefined();
    expect(readCalendarInviteSpec('string')).toBeUndefined();
    expect(readCalendarInviteSpec(42)).toBeUndefined();
  });

  it('rejects a missing meetingId', () => {
    expect(readCalendarInviteSpec({ ...VALID_USER_SPEC, meetingId: undefined })).toBeUndefined();
  });

  it('rejects an empty meetingId', () => {
    expect(readCalendarInviteSpec({ ...VALID_USER_SPEC, meetingId: '' })).toBeUndefined();
  });

  it('rejects a missing calendarEventId', () => {
    expect(
      readCalendarInviteSpec({ ...VALID_USER_SPEC, calendarEventId: undefined })
    ).toBeUndefined();
  });

  it('rejects an unknown party', () => {
    expect(readCalendarInviteSpec({ ...VALID_USER_SPEC, party: 'agency' })).toBeUndefined();
  });

  it('rejects a wrong method — REQUEST is the only method this ticket ships', () => {
    expect(readCalendarInviteSpec({ ...VALID_USER_SPEC, method: 'CANCEL' })).toBeUndefined();
    expect(readCalendarInviteSpec({ ...VALID_USER_SPEC, method: 'REPLY' })).toBeUndefined();
  });

  it('rejects an unknown transition', () => {
    expect(readCalendarInviteSpec({ ...VALID_USER_SPEC, transition: 'cancelled' })).toBeUndefined();
  });

  it('rejects an unknown recipient kind', () => {
    expect(
      readCalendarInviteSpec({ ...VALID_USER_SPEC, recipient: { kind: 'admin', id: 'x' } })
    ).toBeUndefined();
  });

  it('rejects a recipient missing its id field', () => {
    expect(
      readCalendarInviteSpec({ ...VALID_USER_SPEC, recipient: { kind: 'user' } })
    ).toBeUndefined();
    expect(
      readCalendarInviteSpec({ ...VALID_GUEST_SPEC, recipient: { kind: 'guest' } })
    ).toBeUndefined();
  });

  it('rejects an extra-kind shape carrying BOTH a userId and a guestId', () => {
    expect(
      readCalendarInviteSpec({
        ...VALID_USER_SPEC,
        recipient: { kind: 'user', userId: 'user-1', guestId: 'guest-1' },
      })
    ).toBeUndefined();
  });

  it('rejects a recipient that is not an object', () => {
    expect(readCalendarInviteSpec({ ...VALID_USER_SPEC, recipient: 'user-1' })).toBeUndefined();
    expect(readCalendarInviteSpec({ ...VALID_USER_SPEC, recipient: null })).toBeUndefined();
  });

  it('accepts a null contextType (F5 — genuinely unresolvable)', () => {
    expect(readCalendarInviteSpec({ ...VALID_USER_SPEC, contextType: null })).toEqual({
      ...VALID_USER_SPEC,
      contextType: null,
    });
  });

  it('accepts every closed bookable context type', () => {
    for (const contextType of [
      'case',
      'project_kickoff',
      'package_session',
      'project_discovery',
      'request_interaction',
    ]) {
      expect(readCalendarInviteSpec({ ...VALID_USER_SPEC, contextType })?.contextType).toBe(
        contextType
      );
    }
  });

  it('rejects a contextType outside the closed bookable set (F5)', () => {
    expect(readCalendarInviteSpec({ ...VALID_USER_SPEC, contextType: 'admin' })).toBeUndefined();
    expect(readCalendarInviteSpec({ ...VALID_USER_SPEC, contextType: '' })).toBeUndefined();
    expect(readCalendarInviteSpec({ ...VALID_USER_SPEC, contextType: undefined })).toBeUndefined();
  });
});

describe('calendarInviteRecipientId', () => {
  it('reads the userId for a user recipient', () => {
    expect(calendarInviteRecipientId({ kind: 'user', userId: 'user-1' })).toBe('user-1');
  });

  it('reads the guestId for a guest recipient', () => {
    expect(calendarInviteRecipientId({ kind: 'guest', guestId: 'guest-1' })).toBe('guest-1');
  });
});

describe('calendarInviteRecipientKey', () => {
  it('formats a user recipient as user:<id>', () => {
    expect(calendarInviteRecipientKey({ kind: 'user', userId: 'user-1' })).toBe('user:user-1');
  });

  it('formats a guest recipient as guest:<id>', () => {
    expect(calendarInviteRecipientKey({ kind: 'guest', guestId: 'guest-1' })).toBe('guest:guest-1');
  });
});
