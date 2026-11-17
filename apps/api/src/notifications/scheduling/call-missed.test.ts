import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScheduledNotification } from '@balo/db';

const { mockSummarize, mockScheduleNotification, mockWarn } = vi.hoisted(() => ({
  mockSummarize: vi.fn(),
  mockScheduleNotification: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  meetingRingsRepository: {
    summarizeMissedCallWindow: (...args: unknown[]) => mockSummarize(...args),
  },
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockWarn, error: vi.fn() }),
}));

vi.mock('./schedule.js', () => ({
  scheduleNotification: (...args: unknown[]) => mockScheduleNotification(...args),
}));

import {
  callMissedEmailRecheck,
  callMissedKey,
  scheduleMissedCallEmailFromContext,
  CALL_MISSED_EMAIL_DELAY_MS,
  CALL_MISSED_EMAIL_RECHECK,
} from './call-missed.js';
import { SCHEDULED_RECHECKS } from './rechecks.js';

const STARTED_AT = '2026-11-17T10:00:00.000Z';

const ringPayload = {
  correlationId: 'ring-1',
  ringId: 'ring-1',
  engagementId: 'eng-1',
  callerUserId: 'caller-1',
  calleeUserId: 'callee-1',
  callerSide: 'client',
  startedAt: STARTED_AT,
};

function row(payload: Record<string, unknown> = {}): ScheduledNotification {
  return {
    payload: {
      correlationId: 'occurrence-1',
      callerUserId: 'caller-1',
      calleeUserId: 'callee-1',
      callerSide: 'client',
      engagementId: 'eng-1',
      firstMissedAtIso: STARTED_AT,
      lastMissedAtIso: STARTED_AT,
      missedCount: 1,
      ...payload,
    },
  } as unknown as ScheduledNotification;
}

function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    unansweredCount: 1,
    latestUnanswered: {
      engagementId: 'eng-1',
      callerSide: 'client',
      createdAt: new Date(STARTED_AT),
    },
    connectedSince: false,
    calleeDeclinedSince: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockScheduleNotification.mockResolvedValue({ outcome: 'scheduled' });
});

describe('callMissedKey', () => {
  it('names the (caller, callee) pair, in that order', () => {
    expect(callMissedKey('caller-1', 'callee-1')).toBe('call-missed:caller-1:callee-1');
    expect(callMissedKey('callee-1', 'caller-1')).not.toBe(callMissedKey('caller-1', 'callee-1'));
  });
});

describe('registration', () => {
  it('registers the guard under its recheck name', () => {
    expect(SCHEDULED_RECHECKS[CALL_MISSED_EMAIL_RECHECK]).toBe(callMissedEmailRecheck);
    expect(CALL_MISSED_EMAIL_RECHECK).toBe('call_missed_email');
  });
});

describe('scheduleMissedCallEmailFromContext', () => {
  it('schedules one first_wins promise, ten minutes out, anchored on the ring start', async () => {
    await scheduleMissedCallEmailFromContext({
      event: 'call.no_answer',
      payload: ringPayload,
      data: {},
    });

    expect(mockScheduleNotification).toHaveBeenCalledOnce();
    const [event, payload, options] = mockScheduleNotification.mock.calls[0] ?? [];
    expect(event).toBe('call.missed_email_due');
    expect(payload).toEqual({
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      callerUserId: 'caller-1',
      calleeUserId: 'callee-1',
      callerSide: 'client',
      engagementId: 'eng-1',
      firstMissedAtIso: STARTED_AT,
      lastMissedAtIso: STARTED_AT,
      missedCount: 1,
    });
    expect(options).toEqual({
      key: 'call-missed:caller-1:callee-1',
      delayMs: 600_000,
      mode: 'first_wins',
      recheck: 'call_missed_email',
    });
    expect(CALL_MISSED_EMAIL_DELAY_MS).toBe(600_000);
  });

  it('mints a fresh correlationId on every schedule', async () => {
    const ctx = { event: 'call.no_answer', payload: ringPayload, data: {} };
    await scheduleMissedCallEmailFromContext(ctx);
    await scheduleMissedCallEmailFromContext(ctx);

    const [first, second] = mockScheduleNotification.mock.calls.map(
      (call) => (call[1] as { correlationId: string }).correlationId
    );
    expect(first).not.toBe(second);
  });

  it.each(['callerUserId', 'calleeUserId', 'engagementId', 'startedAt', 'callerSide'])(
    'warns and schedules nothing when %s is missing',
    async (field) => {
      await scheduleMissedCallEmailFromContext({
        event: 'call.no_answer',
        payload: { ...ringPayload, [field]: undefined },
        data: {},
      });

      expect(mockScheduleNotification).not.toHaveBeenCalled();
      expect(mockWarn).toHaveBeenCalledOnce();
    }
  );

  it('rejects a callerSide outside the closed enum', async () => {
    await scheduleMissedCallEmailFromContext({
      event: 'call.no_answer',
      payload: { ...ringPayload, callerSide: 'admin' },
      data: {},
    });

    expect(mockScheduleNotification).not.toHaveBeenCalled();
  });
});

