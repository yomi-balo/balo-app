import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BAL-403 fix round 2 (R1) — `resolveInCallDrawdown` is the ONE composed gate both `page.tsx`'s
 * `resolveBalanceSlot` and `get-meeting-drawdown-state.ts` call. This suite pins its own
 * behaviour directly (the two callers' suites — `page.test.tsx` and
 * `get-meeting-drawdown-state.test.ts` — pin that they call THIS module, not its internals
 * again).
 */

vi.mock('server-only', () => ({}));

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const USER_ID = '11111111-2222-4333-8444-555555555555';
const SESSION_ID = '9d4e2f10-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

const {
  mockFindIdByMeetingId,
  mockAuthorizeMeetingFileAccess,
  mockGetSessionDrawdownState,
  mockLogWarn,
} = vi.hoisted(() => ({
  mockFindIdByMeetingId: vi.fn(),
  mockAuthorizeMeetingFileAccess: vi.fn(),
  mockGetSessionDrawdownState: vi.fn(),
  mockLogWarn: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  creditSessionsRepository: { findIdByMeetingId: mockFindIdByMeetingId },
}));
vi.mock('@/lib/meetings/authorize-meeting-file-access', () => ({
  authorizeMeetingFileAccess: mockAuthorizeMeetingFileAccess,
}));
vi.mock('@/lib/credit/actions/get-drawdown-state', () => ({
  getSessionDrawdownState: mockGetSessionDrawdownState,
}));
vi.mock('@/lib/logging', () => ({
  log: { warn: mockLogWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { resolveInCallDrawdown } from './resolve-in-call-drawdown';

const DRAWDOWN_STATE = { key: 'healthy', status: 'active' } as unknown as Parameters<
  typeof mockGetSessionDrawdownState
>[0];

beforeEach(() => {
  vi.clearAllMocks();
  mockFindIdByMeetingId.mockResolvedValue(undefined);
  mockAuthorizeMeetingFileAccess.mockResolvedValue({ ok: true, side: 'client' });
  mockGetSessionDrawdownState.mockResolvedValue(DRAWDOWN_STATE);
});

describe('resolveInCallDrawdown — the inert path', () => {
  it('no session for this meeting ⇒ null, and the audience gate never runs', async () => {
    mockFindIdByMeetingId.mockResolvedValue(undefined);

    const result = await resolveInCallDrawdown(MEETING_ID, USER_ID);

    expect(result).toBeNull();
    expect(mockAuthorizeMeetingFileAccess).not.toHaveBeenCalled();
  });
});

describe('resolveInCallDrawdown — the audience gate', () => {
  it('runs the gate AFTER the session is found, never before', async () => {
    mockFindIdByMeetingId.mockResolvedValue({ id: SESSION_ID });

    await resolveInCallDrawdown(MEETING_ID, USER_ID);

    expect(mockAuthorizeMeetingFileAccess).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      userId: USER_ID,
    });
  });

  it('denied ⇒ null, logged, and the membership + capability read never runs', async () => {
    mockFindIdByMeetingId.mockResolvedValue({ id: SESSION_ID });
    mockAuthorizeMeetingFileAccess.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

    const result = await resolveInCallDrawdown(MEETING_ID, USER_ID);

    expect(result).toBeNull();
    expect(mockGetSessionDrawdownState).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Drawdown read refused — not in the audience for this meeting',
      expect.objectContaining({ meetingId: MEETING_ID, sessionId: SESSION_ID })
    );
  });
});

describe('resolveInCallDrawdown — the membership + capability read', () => {
  it('denied (not a live company member, or vanished) ⇒ null, logged', async () => {
    mockFindIdByMeetingId.mockResolvedValue({ id: SESSION_ID });
    mockGetSessionDrawdownState.mockResolvedValue(null);

    const result = await resolveInCallDrawdown(MEETING_ID, USER_ID);

    expect(result).toBeNull();
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Drawdown read denied — not a live company member',
      expect.objectContaining({ meetingId: MEETING_ID, sessionId: SESSION_ID })
    );
  });
});

describe('resolveInCallDrawdown — the live path', () => {
  it('a found session, a passed audience gate, and a live member ⇒ the state + sessionId', async () => {
    mockFindIdByMeetingId.mockResolvedValue({ id: SESSION_ID });

    const result = await resolveInCallDrawdown(MEETING_ID, USER_ID);

    expect(result).toEqual({ sessionId: SESSION_ID, state: DRAWDOWN_STATE });
  });
});

describe('resolveInCallDrawdown — the two callers cannot disagree by construction', () => {
  it('the SAME inputs answer null once, whether narrowed to a boolean or read whole', async () => {
    mockFindIdByMeetingId.mockResolvedValue({ id: SESSION_ID });
    mockAuthorizeMeetingFileAccess.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

    const asSlotBoolean = (await resolveInCallDrawdown(MEETING_ID, USER_ID)) !== null;
    const asActionBody = await resolveInCallDrawdown(MEETING_ID, USER_ID);

    expect(asSlotBoolean).toBe(false);
    expect(asActionBody).toBeNull();
  });
});
