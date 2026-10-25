import { describe, expect, it } from 'vitest';
import {
  isUpcomingContextMeeting,
  UPCOMING_CALL_CAP,
  UPCOMING_CALL_CONTEXT_TYPES,
  type UpcomingContextMeetingLike,
} from './index';

const NOW = Date.parse('2026-08-25T00:00:00.000Z');
const MIN = 60_000;

function meeting(overrides: Partial<UpcomingContextMeetingLike> = {}): UpcomingContextMeetingLike {
  return {
    status: 'scheduled',
    scheduledEnd: new Date('2026-08-26T04:30:00.000Z'),
    ...overrides,
  };
}

describe('UPCOMING_CALL_CONTEXT_TYPES', () => {
  it('names the pre-kickoff and post-kickoff call contexts, in that order', () => {
    expect(UPCOMING_CALL_CONTEXT_TYPES).toEqual(['request_interaction', 'project_call']);
  });
});

describe('UPCOMING_CALL_CAP', () => {
  it('is 3 calls per thread', () => {
    expect(UPCOMING_CALL_CAP).toBe(3);
  });
});

describe('isUpcomingContextMeeting', () => {
  it.each(['scheduled', 'waiting_for_participants', 'in_progress'] as const)(
    'counts a %s meeting whose window is still ahead',
    (status) => {
      expect(isUpcomingContextMeeting(meeting({ status }), NOW)).toBe(true);
    }
  );

  it('does not count an ENDED meeting, even when its window is somehow in the future', () => {
    expect(isUpcomingContextMeeting(meeting({ status: 'ended' }), NOW)).toBe(false);
  });

  it('does not count a SCHEDULED meeting whose window has passed — nobody ever joined it', () => {
    const past = meeting({ scheduledEnd: new Date(NOW - 30 * MIN) });
    expect(isUpcomingContextMeeting(past, NOW)).toBe(false);
  });

  it('retires a scheduled meeting at the instant its window closes (strictly after now)', () => {
    expect(isUpcomingContextMeeting(meeting({ scheduledEnd: new Date(NOW) }), NOW)).toBe(false);
    expect(isUpcomingContextMeeting(meeting({ scheduledEnd: new Date(NOW + 1) }), NOW)).toBe(true);
  });

  /**
   * A call that RUNS PAST its scheduled end stays `in_progress` — `MEETING_TRANSITIONS` only
   * lets that status move to `ended`. Judging it by `scheduledEnd` would drop it while the
   * parties are still in the room, and the cap would let another call be booked over it.
   */
  it.each(['in_progress', 'waiting_for_participants'] as const)(
    'keeps counting a LIVE %s call that has overrun its scheduled end',
    (status) => {
      const overrun = meeting({ status, scheduledEnd: new Date(NOW - 30 * MIN) });
      expect(isUpcomingContextMeeting(overrun, NOW)).toBe(true);
    }
  );

  it('does not judge `cancelled` — the caller’s read excludes cancelled meetings', () => {
    // The rule only knows `ended` and the clock. A cancelled row that reached it with a future
    // window would count, which is why every caller reads through a `status <> 'cancelled'` filter.
    expect(isUpcomingContextMeeting(meeting({ status: 'cancelled' }), NOW)).toBe(true);
    expect(
      isUpcomingContextMeeting(
        meeting({ status: 'cancelled', scheduledEnd: new Date(NOW - MIN) }),
        NOW
      )
    ).toBe(false);
  });

  it('reads only `status` and `scheduledEnd` — a wider row is accepted structurally', () => {
    const row = {
      meetingId: 'meeting-1',
      scheduledStart: new Date('2026-08-26T04:00:00.000Z'),
      scheduledEnd: new Date('2026-08-26T04:30:00.000Z'),
      status: 'scheduled' as const,
    };
    expect(isUpcomingContextMeeting(row, NOW)).toBe(true);
  });
});
