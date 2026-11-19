import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ listFactsForMeetings: vi.fn(), warn: vi.fn() }));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@balo/db', () => ({
  meetingRingsRepository: { listFactsForMeetings: mocks.listFactsForMeetings },
}));

import { meetingOrigin } from './meeting-origin.js';

const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const T0 = new Date('2026-11-16T10:00:00.000Z');

function fact(placement: 'new_meeting' | 'in_place'): Record<string, unknown> {
  return {
    meetingId: MEETING_ID,
    placement,
    status: 'connected',
    createdAt: T0,
    expiresAt: new Date(T0.getTime() + 45_000),
    endedAt: T0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('meetingOrigin (BAL-651)', () => {
  it('is booked for a session with no meeting, and reads nothing', async () => {
    await expect(meetingOrigin(null)).resolves.toBe('booked');
    expect(mocks.listFactsForMeetings).not.toHaveBeenCalled();
  });

  it('is call_now when a ring created the meeting', async () => {
    mocks.listFactsForMeetings.mockResolvedValue([fact('new_meeting')]);

    await expect(meetingOrigin(MEETING_ID)).resolves.toBe('call_now');
    expect(mocks.listFactsForMeetings).toHaveBeenCalledWith([MEETING_ID]);
  });

  it('is booked when a ring only rode a booking in place', async () => {
    mocks.listFactsForMeetings.mockResolvedValue([fact('in_place')]);

    await expect(meetingOrigin(MEETING_ID)).resolves.toBe('booked');
  });

  it('is booked when no ring ever touched the meeting', async () => {
    mocks.listFactsForMeetings.mockResolvedValue([]);

    await expect(meetingOrigin(MEETING_ID)).resolves.toBe('booked');
  });

  it('falls back to booked and warns with ids only when the read fails', async () => {
    mocks.listFactsForMeetings.mockRejectedValue(new Error('db down'));

    await expect(meetingOrigin(MEETING_ID)).resolves.toBe('booked');
    expect(mocks.warn).toHaveBeenCalledWith(
      { meetingId: MEETING_ID, error: 'db down' },
      expect.any(String)
    );
  });
});