describe('callMissedEmailRecheck', () => {
  it('reads the window from the first missed ring, for the stored pair', async () => {
    mockSummarize.mockResolvedValue(summary());

    await callMissedEmailRecheck(row());

    expect(mockSummarize).toHaveBeenCalledWith({
      callerUserId: 'caller-1',
      calleeUserId: 'callee-1',
      since: new Date(STARTED_AT),
    });
  });

  it('publishes the live count, latest case, caller side and instant, keeping correlationId', async () => {
    const latest = new Date('2026-11-17T10:04:00.000Z');
    mockSummarize.mockResolvedValue(
      summary({
        unansweredCount: 2,
        latestUnanswered: { engagementId: 'eng-2', callerSide: 'expert', createdAt: latest },
      })
    );

    await expect(callMissedEmailRecheck(row())).resolves.toEqual({
      publish: true,
      payload: {
        correlationId: 'occurrence-1',
        callerUserId: 'caller-1',
        calleeUserId: 'callee-1',
        callerSide: 'expert',
        engagementId: 'eng-2',
        firstMissedAtIso: STARTED_AT,
        lastMissedAtIso: latest.toISOString(),
        missedCount: 2,
      },
    });
  });

  it('skips when the call connected before the send', async () => {
    mockSummarize.mockResolvedValue(summary({ connectedSince: true }));

    await expect(callMissedEmailRecheck(row())).resolves.toEqual({
      publish: false,
      reason: 'connected_before_send',
    });
  });

  it('skips when the callee chose "Not now"', async () => {
    mockSummarize.mockResolvedValue(summary({ calleeDeclinedSince: true }));

    await expect(callMissedEmailRecheck(row())).resolves.toEqual({
      publish: false,
      reason: 'declined_before_send',
    });
  });

  it('puts a connect ahead of a decline when both are present', async () => {
    mockSummarize.mockResolvedValue(summary({ connectedSince: true, calleeDeclinedSince: true }));

    await expect(callMissedEmailRecheck(row())).resolves.toMatchObject({
      reason: 'connected_before_send',
    });
  });

  it('skips when no unanswered ring is left in the window', async () => {
    mockSummarize.mockResolvedValue(summary({ unansweredCount: 0, latestUnanswered: null }));

    await expect(callMissedEmailRecheck(row())).resolves.toEqual({
      publish: false,
      reason: 'no_missed_ring',
    });
  });

  it.each([
    ['callerUserId', undefined],
    ['calleeUserId', undefined],
    ['firstMissedAtIso', undefined],
    ['firstMissedAtIso', 'not-a-date'],
  ])('is malformed when %s is %s', async (field, value) => {
    await expect(callMissedEmailRecheck(row({ [field]: value }))).resolves.toEqual({
      publish: false,
      reason: 'malformed_payload',
    });
    expect(mockSummarize).not.toHaveBeenCalled();
  });
});
