import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────
const { mockSchedule, mockCancel } = vi.hoisted(() => ({
  mockSchedule: vi.fn(),
  mockCancel: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  scheduledNotificationsRepository: {
    schedule: mockSchedule,
    cancel: mockCancel,
  },
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

import {
  scheduleNotification,
  cancelScheduledNotification,
  InvalidScheduleOptionsError,
} from './schedule.js';

const NOW = new Date('2026-08-05T12:00:00.000Z');
const HOUR_MS = 3_600_000;

/** A real payload shape from the catalog — `user.welcome` is the smallest one. */
const WELCOME_PAYLOAD = {
  correlationId: 'user-1',
  userId: 'user-1',
  role: 'client',
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockSchedule.mockResolvedValue({ outcome: 'scheduled', row: { id: 'row-1' } });
  mockCancel.mockResolvedValue(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduleNotification — fire-time resolution', () => {
  it('uses `at` verbatim', async () => {
    const at = new Date('2026-09-01T09:30:00.000Z');

    await scheduleNotification('user.welcome', WELCOME_PAYLOAD, { key: 'k-1', at });

    expect(mockSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledFor: at }),
      undefined
    );
  });

  it('resolves `delayMs` against the current clock', async () => {
    await scheduleNotification('user.welcome', WELCOME_PAYLOAD, {
      key: 'k-2',
      delayMs: 5 * HOUR_MS,
    });

    const [input] = mockSchedule.mock.calls[0] ?? [];
    expect(input.scheduledFor.getTime()).toBe(NOW.getTime() + 5 * HOUR_MS);
  });

  it('accepts delayMs of 0 (fire on the next tick)', async () => {
    await scheduleNotification('user.welcome', WELCOME_PAYLOAD, { key: 'k-3', delayMs: 0 });

    const [input] = mockSchedule.mock.calls[0] ?? [];
    expect(input.scheduledFor.getTime()).toBe(NOW.getTime());
  });

  it('ALLOWS a fire time in the past — the next tick fires it; it is not clamped', async () => {
    const past = new Date(NOW.getTime() - 30 * HOUR_MS);

    await scheduleNotification('user.welcome', WELCOME_PAYLOAD, { key: 'k-4', at: past });

    // Clamping to "now" or rejecting would both be worse: a schedule computed from a past
    // anchor, or written during a backlog, is genuinely owed.
    const [input] = mockSchedule.mock.calls[0] ?? [];
    expect(input.scheduledFor).toBe(past);
  });
});

describe('scheduleNotification — option validation (programming errors, so they throw)', () => {
  it('rejects NEITHER `at` nor `delayMs`', async () => {
    await expect(
      scheduleNotification('user.welcome', WELCOME_PAYLOAD, { key: 'k' })
    ).rejects.toBeInstanceOf(InvalidScheduleOptionsError);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('rejects BOTH `at` and `delayMs`', async () => {
    await expect(
      scheduleNotification('user.welcome', WELCOME_PAYLOAD, {
        key: 'k',
        at: NOW,
        delayMs: 1000,
      })
    ).rejects.toBeInstanceOf(InvalidScheduleOptionsError);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('rejects an empty or whitespace-only key (the DB CHECK says the same thing)', async () => {
    for (const key of ['', '   ']) {
      await expect(
        scheduleNotification('user.welcome', WELCOME_PAYLOAD, { key, delayMs: 1000 })
      ).rejects.toBeInstanceOf(InvalidScheduleOptionsError);
    }
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('rejects a negative or non-finite `delayMs`', async () => {
    for (const delayMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        scheduleNotification('user.welcome', WELCOME_PAYLOAD, { key: 'k', delayMs })
      ).rejects.toBeInstanceOf(InvalidScheduleOptionsError);
    }
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('rejects an invalid `at` Date', async () => {
    await expect(
      scheduleNotification('user.welcome', WELCOME_PAYLOAD, {
        key: 'k',
        at: new Date('not-a-date'),
      })
    ).rejects.toBeInstanceOf(InvalidScheduleOptionsError);
    expect(mockSchedule).not.toHaveBeenCalled();
  });
});

describe('scheduleNotification — repository contract', () => {
  it('defaults `mode` to first_wins and `recheck` to null', async () => {
    await scheduleNotification('user.welcome', WELCOME_PAYLOAD, { key: 'k-5', delayMs: 1000 });

    expect(mockSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'first_wins', recheck: null }),
      undefined
    );
  });

  it('forwards event, key, payload, mode and recheck', async () => {
    await scheduleNotification('user.welcome', WELCOME_PAYLOAD, {
      key: 'meeting_expert_absent:m-1',
      delayMs: 5 * 60_000,
      mode: 'replace_pending',
      recheck: 'meeting_participant_absent',
    });

    expect(mockSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: 'meeting_expert_absent:m-1',
        event: 'user.welcome',
        payload: WELCOME_PAYLOAD,
        mode: 'replace_pending',
        recheck: 'meeting_participant_absent',
      }),
      undefined
    );
  });

  it('FORWARDS the transaction executor — the API-side outbox (ADR R8)', async () => {
    const tx = { marker: 'tx' } as never;

    await scheduleNotification('user.welcome', WELCOME_PAYLOAD, { key: 'k-6', delayMs: 1 }, tx);

    expect(mockSchedule).toHaveBeenCalledWith(expect.anything(), tx);
  });

  it('returns the repository outcome unchanged', async () => {
    mockSchedule.mockResolvedValueOnce({ outcome: 'already_pending', row: { id: 'row-9' } });

    const result = await scheduleNotification('user.welcome', WELCOME_PAYLOAD, {
      key: 'k-7',
      delayMs: 1,
    });

    expect(result).toEqual({ outcome: 'already_pending' });
  });
});

describe('cancelScheduledNotification', () => {
  it('returns the number of rows cancelled', async () => {
    mockCancel.mockResolvedValueOnce(1);

    await expect(cancelScheduledNotification('k-8')).resolves.toBe(1);
    expect(mockCancel).toHaveBeenCalledWith('k-8', undefined);
  });

  it('ZERO IS NORMAL, not an error — nothing was scheduled, or it already fired', async () => {
    mockCancel.mockResolvedValueOnce(0);

    await expect(cancelScheduledNotification('never-scheduled')).resolves.toBe(0);
  });

  it('forwards the transaction executor', async () => {
    const tx = { marker: 'tx' } as never;

    await cancelScheduledNotification('k-9', tx);

    expect(mockCancel).toHaveBeenCalledWith('k-9', tx);
  });
});
