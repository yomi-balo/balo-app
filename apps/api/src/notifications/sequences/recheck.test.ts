import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ScheduledNotification } from '@balo/db';

const { mockCount, mockDecided, mockEvaluate, mockResolve, mockLogger } = vi.hoisted(() => ({
  mockCount: vi.fn(),
  mockDecided: vi.fn(),
  mockEvaluate: vi.fn(),
  mockResolve: vi.fn(),
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@balo/db', () => ({
  scheduledNotificationsRepository: { countRecentSequenceSends: mockCount },
}));
vi.mock('@balo/shared/logging', () => ({ createLogger: () => mockLogger }));
vi.mock('../scheduling/scheduled-key-decided.js', () => ({ isScheduledKeyDecided: mockDecided }));
vi.mock('./registry.js', async () => {
  const sequence = {
    id: 'proposal_review',
    event: 'project.proposal_review_reminder',
    exemptFromDailyLimit: false,
    evaluate: mockEvaluate,
    resolveRecipients: mockResolve,
  };
  return {
    findReminderSequence: (id: unknown) => (id === 'proposal_review' ? sequence : undefined),
    limitedSequencePrefixes: () => ['seq:proposal_review:'],
    __sequence: sequence,
  };
});

import { reminderSequenceRecheck, REARMABLE_REMINDER_SKIP_REASONS } from './recheck.js';
import * as registry from './registry.js';

const REQ = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-05T09:00:00.000Z');
const ANCHOR = new Date('2026-11-02T00:00:00.000Z');

