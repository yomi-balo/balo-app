import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-475 (fix round 1, F9 — R8) — `claimSend`'s CONCURRENT-FAILURE RETRY PASS and both throw
 * paths, unit-tested against a mocked `db` (the mocked-`db` pattern from
 * `meeting-calendar-events.test.ts`). The integration harness (max:1 pool, one transaction)
 * cannot race two connections against each other, so the READ-COMMITTED "refused insert → a
 * concurrently committed `failed` becomes visible → re-claim" loop had no test anywhere that
 * could fail it: `CLAIM_PASSES = 1`, or deleting the `failed` fall-through so it reports
 * `in_flight` instead, both passed CI silently before this file.
 */

const {
  mockValues,
  mockOnConflictDoUpdate,
  mockInsertReturning,
  mockSelectWhere,
  mockSelectLimit,
  mockUpdateSet,
  mockUpdateWhere,
  mockUpdateReturning,
} = vi.hoisted(() => ({
  mockValues: vi.fn(),
  mockOnConflictDoUpdate: vi.fn(),
  mockInsertReturning: vi.fn(),
  mockSelectWhere: vi.fn(),
  mockSelectLimit: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockUpdateReturning: vi.fn(),
}));

vi.mock('../client', () => ({
  db: {
    insert: (..._args: unknown[]) => ({
      values: (...vArgs: unknown[]) => {
        mockValues(...vArgs);
        return {
          onConflictDoUpdate: (...oArgs: unknown[]) => {
            mockOnConflictDoUpdate(...oArgs);
            return { returning: mockInsertReturning };
          },
        };
      },
    }),
    select: (..._args: unknown[]) => ({
      from: (..._fArgs: unknown[]) => ({
        where: (...wArgs: unknown[]) => {
          mockSelectWhere(...wArgs);
          return { limit: mockSelectLimit };
        },
      }),
    }),
    update: (..._args: unknown[]) => ({
      set: (...sArgs: unknown[]) => {
        mockUpdateSet(...sArgs);
        return {
          where: (...wArgs: unknown[]) => {
            mockUpdateWhere(...wArgs);
            return { returning: mockUpdateReturning };
          },
        };
      },
    }),
  },
}));

import { meetingCalendarDeliveriesRepository } from './meeting-calendar-deliveries';

const CLAIM_INPUT = {
  calendarEventId: 'event-1',
  recipient: { kind: 'user', userId: 'user-1' } as const,
  sequence: 0,
  method: 'REQUEST' as const,
  channel: 'email' as const,
  claimToken: 'job-1',
};

