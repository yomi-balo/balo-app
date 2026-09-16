import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLink } = vi.hoisted(() => ({ mockLink: vi.fn() }));
vi.mock('@balo/db', () => ({
  meetingGuestsRepository: { linkConvertedUser: mockLink },
}));

const { mockTrack } = vi.hoisted(() => ({ mockTrack: vi.fn() }));
vi.mock('@/lib/analytics/server', async () => {
  const events = await import('@balo/analytics/events');
  return {
    trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
    GUEST_SERVER_EVENTS: events.GUEST_SERVER_EVENTS,
  };
});

// `@/lib/logging` is globally mocked in src/test/setup.ts with the REAL `errorMessage` and
// `vi.fn()` log methods — no per-file mock needed here.
import { log } from '@/lib/logging';
import { runGuestConversionAndEmit } from './run-guest-conversion';

const USER_ID = 'user-1';
const NOW_ISO = '2026-08-06T10:00:00.000Z';

function link(
  guestId: string,
  meeting: { id?: string; startedAt: string | null; scheduledStart: string }
) {
  return {
    guestId,
    meeting: {
      id: meeting.id ?? `meeting-${guestId}`,
      startedAt: meeting.startedAt === null ? null : new Date(meeting.startedAt),
      scheduledStart: new Date(meeting.scheduledStart),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_ISO));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runGuestConversionAndEmit', () => {
  it('an unverified email never links — no repository call, no track, no error log', async () => {
    await runGuestConversionAndEmit({
      userId: USER_ID,
      email: 'dana@northwind.test',
      emailVerified: false,
    });

    expect(mockLink).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('verified, 0 rows linked — calls the repository with the raw seam value, emits nothing', async () => {
    mockLink.mockResolvedValue([]);

    await runGuestConversionAndEmit({
      userId: USER_ID,
      email: 'Dana@Northwind.test',
      emailVerified: true,
    });

    expect(mockLink).toHaveBeenCalledTimes(1);
    expect(mockLink).toHaveBeenCalledWith({
      convertedToUserId: USER_ID,
      verifiedEmail: 'Dana@Northwind.test',
    });
    expect(mockTrack).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('one row linked — fires guest_converted_to_member exactly once, exact shape', async () => {
    mockLink.mockResolvedValue([
      link('guest-1', {
        startedAt: '2026-08-01T10:00:00.000Z',
        scheduledStart: '2026-08-01T09:00:00.000Z',
      }),
    ]);

    await runGuestConversionAndEmit({
      userId: USER_ID,
      email: 'dana@northwind.test',
      emailVerified: true,
    });

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith('guest_converted_to_member', {
      days_since_meeting: 5,
      distinct_id: USER_ID,
    });
  });

  it('last touch across many rows uses the most recent meeting', async () => {
    mockLink.mockResolvedValue([
      link('guest-1', { startedAt: null, scheduledStart: '2026-07-17T10:00:00.000Z' }), // 20 days
      link('guest-2', {
        startedAt: '2026-08-03T10:00:00.000Z',
        scheduledStart: '2026-08-02T10:00:00.000Z',
      }), // 3 days
      link('guest-3', { startedAt: null, scheduledStart: '2026-07-27T10:00:00.000Z' }), // 10 days
    ]);

    await runGuestConversionAndEmit({
      userId: USER_ID,
      email: 'dana@northwind.test',
      emailVerified: true,
    });

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith('guest_converted_to_member', {
      days_since_meeting: 3,
      distinct_id: USER_ID,
    });
  });

  it('the anchor prefers startedAt over scheduledStart on the same row', async () => {
    mockLink.mockResolvedValue([
      link('guest-1', {
        startedAt: '2026-07-29T10:00:00.000Z',
        scheduledStart: '2026-07-28T10:00:00.000Z',
      }),
    ]);

    await runGuestConversionAndEmit({
      userId: USER_ID,
      email: 'dana@northwind.test',
      emailVerified: true,
    });

    expect(mockTrack).toHaveBeenCalledWith('guest_converted_to_member', {
      days_since_meeting: 8,
      distinct_id: USER_ID,
    });
  });

  it('a future meeting reads days_since_meeting: 0', async () => {
    mockLink.mockResolvedValue([
      link('guest-1', { startedAt: null, scheduledStart: '2026-08-07T10:00:00.000Z' }),
    ]);

    await runGuestConversionAndEmit({
      userId: USER_ID,
      email: 'dana@northwind.test',
      emailVerified: true,
    });

    expect(mockTrack).toHaveBeenCalledWith('guest_converted_to_member', {
      days_since_meeting: 0,
      distinct_id: USER_ID,
    });
  });

  it('repository throws — resolves undefined, no track, logs the error without the email', async () => {
    mockLink.mockRejectedValue(new Error('db down'));

    await expect(
      runGuestConversionAndEmit({
        userId: USER_ID,
        email: 'dana@northwind.test',
        emailVerified: true,
      })
    ).resolves.toBeUndefined();

    expect(mockTrack).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      'Guest conversion failed (auth unaffected)',
      expect.objectContaining({ userId: USER_ID, error: 'db down' })
    );

    // ⚠ PII PIN — the email must never reach the logger, in any field.
    expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain('dana@northwind.test');
  });

  it('trackServerAndFlush throws — the call still resolves and logs the error', async () => {
    mockLink.mockResolvedValue([
      link('guest-1', { startedAt: null, scheduledStart: '2026-08-01T10:00:00.000Z' }),
    ]);
    mockTrack.mockImplementationOnce(() => {
      throw new Error('posthog down');
    });

    await expect(
      runGuestConversionAndEmit({
        userId: USER_ID,
        email: 'dana@northwind.test',
        emailVerified: true,
      })
    ).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalledWith(
      'Guest conversion failed (auth unaffected)',
      expect.objectContaining({ userId: USER_ID })
    );
  });

  it('success logs info once with the linked guest count, never the email', async () => {
    mockLink.mockResolvedValue([
      link('guest-1', { startedAt: null, scheduledStart: '2026-08-01T10:00:00.000Z' }),
    ]);

    await runGuestConversionAndEmit({
      userId: USER_ID,
      email: 'dana@northwind.test',
      emailVerified: true,
    });

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      'Guest rows linked to new member',
      expect.objectContaining({ userId: USER_ID, linkedGuestCount: 1 })
    );
    expect(JSON.stringify(vi.mocked(log.info).mock.calls)).not.toContain('dana@northwind.test');
    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.error)).not.toHaveBeenCalled();
  });
});
