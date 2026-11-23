import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScheduledNotification } from '@balo/db';

const { mockMarkFailed, mockRaiseAdminAlert, mockLogger } = vi.hoisted(() => ({
  mockMarkFailed: vi.fn(),
  mockRaiseAdminAlert: vi.fn(),
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@balo/db', () => ({
  scheduledNotificationsRepository: { markFailed: mockMarkFailed },
}));
vi.mock('@balo/shared/logging', () => ({ createLogger: () => mockLogger }));
vi.mock('../../services/admin-alerts/raise.js', () => ({ raiseAdminAlert: mockRaiseAdminAlert }));

import { failScheduledNotification } from './fail-scheduled-notification.js';

const DUE = new Date('2026-08-05T11:59:00.000Z');

function row(overrides: Partial<ScheduledNotification> = {}): ScheduledNotification {
  return {
    id: 'row-1',
    dedupeKey: 'seq:proposal_review:r-1',
    event: 'project.proposal_review_reminder',
    payload: { correlationId: 'c-1' },
    scheduledFor: DUE,
    status: 'claimed',
    mode: 'first_wins',
    recheck: null,
    attempts: 3,
    claimedAt: null,
    publishedAt: null,
    cancelledAt: null,
    skipReason: null,
    lastError: null,
    createdAt: DUE,
    updatedAt: DUE,
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMarkFailed.mockResolvedValue(undefined);
  mockRaiseAdminAlert.mockResolvedValue(undefined);
});

describe('failScheduledNotification', () => {
  it('marks the row failed, then raises exactly one alert keyed on the row id', async () => {
    const order: string[] = [];
    mockMarkFailed.mockImplementation(async () => {
      order.push('mark');
    });
    mockRaiseAdminAlert.mockImplementation(async () => {
      order.push('raise');
    });

    const outcome = await failScheduledNotification(row(), 'attempts_exhausted', 'Spent');

    expect(outcome).toBe('failed');
    expect(order).toEqual(['mark', 'raise']);
    expect(mockMarkFailed).toHaveBeenCalledWith('row-1', 'Spent');
    expect(mockRaiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(mockRaiseAdminAlert).toHaveBeenCalledWith({
      kind: 'scheduled_notification.failed',
      entityType: 'scheduled_notification',
      entityId: 'row-1',
      detail: {
        title: 'A scheduled notification could not be sent',
        entityLabel: 'project.proposal_review_reminder',
        evidence: `It was due ${DUE.toISOString()} and was abandoned after 3 attempt(s).`,
        facts: [
          ['Event', 'project.proposal_review_reminder'],
          ['Due', DUE.toISOString()],
          ['Attempts', '3'],
          ['Reason', 'Spent'],
          ['Key', 'seq:proposal_review:r-1'],
        ],
      },
    });
  });

  it('carries no money on the alert', async () => {
    await failScheduledNotification(row(), 'attempts_exhausted', 'Spent');

    const [input] = mockRaiseAdminAlert.mock.calls[0] as [{ detail: Record<string, unknown> }];
    expect(input.detail).not.toHaveProperty('money');
  });

  it.each([
    ['attempts_exhausted', 'Scheduled notification abandoned — attempts exhausted'],
    ['unknown_recheck', 'Scheduled notification recheck is not registered — failing closed'],
    [
      'missing_correlation_id',
      'Scheduled notification payload has no correlationId — failing closed',
    ],
  ] as const)('logs the %s message with the row and the extra context', async (cause, message) => {
    await failScheduledNotification(row(), cause, 'why', { recheck: 'gone' });

    expect(mockLogger.error).toHaveBeenCalledWith(
      {
        id: 'row-1',
        key: 'seq:proposal_review:r-1',
        event: 'project.proposal_review_reminder',
        attempts: 3,
        recheck: 'gone',
      },
      message
    );
  });

  it('still returns failed, with the row marked once, when building the alert detail throws', async () => {
    const outcome = await failScheduledNotification(
      row({ scheduledFor: new Date(Number.NaN) }),
      'attempts_exhausted',
      'Spent'
    );

    expect(outcome).toBe('failed');
    expect(mockMarkFailed).toHaveBeenCalledTimes(1);
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'row-1', key: 'seq:proposal_review:r-1' }),
      'Scheduled notification admin alert could not be raised'
    );
  });

  it('still returns failed when raising the alert rejects', async () => {
    mockRaiseAdminAlert.mockRejectedValue(new Error('queue down'));

    const outcome = await failScheduledNotification(row(), 'attempts_exhausted', 'Spent');

    expect(outcome).toBe('failed');
    expect(mockMarkFailed).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenLastCalledWith(
      expect.objectContaining({ error: 'queue down' }),
      'Scheduled notification admin alert could not be raised'
    );
  });

  it('raises nothing and propagates when the mark throws', async () => {
    mockMarkFailed.mockRejectedValue(new Error('db down'));

    await expect(failScheduledNotification(row(), 'unknown_recheck', 'why')).rejects.toThrow(
      'db down'
    );

    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});
