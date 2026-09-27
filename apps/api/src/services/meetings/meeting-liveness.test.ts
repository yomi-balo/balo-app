import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockEngagementFindById, mockInfo, mockWarn } = vi.hoisted(() => ({
  mockEngagementFindById: vi.fn(),
  mockInfo: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: mockInfo, warn: mockWarn, error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  engagementsRepository: { findById: mockEngagementFindById },
}));
// ⚠ `@balo/shared/meetings` is deliberately NOT mocked — `PrimaryMeetingContext` is a type
// and the real module carries no behaviour this file needs to stub.

import { CASE_JOIN_WINDOW_MINUTES } from '@balo/shared/engagements';
import {
  assertMeetingJoinable,
  expiresAtUnixFor,
  MEETING_TOKEN_TTL_AFTER_END_MS,
} from './meeting-liveness.js';

const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const ENGAGEMENT_ID = '44444444-4444-4444-8444-444444444444';
const REQUEST_ID = '66666666-6666-4666-8666-666666666666';

const SCHEDULED_END = new Date('2026-09-01T11:00:00.000Z');
/** Inside the 24h window: one hour after the call ended. */
const DURING_WINDOW = new Date('2026-09-01T12:00:00.000Z');
/** Past it: 25 hours after the call ended. */
const AFTER_WINDOW = new Date('2026-09-02T12:00:00.000Z');

function meeting(overrides: Record<string, unknown> = {}): never {
  return {
    id: MEETING_ID,
    status: 'scheduled',
    scheduledStart: new Date('2026-09-01T10:00:00.000Z'),
    scheduledEnd: SCHEDULED_END,
    ...overrides,
  } as never;
}

/** An engagement-grain subject (has a lifecycle) and a request-grain one (does not). */
const ENGAGEMENT_SUBJECT = { contextType: 'case', contextId: ENGAGEMENT_ID } as const;
const REQUEST_SUBJECT = { contextType: 'project_discovery', contextId: REQUEST_ID } as const;

beforeEach(() => {
  vi.clearAllMocks();
  mockEngagementFindById.mockResolvedValue({ id: ENGAGEMENT_ID, status: 'active' });
});

describe('assertMeetingJoinable — the meeting`s own state', () => {
  it.each(['scheduled', 'waiting_for_participants', 'in_progress'] as const)(
    'ALLOWS status `%s`',
    async (status) => {
      const result = await assertMeetingJoinable(
        meeting({ status }),
        ENGAGEMENT_SUBJECT,
        DURING_WINDOW
      );
      expect(result.ok).toBe(true);
    }
  );

  it.each(['ended', 'cancelled'] as const)(
    'REFUSES status `%s` with `meeting_terminal`',
    async (status) => {
      const result = await assertMeetingJoinable(
        meeting({ status }),
        ENGAGEMENT_SUBJECT,
        DURING_WINDOW
      );
      expect(result).toEqual({ ok: false, reason: 'meeting_terminal' });
    }
  );

  it('checks the meeting BEFORE the engagement — a cancelled meeting reads no engagement', async () => {
    // Ordering is a cost decision, not a correctness one, but it is pinned so the cheap
    // check cannot drift behind the round trip.
    await assertMeetingJoinable(
      meeting({ status: 'cancelled' }),
      ENGAGEMENT_SUBJECT,
      DURING_WINDOW
    );
    expect(mockEngagementFindById).not.toHaveBeenCalled();
  });
});

