import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));

const RELATIONSHIP_ID = 'c0000000-0000-4000-8000-000000000002';

const mockListActiveMeetingsForContexts = vi.fn();
vi.mock('@balo/db', () => ({
  meetingsRepository: {
    listActiveMeetingsForContexts: (...args: unknown[]) =>
      mockListActiveMeetingsForContexts(...args),
  },
}));
// The real, pure `pickUpcomingContextMeeting` is what is under test — never mocked. That is the
// point: this guard and the CTA must ask the SAME question.

import { assertNoLiveIntroCall } from './assert-no-live-intro-call';

const NOW = new Date('2026-08-25T00:00:00.000Z');

function meetingRow(overrides: Record<string, unknown> = {}) {
  return {
    meetingId: 'meeting-1',
    scheduledStart: new Date('2026-08-26T04:00:00.000Z'),
    scheduledEnd: new Date('2026-08-26T04:30:00.000Z'),
    status: 'scheduled',
    ...overrides,
  };
}

describe('assertNoLiveIntroCall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks the repository for exactly this relationship, on the request_interaction label', async () => {
    mockListActiveMeetingsForContexts.mockResolvedValue(new Map([[RELATIONSHIP_ID, []]]));
    await expect(assertNoLiveIntroCall(RELATIONSHIP_ID)).resolves.toBe(true);
    expect(mockListActiveMeetingsForContexts).toHaveBeenCalledWith({
      contextType: 'request_interaction',
      contextIds: [RELATIONSHIP_ID],
    });
  });

  it('denies when an UPCOMING call already exists — the one-call-per-thread rule the UI claims', async () => {
    mockListActiveMeetingsForContexts.mockResolvedValue(
      new Map([[RELATIONSHIP_ID, [meetingRow()]]])
    );
    await expect(assertNoLiveIntroCall(RELATIONSHIP_ID)).resolves.toBe(false);
  });

  /**
   * ⚠ THE SAME QUESTION THE CTA ASKS. An ENDED intro call must NOT block re-booking — the whole
   * point of round-1 C2 — or the thread would be permanently unbookable with no recovery path.
   * If this ever diverges from `loadConversationView`'s `bookedCall`, the server starts refusing
   * bookings the UI is still offering (or vice versa).
   */
  it('allows re-booking once the previous call has ENDED', async () => {
    mockListActiveMeetingsForContexts.mockResolvedValue(
      new Map([
        [
          RELATIONSHIP_ID,
          [
            meetingRow({
              scheduledStart: new Date('2026-08-20T04:00:00.000Z'),
              scheduledEnd: new Date('2026-08-20T04:30:00.000Z'),
              status: 'ended',
            }),
          ],
        ],
      ])
    );
    await expect(assertNoLiveIntroCall(RELATIONSHIP_ID)).resolves.toBe(true);
  });

  it('allows re-booking once the previous window has simply passed, whatever its status', async () => {
    mockListActiveMeetingsForContexts.mockResolvedValue(
      new Map([
        [
          RELATIONSHIP_ID,
          [
            meetingRow({
              scheduledStart: new Date('2026-08-24T04:00:00.000Z'),
              scheduledEnd: new Date('2026-08-24T04:30:00.000Z'),
              status: 'scheduled',
            }),
          ],
        ],
      ])
    );
    await expect(assertNoLiveIntroCall(RELATIONSHIP_ID)).resolves.toBe(true);
  });

  it('denies when a PAST call and an UPCOMING one both exist', async () => {
    mockListActiveMeetingsForContexts.mockResolvedValue(
      new Map([
        [
          RELATIONSHIP_ID,
          [
            meetingRow({
              meetingId: 'meeting-past',
              scheduledStart: new Date('2026-08-20T04:00:00.000Z'),
              scheduledEnd: new Date('2026-08-20T04:30:00.000Z'),
              status: 'ended',
            }),
            meetingRow({ meetingId: 'meeting-next' }),
          ],
        ],
      ])
    );
    await expect(assertNoLiveIntroCall(RELATIONSHIP_ID)).resolves.toBe(false);
  });

  it('allows when the repository returns no entry for this id at all', async () => {
    mockListActiveMeetingsForContexts.mockResolvedValue(new Map());
    await expect(assertNoLiveIntroCall(RELATIONSHIP_ID)).resolves.toBe(true);
  });
});
