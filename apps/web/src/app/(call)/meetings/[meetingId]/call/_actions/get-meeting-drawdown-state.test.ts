import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BAL-403 fix round 1 (W3) — this action had ZERO tests. It is a polled, allow-listed read on
 * the money surface, and every sibling action has a suite. Covers the refusal literals, the
 * W1 denial collapse (a denied gate and "no session" answer the SAME success arm) and the W6
 * participation gate (a company member who is not a participant of THIS meeting is denied).
 */

vi.mock('server-only', () => ({}));

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const USER_ID = '11111111-2222-4333-8444-555555555555';
const SESSION_ID = '9d4e2f10-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

const {
  mockRequireUser,
  mockFindIdByMeetingId,
  mockAuthorizeMeetingFileAccess,
  mockGetSessionDrawdownState,
  mockLogWarn,
  mockLogError,
} = vi.hoisted(() => ({
  mockRequireUser: vi.fn(),
  mockFindIdByMeetingId: vi.fn(),
  mockAuthorizeMeetingFileAccess: vi.fn(),
  mockGetSessionDrawdownState: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({ requireUser: mockRequireUser }));
vi.mock('@/lib/logging', () => ({
  log: { warn: mockLogWarn, error: mockLogError, info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/meetings/authorize-meeting-file-access', () => ({
  authorizeMeetingFileAccess: mockAuthorizeMeetingFileAccess,
}));
vi.mock('@/lib/credit/actions/get-drawdown-state', () => ({
  getSessionDrawdownState: mockGetSessionDrawdownState,
}));
vi.mock('@balo/db', () => ({
  creditSessionsRepository: { findIdByMeetingId: mockFindIdByMeetingId },
}));

import { getMeetingDrawdownStateAction } from './get-meeting-drawdown-state';

const DRAWDOWN_STATE = { key: 'healthy', status: 'active' } as unknown as Parameters<
  typeof mockGetSessionDrawdownState
>[0];

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({ id: USER_ID });
  mockFindIdByMeetingId.mockResolvedValue(undefined);
  mockAuthorizeMeetingFileAccess.mockResolvedValue({ ok: true, side: 'client' });
  mockGetSessionDrawdownState.mockResolvedValue(DRAWDOWN_STATE);
});

describe('getMeetingDrawdownStateAction — refusals', () => {
  it('unauthenticated ⇒ the shipped literal, and no repository read at all', async () => {
    mockRequireUser.mockRejectedValue(new Error('no session'));

    const result = await getMeetingDrawdownStateAction({ meetingId: MEETING_ID });

    expect(result).toEqual({ success: false, error: 'You are not signed in.', retryable: false });
    expect(mockFindIdByMeetingId).not.toHaveBeenCalled();
  });

  it('malformed input ⇒ the shipped literal', async () => {
    const result = await getMeetingDrawdownStateAction({ meetingId: 'not-a-uuid' });

    expect(result).toEqual({ success: false, error: 'Invalid request.', retryable: false });
    expect(mockFindIdByMeetingId).not.toHaveBeenCalled();
  });
});

describe('getMeetingDrawdownStateAction — the inert path', () => {
  it('no credit session for this meeting ⇒ the SAME inert success arm', async () => {
    mockFindIdByMeetingId.mockResolvedValue(undefined);

    const result = await getMeetingDrawdownStateAction({ meetingId: MEETING_ID });

    expect(result).toEqual({ success: true, state: null });
    expect(mockAuthorizeMeetingFileAccess).not.toHaveBeenCalled();
  });
});

describe('getMeetingDrawdownStateAction — ⚠⚠ W6, participation in THIS meeting', () => {
  it('runs the participation gate AFTER the session is found, never before', async () => {
    mockFindIdByMeetingId.mockResolvedValue({ id: SESSION_ID });

    await getMeetingDrawdownStateAction({ meetingId: MEETING_ID });

    expect(mockAuthorizeMeetingFileAccess).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      userId: USER_ID,
    });
  });

  it('⚠⚠ a company member who is NOT a participant of this meeting is denied — the SAME inert arm as W1', async () => {
    mockFindIdByMeetingId.mockResolvedValue({ id: SESSION_ID });
    mockAuthorizeMeetingFileAccess.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

    const result = await getMeetingDrawdownStateAction({ meetingId: MEETING_ID });

    expect(result).toEqual({ success: true, state: null });
    expect(mockGetSessionDrawdownState).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Drawdown read refused — not in the audience for this meeting',
      expect.objectContaining({ meetingId: MEETING_ID, sessionId: SESSION_ID })
    );
  });
});

describe('getMeetingDrawdownStateAction — ⚠⚠ W1, the gate denial collapses into the inert arm', () => {
  it('`getSessionDrawdownState` returning null (not a live company member) is the SAME success arm as no-session', async () => {
    mockFindIdByMeetingId.mockResolvedValue({ id: SESSION_ID });
    mockGetSessionDrawdownState.mockResolvedValue(null);

    const result = await getMeetingDrawdownStateAction({ meetingId: MEETING_ID });

    expect(result).toEqual({ success: true, state: null });
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Drawdown read denied — not a live company member',
      expect.objectContaining({ meetingId: MEETING_ID, sessionId: SESSION_ID })
    );
  });
});

describe('getMeetingDrawdownStateAction — the live path', () => {
  it('a found session, a participant, and a live member ⇒ state + sessionId', async () => {
    mockFindIdByMeetingId.mockResolvedValue({ id: SESSION_ID });

    const result = await getMeetingDrawdownStateAction({ meetingId: MEETING_ID });

    expect(result).toEqual({ success: true, state: DRAWDOWN_STATE, sessionId: SESSION_ID });
  });
});

describe('getMeetingDrawdownStateAction — transport failures', () => {
  it('a repository throw ⇒ retryable: true, and LOGS the reason', async () => {
    mockFindIdByMeetingId.mockRejectedValue(new Error('db unavailable'));

    const result = await getMeetingDrawdownStateAction({ meetingId: MEETING_ID });

    expect(result).toEqual({
      success: false,
      error: 'Could not load your balance right now.',
      retryable: true,
    });
    expect(mockLogError).toHaveBeenCalledWith(
      'Could not read the in-call drawdown state',
      expect.objectContaining({ meetingId: MEETING_ID })
    );
  });

  it('a thrown participation gate ⇒ retryable: true too', async () => {
    mockFindIdByMeetingId.mockResolvedValue({ id: SESSION_ID });
    mockAuthorizeMeetingFileAccess.mockRejectedValue(new Error('db unavailable'));

    const result = await getMeetingDrawdownStateAction({ meetingId: MEETING_ID });

    expect(result).toEqual({
      success: false,
      error: 'Could not load your balance right now.',
      retryable: true,
    });
  });
});