function row(overrides: Partial<ScheduledNotification> = {}): ScheduledNotification {
  return {
    id: 'row-1',
    dedupeKey: `seq:proposal_review:${REQ}:day_2:${USER}:2026-11-02T00:00:00.000Z`,
    event: 'project.proposal_review_reminder',
    payload: {
      correlationId: 'c-1',
      sequenceId: 'proposal_review',
      step: 'day_2',
      entityId: REQ,
      anchorIso: ANCHOR.toISOString(),
      recipientUserId: USER,
      projectRequestId: REQ,
      title: 'Old title',
      awaitingCount: 1,
    },
    scheduledFor: NOW,
    status: 'claimed',
    mode: 'first_wins',
    recheck: 'reminder_sequence',
    attempts: 1,
    claimedAt: NOW,
    publishedAt: null,
    cancelledAt: null,
    skipReason: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

const entity = {
  entityId: REQ,
  anchor: ANCHOR,
  companyId: 'co-1',
  candidateUserIds: [USER],
  fresh: { awaitingCount: 3, title: 'New title' },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockDecided.mockResolvedValue(false);
  mockEvaluate.mockResolvedValue(entity);
  mockResolve.mockResolvedValue([USER]);
  mockCount.mockResolvedValue(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reminderSequenceRecheck', () => {
  it('publishes the stored payload refreshed with the live fields', async () => {
    const stored = row();
    const result = await reminderSequenceRecheck(stored);
    expect(result).toEqual({
      publish: true,
      payload: { ...stored.payload, awaitingCount: 3, title: 'New title' },
    });
  });

  it('skips as no_longer_waiting when the entity no longer waits', async () => {
    mockEvaluate.mockResolvedValue(null);
    expect(await reminderSequenceRecheck(row())).toEqual({
      publish: false,
      reason: 'no_longer_waiting',
    });
    expect(mockCount).not.toHaveBeenCalled();
  });

  it('skips as anchor_moved when the oldest awaiting proposal changed', async () => {
    mockEvaluate.mockResolvedValue({ ...entity, anchor: new Date('2026-11-03T00:00:00.000Z') });
    expect(await reminderSequenceRecheck(row())).toEqual({
      publish: false,
      reason: 'anchor_moved',
    });
  });

  it('skips as recipient_gone when the recipient may no longer receive it', async () => {
    mockResolve.mockResolvedValue([]);
    expect(await reminderSequenceRecheck(row())).toEqual({
      publish: false,
      reason: 'recipient_gone',
    });
  });

  it('skips as already_decided when the key was decided by another row', async () => {
    mockDecided.mockResolvedValue(true);
    expect(await reminderSequenceRecheck(row())).toEqual({
      publish: false,
      reason: 'already_decided',
    });
    expect(mockDecided).toHaveBeenCalledWith(
      row().dedupeKey,
      REARMABLE_REMINDER_SKIP_REASONS,
      'row-1'
    );
    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  it('can re-arm only after anchor_moved', () => {
    expect(REARMABLE_REMINDER_SKIP_REASONS).toEqual(['anchor_moved']);
  });

  describe('daily limit', () => {
    it('counts the recipient over the last 24 hours, with the asking row, and skips at two', async () => {
      mockCount.mockResolvedValue(2);
      const asking = row();
      expect(await reminderSequenceRecheck(asking)).toEqual({
        publish: false,
        reason: 'over_daily_limit',
      });
      expect(mockCount).toHaveBeenCalledWith({
        recipientUserId: USER,
        dedupeKeyPrefixes: ['seq:proposal_review:'],
        since: new Date(NOW.getTime() - 86_400_000),
        asking: { id: 'row-1', scheduledFor: asking.scheduledFor },
      });
    });

    it('publishes at one send in the window', async () => {
      mockCount.mockResolvedValue(1);
      expect((await reminderSequenceRecheck(row())).publish).toBe(true);
    });

    it('never reads the count for an exempt sequence', async () => {
      const sequence = (registry as unknown as { __sequence: { exemptFromDailyLimit: boolean } })
        .__sequence;
      sequence.exemptFromDailyLimit = true;
      try {
        expect((await reminderSequenceRecheck(row())).publish).toBe(true);
        expect(mockCount).not.toHaveBeenCalled();
      } finally {
        sequence.exemptFromDailyLimit = false;
      }
    });

    it('reports anchor_moved, not over_daily_limit, when both hold', async () => {
      mockCount.mockResolvedValue(2);
      mockEvaluate.mockResolvedValue({ ...entity, anchor: new Date('2026-11-03T00:00:00.000Z') });
      expect(await reminderSequenceRecheck(row())).toEqual({
        publish: false,
        reason: 'anchor_moved',
      });
    });

    it('reports recipient_gone, not over_daily_limit, when both hold', async () => {
      mockCount.mockResolvedValue(2);
      mockResolve.mockResolvedValue([]);
      expect(await reminderSequenceRecheck(row())).toEqual({
        publish: false,
        reason: 'recipient_gone',
      });
    });

    it('checks the limit last, so a reminder no longer owed is never over the limit', async () => {
      mockCount.mockResolvedValue(5);
      mockEvaluate.mockResolvedValue(null);
      expect(await reminderSequenceRecheck(row())).toEqual({
        publish: false,
        reason: 'no_longer_waiting',
      });
    });
  });

  describe('malformed payloads', () => {
    it.each([
      ['an unknown sequence', { sequenceId: 'nope' }],
      ['an unknown step', { step: 'day_99' }],
      ['a missing entity id', { entityId: undefined }],
      ['a missing anchor', { anchorIso: undefined }],
      ['a missing recipient', { recipientUserId: undefined }],
      ['a blank correlation id', { correlationId: '' }],
      ['an entity id that is not a uuid', { entityId: 'req-1', projectRequestId: 'req-1' }],
      ['a recipient id that is not a uuid', { recipientUserId: 'user-1' }],
      ['a project request id that is not a uuid', { projectRequestId: 'req-1' }],
      ['a project request id that differs from the entity id', { projectRequestId: USER }],
      ['an anchor that is not a date', { anchorIso: 'soon' }],
      ['an anchor that does not round-trip', { anchorIso: '2026-11-02' }],
    ])('skips %s as malformed_payload', async (_label, patch) => {
      const base = row();
      const result = await reminderSequenceRecheck(row({ payload: { ...base.payload, ...patch } }));
      expect(result).toEqual({ publish: false, reason: 'malformed_payload' });
      expect(mockEvaluate).not.toHaveBeenCalled();
    });

    it('skips a row whose event does not match the sequence', async () => {
      expect(await reminderSequenceRecheck(row({ event: 'user.welcome' }))).toEqual({
        publish: false,
        reason: 'malformed_payload',
      });
    });
  });

  it('lets a repository throw propagate so the row is retried', async () => {
    mockEvaluate.mockRejectedValue(new Error('db blip'));
    await expect(reminderSequenceRecheck(row())).rejects.toThrow('db blip');
  });
});
