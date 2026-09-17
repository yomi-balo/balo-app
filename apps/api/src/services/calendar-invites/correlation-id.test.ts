import { describe, expect, it } from 'vitest';
import { buildJobId } from '../../lib/queue.js';
import type { CalendarInviteRecipient } from '../../notifications/calendar-invite-spec.js';
import { calendarInviteCorrelationId, type CalendarInviteWrite } from './correlation-id.js';

const USER_A: CalendarInviteRecipient = { kind: 'user', userId: 'user-a' };
const USER_B: CalendarInviteRecipient = { kind: 'user', userId: 'user-b' };

describe('calendarInviteCorrelationId', () => {
  it('booked: differs for two recipients of the same write', () => {
    const a = calendarInviteCorrelationId({
      transition: 'booked',
      calendarEventId: 'row-1',
      sequence: 0,
      party: 'client',
      recipient: USER_A,
    });
    const b = calendarInviteCorrelationId({
      transition: 'booked',
      calendarEventId: 'row-1',
      sequence: 0,
      party: 'client',
      recipient: USER_B,
    });
    expect(a).not.toBe(b);
  });

  it('rescheduled: never repeats across an A→B→C→B sequence of distinct audit ids', () => {
    const ids = ['audit-a-b', 'audit-b-c', 'audit-c-b'].map((rescheduleAuditId) =>
      calendarInviteCorrelationId({
        transition: 'rescheduled',
        rescheduleAuditId,
        party: 'client',
        recipient: USER_A,
      })
    );
    expect(new Set(ids).size).toBe(3);
  });

  it('guest_added: keyed only on the guest row id', () => {
    expect(calendarInviteCorrelationId({ transition: 'guest_added', guestId: 'guest-1' })).toBe(
      'guest_added:guest-1'
    );
  });

  it('party is part of the booked/rescheduled key (one user on both sides of a meeting)', () => {
    const client = calendarInviteCorrelationId({
      transition: 'booked',
      calendarEventId: 'row-1',
      sequence: 0,
      party: 'client',
      recipient: USER_A,
    });
    const expert = calendarInviteCorrelationId({
      transition: 'booked',
      calendarEventId: 'row-1',
      sequence: 0,
      party: 'expert',
      recipient: USER_A,
    });
    expect(client).not.toBe(expert);
  });

  it.each<[string, CalendarInviteWrite]>([
    [
      'booked',
      {
        transition: 'booked',
        calendarEventId: 'row-1',
        sequence: 3,
        party: 'expert',
        recipient: USER_A,
      },
    ],
    [
      'rescheduled',
      {
        transition: 'rescheduled',
        rescheduleAuditId: 'audit-1',
        party: 'client',
        recipient: USER_B,
      },
    ],
    ['guest_added', { transition: 'guest_added', guestId: 'guest-1' }],
  ])('%s: buildJobId never throws and the resulting id has no colon', (_label, write) => {
    const correlationId = calendarInviteCorrelationId(write);
    let jobId = '';
    expect(() => {
      jobId = buildJobId('meeting.calendar_invite', correlationId);
    }).not.toThrow();
    expect(jobId).not.toContain(':');
  });
});
