import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetCurrentUser, mockListPage, mockLoadDetails } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockListPage: vi.fn(),
  mockLoadDetails: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('@balo/db', () => ({
  captureHealthRepository: { listPage: mockListPage, loadDetails: mockLoadDetails },
}));
// `@balo/shared/capture-health` is deliberately NOT mocked — it is pure, and a partial mock
// stubbing only the page size hid `REDRIVE_KINDS`, which the action's Zod schema enumerates.

import { CAPTURE_HEALTH_MAX_WINDOW_DAYS } from '@balo/shared/capture-health';
import { loadMoreCaptureHealth } from './load-more-capture-health';

const CURSOR = {
  healthRank: 3,
  scheduledStartIso: '2026-08-15T10:00:00.000Z',
  meetingId: '11111111-1111-4111-8111-111111111111',
};
const STAFF_USER = { id: 'user_1', platformRole: 'admin' };

describe('loadMoreCaptureHealth', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mockLoadDetails.mockResolvedValue({
      recordings: new Map(),
      recap: new Map(),
      recapFailed: new Map(),
      expert: new Map(),
      party: new Map(),
    });
  });

  it('denies with no session', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const result = await loadMoreCaptureHealth({
      cursor: CURSOR,
      fromIso: '2026-08-01',
      toIso: '2026-08-31',
      category: null,
      withheldBeforeIso: '2026-09-10T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
    expect(mockListPage).not.toHaveBeenCalled();
  });

  it('denies a non-staff viewer', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user_1', platformRole: 'user' });
    const result = await loadMoreCaptureHealth({
      cursor: CURSOR,
      fromIso: '2026-08-01',
      toIso: '2026-08-31',
      category: null,
      withheldBeforeIso: '2026-09-10T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
    expect(mockListPage).not.toHaveBeenCalled();
  });

  it('returns the next page, mapped through buildCaptureHealthRow', async () => {
    mockGetCurrentUser.mockResolvedValue(STAFF_USER);
    mockListPage.mockResolvedValue({
      rows: [
        {
          meetingId: '22222222-2222-4222-8222-222222222222',
          scheduledStart: new Date('2026-08-16T10:00:00.000Z'),
          scheduledEnd: new Date('2026-08-16T10:30:00.000Z'),
          startedAt: null,
          endedAt: null,
          meetingStatus: 'ended',
          healthRank: 3,
          facts: {
            recording: {
              segmentCount: 1,
              anyFailed: false,
              anySourceReady: false,
              anyIngesting: false,
              anyCapturing: false,
              anyReady: true,
              anyRedrivableFailure: false,
            },
            transcription: {
              anyFailure: false,
              anySubmitted: true,
              anyOpen: false,
              anyWithheld: false,
              anyFinished: true,
            },
            recap: {
              transcriptCount: 1,
              anyFailed: false,
              anyPartial: false,
              anyProcessing: false,
              anyReady: true,
            },
            hasEngagementContext: true,
          },
        },
      ],
      hasMore: false,
    });

    const result = await loadMoreCaptureHealth({
      cursor: CURSOR,
      fromIso: '2026-08-01',
      toIso: '2026-08-31',
      category: null,
      withheldBeforeIso: '2026-09-10T00:00:00.000Z',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.rows).toHaveLength(1);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    }
    expect(mockListPage).toHaveBeenCalledWith(
      expect.objectContaining({
        after: {
          healthRank: 3,
          scheduledStart: new Date('2026-08-15T10:00:00.000Z'),
          meetingId: CURSOR.meetingId,
        },
        category: null,
      })
    );
  });

  it('a malformed cursor is refused with the generic failure copy', async () => {
    mockGetCurrentUser.mockResolvedValue(STAFF_USER);
    const result = await loadMoreCaptureHealth({
      cursor: { healthRank: -1, scheduledStartIso: 'not-a-date', meetingId: 'not-a-uuid' },
      fromIso: '2026-08-01',
      toIso: '2026-08-31',
      category: null,
      withheldBeforeIso: '2026-09-10T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
    expect(mockListPage).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ THE WINDOW IS RE-CLAMPED SERVER-SIDE, NOT TAKEN ON TRUST. `fromIso`/`toIso` are fully
   * client-supplied, and the repository runs three GROUPED AGGREGATE sub-queries over the
   * window BEFORE the row `LIMIT` trims anything — so an unbounded span is a read amplification
   * any `VIEW_PLATFORM_ADMIN` holder could trigger, including a platform `admin` who cannot
   * even re-drive.
   */
  it('clamps an over-wide span to CAPTURE_HEALTH_MAX_WINDOW_DAYS before it reaches SQL', async () => {
    mockGetCurrentUser.mockResolvedValue(STAFF_USER);
    mockListPage.mockResolvedValue({ rows: [], hasMore: false });

    // ~5 years. Unclamped, this would sweep every meeting Balo has ever held.
    await loadMoreCaptureHealth({
      cursor: CURSOR,
      fromIso: '2021-01-01',
      toIso: '2026-08-31',
      category: null,
      withheldBeforeIso: '2026-09-10T00:00:00.000Z',
    });

    const call = mockListPage.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    const spanDays =
      (call.window.to.getTime() - call.window.from.getTime()) / (24 * 60 * 60 * 1000);
    expect(spanDays).toBe(CAPTURE_HEALTH_MAX_WINDOW_DAYS);
    // `to` is the half-open bound — the day AFTER the last included one.
    expect(call.window.to.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('a non `YYYY-MM-DD` window string is refused before any read', async () => {
    mockGetCurrentUser.mockResolvedValue(STAFF_USER);

    const result = await loadMoreCaptureHealth({
      cursor: CURSOR,
      fromIso: '1970-01-01T00:00:00.000Z',
      toIso: '2026-08-31',
      category: null,
      withheldBeforeIso: '2026-09-10T00:00:00.000Z',
    });

    expect(result.success).toBe(false);
    expect(mockListPage).not.toHaveBeenCalled();
  });

  /**
   * A LATER `withheldBefore` would let a caller declare every in-flight transcription
   * "withheld" and re-rank the whole lens; an EARLIER one is exactly what page-to-page
   * stability needs. Only the ceiling is enforced.
   */
  it('clamps a future withheldBefore down to now − TRANSCRIPT_SOURCE_WITHHELD_AFTER_MS', async () => {
    mockGetCurrentUser.mockResolvedValue(STAFF_USER);
    mockListPage.mockResolvedValue({ rows: [], hasMore: false });
    // `Date.now()` is what the clamp reads — spied rather than faked, so no timer shim sits
    // between this test and the action's own `await`s.
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-09-11T12:00:00.000Z').getTime());

    await loadMoreCaptureHealth({
      cursor: CURSOR,
      fromIso: '2026-08-01',
      toIso: '2026-08-31',
      category: null,
      withheldBeforeIso: '2030-01-01T00:00:00.000Z',
    });

    const call = mockListPage.mock.calls[0]?.[0];
    expect(call.withheldBefore.toISOString()).toBe('2026-09-10T12:00:00.000Z');
  });

  it('leaves an EARLIER withheldBefore alone — that is what keeps a long session stable', async () => {
    mockGetCurrentUser.mockResolvedValue(STAFF_USER);
    mockListPage.mockResolvedValue({ rows: [], hasMore: false });
    // `Date.now()` is what the clamp reads — spied rather than faked, so no timer shim sits
    // between this test and the action's own `await`s.
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-09-11T12:00:00.000Z').getTime());

    await loadMoreCaptureHealth({
      cursor: CURSOR,
      fromIso: '2026-08-01',
      toIso: '2026-08-31',
      category: null,
      withheldBeforeIso: '2026-09-09T00:00:00.000Z',
    });

    const call = mockListPage.mock.calls[0]?.[0];
    expect(call.withheldBefore.toISOString()).toBe('2026-09-09T00:00:00.000Z');
  });

  it('a repository throw is caught, logged, and returns the generic failure', async () => {
    mockGetCurrentUser.mockResolvedValue(STAFF_USER);
    mockListPage.mockRejectedValue(new Error('db down'));

    const result = await loadMoreCaptureHealth({
      cursor: CURSOR,
      fromIso: '2026-08-01',
      toIso: '2026-08-31',
      category: null,
      withheldBeforeIso: '2026-09-10T00:00:00.000Z',
    });

    expect(result).toEqual({
      success: false,
      error: 'Could not load more. Try again in a moment.',
    });
  });
});