const CLAIMED_ROW = { id: 'delivery-1', outcome: 'pending' } as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('meetingCalendarDeliveriesRepository.claimSend', () => {
  it('no existing row: the insert succeeds on the FIRST pass ⇒ claimed, no read', async () => {
    mockInsertReturning.mockResolvedValueOnce([CLAIMED_ROW]);

    const result = await meetingCalendarDeliveriesRepository.claimSend(CLAIM_INPUT);

    expect(result).toEqual({ status: 'claimed', delivery: CLAIMED_ROW });
    expect(mockSelectLimit).not.toHaveBeenCalled();
  });

  it('the existing row is `sent` ⇒ already_sent, no retry', async () => {
    mockInsertReturning.mockResolvedValueOnce([]);
    mockSelectLimit.mockResolvedValueOnce([{ id: 'delivery-1', outcome: 'sent' }]);

    const result = await meetingCalendarDeliveriesRepository.claimSend(CLAIM_INPUT);

    expect(result).toEqual({
      status: 'already_sent',
      delivery: { id: 'delivery-1', outcome: 'sent' },
    });
    expect(mockInsertReturning).toHaveBeenCalledTimes(1);
  });

  it('the existing row is `pending` (a fresh lease held by another job) ⇒ in_flight, no retry', async () => {
    mockInsertReturning.mockResolvedValueOnce([]);
    mockSelectLimit.mockResolvedValueOnce([{ id: 'delivery-1', outcome: 'pending' }]);

    const result = await meetingCalendarDeliveriesRepository.claimSend(CLAIM_INPUT);

    expect(result).toEqual({
      status: 'in_flight',
      delivery: { id: 'delivery-1', outcome: 'pending' },
    });
    expect(mockInsertReturning).toHaveBeenCalledTimes(1);
  });

  /**
   * ⚠ THE MUTATION-SENSITIVE TEST (F9). This requires exactly the second `tryClaim` call to
   * succeed AFTER observing a `failed` row on the first pass — it goes RED if `CLAIM_PASSES` is
   * mutated to `1` (the loop would never attempt a second insert) and RED if the `failed`
   * fall-through is deleted (the second branch would report `in_flight` instead of looping).
   */
  it('refused insert → read observes `failed` (a concurrent markFailed) → SECOND insert succeeds ⇒ claimed', async () => {
    mockInsertReturning
      .mockResolvedValueOnce([]) // pass 1: refused (a concurrent holder currently owns it)
      .mockResolvedValueOnce([CLAIMED_ROW]); // pass 2: succeeds
    mockSelectLimit.mockResolvedValueOnce([{ id: 'delivery-1', outcome: 'failed' }]);

    const result = await meetingCalendarDeliveriesRepository.claimSend(CLAIM_INPUT);

    expect(result).toEqual({ status: 'claimed', delivery: CLAIMED_ROW });
    expect(mockInsertReturning).toHaveBeenCalledTimes(2);
    expect(mockSelectLimit).toHaveBeenCalledTimes(1);
  });

  it('refused insert → the read finds NO live row ⇒ throws (no writer soft-deletes a delivery)', async () => {
    mockInsertReturning.mockResolvedValueOnce([]);
    mockSelectLimit.mockResolvedValueOnce([]);

    await expect(meetingCalendarDeliveriesRepository.claimSend(CLAIM_INPUT)).rejects.toThrow(
      'Calendar send claim refused but no live delivery row exists'
    );
  });

  it('`failed` is observed on BOTH passes (kept racing a live concurrent holder) ⇒ throws', async () => {
    mockInsertReturning.mockResolvedValue([]);
    mockSelectLimit.mockResolvedValue([{ id: 'delivery-1', outcome: 'failed' }]);

    await expect(meetingCalendarDeliveriesRepository.claimSend(CLAIM_INPUT)).rejects.toThrow(
      'kept racing concurrent failures'
    );
    expect(mockInsertReturning).toHaveBeenCalledTimes(2);
  });
});

describe('meetingCalendarDeliveriesRepository.markSent / markFailed', () => {
  it('markSent compare-and-sets on (id, claimToken, pending)', async () => {
    mockUpdateReturning.mockResolvedValueOnce([{ id: 'delivery-1', outcome: 'sent' }]);

    const result = await meetingCalendarDeliveriesRepository.markSent({
      id: 'delivery-1',
      claimToken: 'job-1',
      providerMessageId: 'smtp-msg-1',
    });

    expect(result).toEqual({ id: 'delivery-1', outcome: 'sent' });
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'sent', providerMessageId: 'smtp-msg-1' })
    );
  });

  it('markSent returns undefined when the claim was taken over (compare-and-set matched nothing)', async () => {
    mockUpdateReturning.mockResolvedValueOnce([]);

    const result = await meetingCalendarDeliveriesRepository.markSent({
      id: 'delivery-1',
      claimToken: 'stale-job',
      providerMessageId: null,
    });

    expect(result).toBeUndefined();
  });

  it('markFailed compare-and-sets the class:code failure reason only', async () => {
    mockUpdateReturning.mockResolvedValueOnce([{ id: 'delivery-1', outcome: 'failed' }]);

    const result = await meetingCalendarDeliveriesRepository.markFailed({
      id: 'delivery-1',
      claimToken: 'job-1',
      failureReason: 'Error:EAUTH:535',
    });

    expect(result).toEqual({ id: 'delivery-1', outcome: 'failed' });
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', failureReason: 'Error:EAUTH:535' })
    );
  });
});