describe('assertMeetingJoinable — ENGAGEMENT lifecycle (the obligation the capability seam refuses)', () => {
  it.each(['case', 'project_kickoff', 'package_session', 'retainer_checkin'] as const)(
    'reads the engagement for context type `%s`',
    async (contextType) => {
      await assertMeetingJoinable(
        meeting(),
        { contextType, contextId: ENGAGEMENT_ID },
        DURING_WINDOW
      );
      expect(mockEngagementFindById).toHaveBeenCalledWith(ENGAGEMENT_ID);
    }
  );

  it('ALLOWS an `active` engagement', async () => {
    mockEngagementFindById.mockResolvedValue({ id: ENGAGEMENT_ID, status: 'active' });
    const result = await assertMeetingJoinable(meeting(), ENGAGEMENT_SUBJECT, DURING_WINDOW);
    expect(result.ok).toBe(true);
  });

  it.each(['completed', 'cancelled'] as const)(
    '⚠⚠ REFUSES a `%s` engagement — THE BAL-132 FAILURE MODE',
    async (status) => {
      // `hasEngagementCapability` NEVER reads `engagements.status`, so the delivering expert
      // of this engagement still holds `host_meetings`. This branch is the only thing between
      // that and a Daily OWNER token for work that was called off.
      mockEngagementFindById.mockResolvedValue({ id: ENGAGEMENT_ID, status });
      const result = await assertMeetingJoinable(meeting(), ENGAGEMENT_SUBJECT, DURING_WINDOW);
      expect(result).toEqual({ ok: false, reason: 'engagement_not_active' });
    }
  );

  it('REFUSES a MISSING (or soft-deleted) engagement with `engagement_missing`', async () => {
    mockEngagementFindById.mockResolvedValue(undefined);
    const result = await assertMeetingJoinable(meeting(), ENGAGEMENT_SUBJECT, DURING_WINDOW);
    expect(result).toEqual({ ok: false, reason: 'engagement_missing' });
  });
});

describe('assertMeetingJoinable — REQUEST-grain contexts have no engagement to check', () => {
  it.each(['project_discovery', 'request_interaction'] as const)(
    '⚠ context type `%s` passes with ZERO engagement reads',
    async (contextType) => {
      // There is no `engagements` row until kickoff. A read would be a guaranteed `undefined`
      // that denied every intro call on the platform. Asserting the ABSENCE of the call is
      // the only way to state that; a passing result alone would not distinguish it.
      const result = await assertMeetingJoinable(
        meeting(),
        { contextType, contextId: REQUEST_ID },
        DURING_WINDOW
      );

      expect(result.ok).toBe(true);
      expect(mockEngagementFindById).not.toHaveBeenCalled();
    }
  );

  it('a request-grain context is still refused when the MEETING is terminal', async () => {
    const result = await assertMeetingJoinable(
      meeting({ status: 'ended' }),
      REQUEST_SUBJECT,
      DURING_WINDOW
    );
    expect(result).toEqual({ ok: false, reason: 'meeting_terminal' });
  });
});

describe('assertMeetingJoinable — the token window', () => {
  it('expires at scheduled end + 24h EXACTLY', async () => {
    const result = await assertMeetingJoinable(meeting(), ENGAGEMENT_SUBJECT, DURING_WINDOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.expiresAt.toISOString()).toBe('2026-09-02T11:00:00.000Z');
    expect(result.expiresAt.getTime() - SCHEDULED_END.getTime()).toBe(
      MEETING_TOKEN_TTL_AFTER_END_MS
    );
  });

  it('⚠⚠ reports `expiresAtUnix` in SECONDS, not milliseconds', async () => {
    // A unit slip here is silently accepted by Daily and yields a token expiring ~50,000
    // years out — a permanent credential to a private room, reported by nothing.
    const result = await assertMeetingJoinable(meeting(), ENGAGEMENT_SUBJECT, DURING_WINDOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.expiresAtUnix).toBe(result.expiresAt.getTime() / 1000);
    // A seconds-since-epoch value for 2026 is ~1.79e9; the millisecond one is ~1.79e12.
    expect(result.expiresAtUnix).toBeLessThan(1e11);
  });

  it('ALLOWS an instant just BEFORE the window closes', async () => {
    const justBefore = new Date(SCHEDULED_END.getTime() + MEETING_TOKEN_TTL_AFTER_END_MS - 1000);
    const result = await assertMeetingJoinable(meeting(), ENGAGEMENT_SUBJECT, justBefore);
    expect(result.ok).toBe(true);
  });

  it('REFUSES at EXACTLY the closing instant — the boundary is closed, not open', async () => {
    const exactly = new Date(SCHEDULED_END.getTime() + MEETING_TOKEN_TTL_AFTER_END_MS);
    const result = await assertMeetingJoinable(meeting(), ENGAGEMENT_SUBJECT, exactly);
    expect(result).toEqual({ ok: false, reason: 'token_window_elapsed' });
  });

  it('⚠ REFUSES a long-past meeting still sitting in `scheduled` — REACHABLE TODAY', async () => {
    // Nothing transitions a meeting out of `scheduled` until BAL-134 ships, so this row
    // sails through the terminal-set check. Without this branch Daily is handed a PAST `exp`
    // and issues a dead token — a confusing failure two layers from its cause.
    const result = await assertMeetingJoinable(meeting(), ENGAGEMENT_SUBJECT, AFTER_WINDOW);
    expect(result).toEqual({ ok: false, reason: 'token_window_elapsed' });
  });
});

