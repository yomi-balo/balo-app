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
    [
      'cancelled',
      {
        transition: 'cancelled',
        cancelAuditId: 'audit-cancel-1',
        party: 'expert',
        recipient: USER_A,
      },
    ],
    ['guest_removed', { transition: 'guest_removed', guestId: 'guest-1' }],
  ])('%s: buildJobId never throws and the resulting id has no colon', (_label, write) => {
    const correlationId = calendarInviteCorrelationId(write);
    let jobId = '';
    expect(() => {
      jobId = buildJobId('meeting.calendar_invite', correlationId);
    }).not.toThrow();
    expect(jobId).not.toContain(':');
  });
});

// ── BAL-476 — the two withdrawal arms ─────────────────────────────────────────────────────

describe('calendarInviteCorrelationId — the withdrawal arms', () => {
  it('cancelled: the exact literal, keyed on the audit id, the party AND the recipient', () => {
    expect(
      calendarInviteCorrelationId({
        transition: 'cancelled',
        cancelAuditId: 'audit-cancel-1',
        party: 'expert',
        recipient: USER_A,
      })
    ).toBe('cancelled:audit-cancel-1:expert:user:user-a');
  });

  it('cancelled: differs for two recipients, and for the two parties, of ONE cancel', () => {
    const base = { transition: 'cancelled', cancelAuditId: 'audit-cancel-1' } as const;
    const ids = [
      calendarInviteCorrelationId({ ...base, party: 'client', recipient: USER_A }),
      calendarInviteCorrelationId({ ...base, party: 'client', recipient: USER_B }),
      calendarInviteCorrelationId({ ...base, party: 'expert', recipient: USER_A }),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(3);
  });

  it('guest_removed: the exact literal', () => {
    expect(calendarInviteCorrelationId({ transition: 'guest_removed', guestId: 'guest-1' })).toBe(
      'guest_removed:guest-1'
    );
  });

  /**
   * ⚠⚠ THE ONE THAT MATTERS. Same guest row id, two different writes — an ADD and a REMOVAL. If
   * they shared a key the removal job would be silently swallowed inside BullMQ's 100-completed
   * dedup window, and the person would keep a calendar entry for a call they are off.
   */
  it('⚠ guest_removed:<id> is NOT guest_added:<id> for the same guest row', () => {
    const guestId = 'guest-1';
    const added = calendarInviteCorrelationId({ transition: 'guest_added', guestId });
    const removed = calendarInviteCorrelationId({ transition: 'guest_removed', guestId });
    expect(added).toBe('guest_added:guest-1');
    expect(removed).toBe('guest_removed:guest-1');
    expect(removed).not.toBe(added);
  });

  /**
   * ⚠ PER-WRITE, NOT PER-STATE. `meeting_calendar_events.id` is stable across reschedules and
   * guest-adds; the audit row id is minted once per successful cancel. Two cancels of two
   * different meetings (or, structurally, any two cancel WRITES) never collide.
   */
  it('⚠ cancelled is keyed on the AUDIT id, so two cancels never share a key', () => {
    const a = calendarInviteCorrelationId({
      transition: 'cancelled',
      cancelAuditId: 'audit-1',
      party: 'client',
      recipient: USER_A,
    });
    const b = calendarInviteCorrelationId({
      transition: 'cancelled',
      cancelAuditId: 'audit-2',
      party: 'client',
      recipient: USER_A,
    });
    expect(a).not.toBe(b);
  });
});
