import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ScheduledNotification } from '@balo/db';

const { mockTrack } = vi.hoisted(() => ({ mockTrack: vi.fn() }));

vi.mock('@balo/db', () => ({}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrack,
  REMINDER_SERVER_EVENTS: { SENT: 'reminder_sent', SKIPPED: 'reminder_skipped' },
}));

import { reportReminderOutcome, REMINDER_SYSTEM_DISTINCT_ID } from './analytics.js';

function row(
  payload: Record<string, unknown>,
  recheck: string | null = 'reminder_sequence'
): ScheduledNotification {
  const now = new Date('2026-11-05T09:00:00.000Z');
  return {
    id: 'row-1',
    dedupeKey: 'k',
    event: 'project.proposal_review_reminder',
    payload: { correlationId: 'c-1', ...payload },
    scheduledFor: now,
    status: 'published',
    mode: 'first_wins',
    recheck,
    attempts: 1,
    claimedAt: now,
    publishedAt: now,
    cancelledAt: null,
    skipReason: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

const GOOD = { sequenceId: 'proposal_review', step: 'day_5', recipientUserId: 'user-1' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reportReminderOutcome', () => {
  it('emits reminder_sent with the registry channel and audience', () => {
    reportReminderOutcome(row(GOOD), { kind: 'published' });
    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith('reminder_sent', {
      sequence: 'proposal_review',
      step: 'day_5',
      channel: 'email',
      audience: 'client',
      distinct_id: 'user-1',
    });
  });

  it('reports an invitation step as an email to the expert', () => {
    reportReminderOutcome(
      row({ sequenceId: 'invitation', step: 'day_1', recipientUserId: 'user-2' }),
      { kind: 'published' }
    );
    expect(mockTrack).toHaveBeenCalledWith('reminder_sent', {
      sequence: 'invitation',
      step: 'day_1',
      channel: 'email',
      audience: 'expert',
      distinct_id: 'user-2',
    });
  });

  it('emits reminder_skipped with the reason', () => {
    reportReminderOutcome(row(GOOD), { kind: 'skipped', reason: 'anchor_moved' });
    expect(mockTrack).toHaveBeenCalledWith('reminder_skipped', {
      sequence: 'proposal_review',
      step: 'day_5',
      reason: 'anchor_moved',
      distinct_id: 'user-1',
    });
  });

  it('uses the system distinct id when the payload names no recipient', () => {
    reportReminderOutcome(row({ sequenceId: 'proposal_review', step: 'day_5' }), {
      kind: 'skipped',
      reason: 'malformed_payload',
    });
    expect(mockTrack).toHaveBeenCalledWith(
      'reminder_skipped',
      expect.objectContaining({ distinct_id: REMINDER_SYSTEM_DISTINCT_ID })
    );
  });

  it('reports a malformed payload with placeholder sequence and step', () => {
    reportReminderOutcome(row({}), { kind: 'skipped', reason: 'malformed_payload' });
    expect(mockTrack).toHaveBeenCalledWith('reminder_skipped', {
      sequence: 'unknown',
      step: 'unknown',
      reason: 'malformed_payload',
      distinct_id: REMINDER_SYSTEM_DISTINCT_ID,
    });
  });

  it('does not report a send for a sequence this build does not know', () => {
    reportReminderOutcome(row({ ...GOOD, sequenceId: 'nope' }), { kind: 'published' });
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it.each([null, 'conversation_unread'])('is a no-op for a row with recheck %s', (recheck) => {
    reportReminderOutcome(row(GOOD, recheck), { kind: 'published' });
    reportReminderOutcome(row(GOOD, recheck), { kind: 'skipped', reason: 'x' });
    expect(mockTrack).not.toHaveBeenCalled();
  });
});