describe("assertMeetingJoinable — ⚠⚠ D16: the join window's SERVER-SIDE lower bound", () => {
  const START = new Date('2026-09-01T10:00:00.000Z');
  const WINDOW_MS = CASE_JOIN_WINDOW_MINUTES * 60_000;
  const OPENS_AT = new Date(START.getTime() - WINDOW_MS);

  it('the window is the D16 ruling: 3 minutes', () => {
    expect(CASE_JOIN_WINDOW_MINUTES).toBe(3);
  });

  it.each([
    ['1 ms before it opens', new Date(OPENS_AT.getTime() - 1)],
    ['ten minutes early', new Date(START.getTime() - 10 * 60_000)],
    ['a day early', new Date(START.getTime() - 24 * 60 * 60_000)],
  ])('REFUSES %s with `join_window_not_open` and `opensAt`', async (_label, now) => {
    const result = await assertMeetingJoinable(meeting(), ENGAGEMENT_SUBJECT, now);
    expect(result).toEqual({ ok: false, reason: 'join_window_not_open', opensAt: OPENS_AT });
  });

  it.each([
    ['exactly when it opens (inclusive)', OPENS_AT],
    ['inside the window', new Date(START.getTime() - 60_000)],
    ['exactly at the start', START],
    ['after the start', new Date(START.getTime() + 10 * 60_000)],
  ])('ADMITS %s', async (_label, now) => {
    const result = await assertMeetingJoinable(meeting(), ENGAGEMENT_SUBJECT, now);
    expect(result.ok).toBe(true);
  });

  it('applies to a request-grain (non-case) context too — the web join window is context-agnostic', async () => {
    const result = await assertMeetingJoinable(
      meeting(),
      REQUEST_SUBJECT,
      new Date(START.getTime() - 60 * 60_000)
    );
    expect(result).toMatchObject({ ok: false, reason: 'join_window_not_open' });
    expect(mockEngagementFindById).not.toHaveBeenCalled();
  });

  it('is logged at INFO, not WARN — an expected early click, not a denial', async () => {
    await assertMeetingJoinable(
      meeting(),
      ENGAGEMENT_SUBJECT,
      new Date(START.getTime() - 60 * 60_000)
    );
    expect(mockInfo).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'join_window_not_open', opensAt: OPENS_AT.toISOString() }),
      expect.stringContaining('join window has not opened')
    );
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('a terminal meeting, or an inactive engagement, wins over the window — never "opens later"', async () => {
    const early = new Date(START.getTime() - 60 * 60_000);
    await expect(
      assertMeetingJoinable(meeting({ status: 'cancelled' }), ENGAGEMENT_SUBJECT, early)
    ).resolves.toMatchObject({ reason: 'meeting_terminal' });
    mockEngagementFindById.mockResolvedValue({ id: ENGAGEMENT_ID, status: 'completed' });
    await expect(
      assertMeetingJoinable(meeting(), ENGAGEMENT_SUBJECT, early)
    ).resolves.toMatchObject({
      reason: 'engagement_not_active',
    });
  });

  it('the window is checked BEFORE the token window: an early join never reaches it', async () => {
    const result = await assertMeetingJoinable(
      meeting(),
      ENGAGEMENT_SUBJECT,
      new Date(START.getTime() - 60_000)
    );
    expect(result.ok).toBe(true);
  });
});

describe('expiresAtUnixFor', () => {
  it('floors rather than rounds — the value can never land PAST the intended instant', () => {
    // A `scheduled_end` carrying sub-second precision must not be rounded up into an extra
    // second of validity.
    const withMillis = new Date(SCHEDULED_END.getTime() + 999);
    expect(expiresAtUnixFor(withMillis)).toBe(expiresAtUnixFor(SCHEDULED_END));
  });
});
