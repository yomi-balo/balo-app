import { describe, expect, it } from 'vitest';
import {
  RESCHEDULE_PROPOSAL_MAX_OPTIONS,
  deriveRescheduleProposalState,
  rescheduleProposalIsLive,
  resolveProposalAnswerRefusal,
  type RescheduleProposalStatusLabel,
} from './reschedule-proposal';

const BEFORE_DEADLINE = new Date('2026-08-20T10:00:00.000Z');
const DEADLINE = new Date('2026-08-24T10:00:00.000Z');
const AFTER_DEADLINE = new Date('2026-08-30T10:00:00.000Z');

describe('RESCHEDULE_PROPOSAL_MAX_OPTIONS', () => {
  it('is 3', () => {
    expect(RESCHEDULE_PROPOSAL_MAX_OPTIONS).toBe(3);
  });
});

describe('deriveRescheduleProposalState — T-SHARED-2', () => {
  // A table over every terminal status — total, no fallthrough. A terminal status is returned
  // as-is regardless of expiresAt/now: a resolved proposal cannot ALSO read as expired.
  const TERMINAL: readonly Exclude<RescheduleProposalStatusLabel, 'pending'>[] = [
    'accepted',
    'declined',
    'withdrawn',
    'expired',
  ];

  it.each(TERMINAL)('status=%s is returned as-is regardless of expiry', (status) => {
    expect(
      deriveRescheduleProposalState({ status, expiresAt: BEFORE_DEADLINE, now: AFTER_DEADLINE })
    ).toBe(status);
    expect(
      deriveRescheduleProposalState({ status, expiresAt: AFTER_DEADLINE, now: BEFORE_DEADLINE })
    ).toBe(status);
  });

  it('pending, before the deadline → pending', () => {
    expect(
      deriveRescheduleProposalState({
        status: 'pending',
        expiresAt: DEADLINE,
        now: BEFORE_DEADLINE,
      })
    ).toBe('pending');
  });

  it('pending, exactly at the deadline → expired (>, not >=)', () => {
    expect(
      deriveRescheduleProposalState({ status: 'pending', expiresAt: DEADLINE, now: DEADLINE })
    ).toBe('expired');
  });

  it('pending, after the deadline → expired — the stored status never changes underneath this', () => {
    expect(
      deriveRescheduleProposalState({ status: 'pending', expiresAt: DEADLINE, now: AFTER_DEADLINE })
    ).toBe('expired');
  });
});

describe('rescheduleProposalIsLive', () => {
  it('true strictly before expiresAt', () => {
    expect(rescheduleProposalIsLive({ expiresAt: DEADLINE }, BEFORE_DEADLINE)).toBe(true);
  });

  it('false exactly at expiresAt — matches the repository CAS gt(), not gte()', () => {
    expect(rescheduleProposalIsLive({ expiresAt: DEADLINE }, DEADLINE)).toBe(false);
  });

  it('false after expiresAt', () => {
    expect(rescheduleProposalIsLive({ expiresAt: DEADLINE }, AFTER_DEADLINE)).toBe(false);
  });
});

describe('resolveProposalAnswerRefusal — T-SHARED-3', () => {
  const MEETING_START = new Date('2026-09-01T10:00:00.000Z');

  it('answerable: pending, unexpired, not stale → null', () => {
    expect(
      resolveProposalAnswerRefusal({
        status: 'pending',
        expiresAt: DEADLINE,
        originalScheduledStart: MEETING_START,
        meetingScheduledStart: MEETING_START,
        now: BEFORE_DEADLINE,
      })
    ).toBeNull();
  });

  it.each(['accepted', 'declined', 'withdrawn', 'expired'] as const)(
    'status=%s → not_pending, even when the window matches and expiry has not passed',
    (status) => {
      expect(
        resolveProposalAnswerRefusal({
          status,
          expiresAt: AFTER_DEADLINE,
          originalScheduledStart: MEETING_START,
          meetingScheduledStart: MEETING_START,
          now: BEFORE_DEADLINE,
        })
      ).toBe('not_pending');
    }
  );

  it('pending but lapsed → expired', () => {
    expect(
      resolveProposalAnswerRefusal({
        status: 'pending',
        expiresAt: DEADLINE,
        originalScheduledStart: MEETING_START,
        meetingScheduledStart: MEETING_START,
        now: AFTER_DEADLINE,
      })
    ).toBe('expired');
  });

  it('pending, unexpired, but the meeting moved underneath it → stale', () => {
    const movedMeetingStart = new Date('2026-09-05T10:00:00.000Z');
    expect(
      resolveProposalAnswerRefusal({
        status: 'pending',
        expiresAt: DEADLINE,
        originalScheduledStart: MEETING_START,
        meetingScheduledStart: movedMeetingStart,
        now: BEFORE_DEADLINE,
      })
    ).toBe('stale');
  });

  it('not_pending takes precedence over stale — a resolved proposal is never reported stale', () => {
    const movedMeetingStart = new Date('2026-09-05T10:00:00.000Z');
    expect(
      resolveProposalAnswerRefusal({
        status: 'accepted',
        expiresAt: AFTER_DEADLINE,
        originalScheduledStart: MEETING_START,
        meetingScheduledStart: movedMeetingStart,
        now: BEFORE_DEADLINE,
      })
    ).toBe('not_pending');
  });

  it('expired takes precedence over stale — a lapsed proposal is never reported stale', () => {
    const movedMeetingStart = new Date('2026-09-05T10:00:00.000Z');
    expect(
      resolveProposalAnswerRefusal({
        status: 'pending',
        expiresAt: DEADLINE,
        originalScheduledStart: MEETING_START,
        meetingScheduledStart: movedMeetingStart,
        now: AFTER_DEADLINE,
      })
    ).toBe('expired');
  });
});
