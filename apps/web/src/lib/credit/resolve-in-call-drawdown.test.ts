import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BAL-403 fix round 2 (R1) / BAL-466 (D3, D8) — `resolveInCallDrawdown` is the ONE composed
 * gate both `page.tsx`'s `resolveBalanceSlot` and `get-meeting-drawdown-state.ts` call. This
 * suite pins its own behaviour directly (the two callers' suites — `page.test.tsx` and
 * `get-meeting-drawdown-state.test.ts` — pin that they call THIS module, not its internals
 * again).
 */

vi.mock('server-only', () => ({}));

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const USER_ID = '11111111-2222-4333-8444-555555555555';
const SESSION_ID = '9d4e2f10-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

const {
  mockFindIdByMeetingId,
  mockAuthorizeMeetingParticipation,
  mockGetSessionDrawdownState,
  mockLogWarn,
} = vi.hoisted(() => ({
  mockFindIdByMeetingId: vi.fn(),
  mockAuthorizeMeetingParticipation: vi.fn(),
  mockGetSessionDrawdownState: vi.fn(),
  mockLogWarn: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  creditSessionsRepository: { findIdByMeetingId: mockFindIdByMeetingId },
}));
vi.mock('@/lib/authz/meeting-participation', () => ({
  authorizeMeetingParticipation: mockAuthorizeMeetingParticipation,
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

const CLIENT_COMPANY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const EXPERT_PROFILE_ID = '88888888-8888-4888-8888-888888888888';

beforeEach(() => {
  vi.clearAllMocks();
  mockFindIdByMeetingId.mockResolvedValue(undefined);
  mockAuthorizeMeetingParticipation.mockResolvedValue({
    ok: true,
    side: 'client',
    companyId: CLIENT_COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
  });
  mockGetSessionDrawdownState.mockResolvedValue(DRAWDOWN_STATE);
});

describe('resolveInCallDrawdown — BAL-466 (D8): authorization runs FIRST', () => {
  it('a denied participant ⇒ credit_sessions is never read at all', async () => {
    mockAuthorizeMeetingParticipation.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

    const result = await resolveInCallDrawdown(MEETING_ID, USER_ID);

    expect(result).toBeNull();
    expect(mockFindIdByMeetingId).not.toHaveBeenCalled();
    expect(mockGetSessionDrawdownState).not.toHaveBeenCalled();
  });

  // ⚠ F11 (review fix round) — RENAMED: this asserts only the CALL ARGUMENTS, not ordering. The
  // real ordering proof — that the session lookup does not run at all when authorization denies
  // — is the test directly above ("a denied participant ⇒ credit_sessions is never read at
  // all") and "no session for this meeting ⇒ null, participation still ran" below.
  it('calls authorizeMeetingParticipation with the meeting + user, even when a session exists', async () => {
    mockFindIdByMeetingId.mockResolvedValue({ id: SESSION_ID });

    await resolveInCallDrawdown(MEETING_ID, USER_ID);

    expect(mockAuthorizeMeetingParticipation).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      userId: USER_ID,
    });
  });

  it('denied ⇒ null, logged with NO sessionId (we never looked)', async () => {
    mockAuthorizeMeetingParticipation.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

    const result = await resolveInCallDrawdown(MEETING_ID, USER_ID);

    expect(result).toBeNull();
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Drawdown read refused — not a participant of this meeting',
      expect.objectContaining({ meetingId: MEETING_ID, userId: USER_ID })
    );
    const [, fields] = mockLogWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(fields).not.toHaveProperty('sessionId');
  });
});

describe('resolveInCallDrawdown — the inert path (authorized, but no session)', () => {
  it('no session for this meeting ⇒ null, participation still ran', async () => {
    mockFindIdByMeetingId.mockResolvedValue(undefined);

    const result = await resolveInCallDrawdown(MEETING_ID, USER_ID);

    expect(result).toBeNull();
    expect(mockAuthorizeMeetingParticipation).toHaveBeenCalled();
    expect(mockGetSessionDrawdownState).not.toHaveBeenCalled();
  });
});

describe('resolveInCallDrawdown — the membership + capability read (step 3)', () => {
  it('denied (not a live company member, or vanished) ⇒ null, logged', async () => {
    mockFindIdByMeetingId.mockResolvedValue({ id: SESSION_ID });
    mockGetSessionDrawdownState.mockResolvedValue(null);

    const result = await resolveInCallDrawdown(MEETING_ID, USER_ID);

    expect(result).toBeNull();
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Drawdown read denied — not a live member of the billed company',
      expect.objectContaining({ meetingId: MEETING_ID, sessionId: SESSION_ID })
    );
  });

  it('calls getSessionDrawdownState with (sessionId, userId)', async () => {
    mockFindIdByMeetingId.mockResolvedValue({ id: SESSION_ID });

    await resolveInCallDrawdown(MEETING_ID, USER_ID);

    expect(mockGetSessionDrawdownState).toHaveBeenCalledWith(SESSION_ID, USER_ID);
  });
});

describe('resolveInCallDrawdown — the live path', () => {
  it('a found session, an authorized participant, and a live member ⇒ the state + sessionId', async () => {
    mockFindIdByMeetingId.mockResolvedValue({ id: SESSION_ID });

    const result = await resolveInCallDrawdown(MEETING_ID, USER_ID);

    expect(result).toEqual({ sessionId: SESSION_ID, state: DRAWDOWN_STATE });
  });
});

describe('resolveInCallDrawdown — the two callers cannot disagree by construction', () => {
  it('the SAME inputs answer null once, whether narrowed to a boolean or read whole', async () => {
    mockAuthorizeMeetingParticipation.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

    const asSlotBoolean = (await resolveInCallDrawdown(MEETING_ID, USER_ID)) !== null;
    const asActionBody = await resolveInCallDrawdown(MEETING_ID, USER_ID);

    expect(asSlotBoolean).toBe(false);
    expect(asActionBody).toBeNull();
  });
});

describe('⚠⚠ D10 — the delivering expert never sees the client funding state', () => {
  it('is denied by the credit_sessions.company_id membership read, even though the PARTICIPATION gate authorizes them', async () => {
    const EXPERT_USER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    // Step 1 says YES and returns side 'expert' — this is the realistic case, not a strawman:
    // the delivering expert genuinely IS a participant of this meeting.
    mockAuthorizeMeetingParticipation.mockResolvedValue({
      ok: true,
      side: 'expert',
      companyId: CLIENT_COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });
    mockFindIdByMeetingId.mockResolvedValue({ id: SESSION_ID });
    // ⚠ F12 (review fix round) — WHAT `mockGetSessionDrawdownState.mockResolvedValue(null)`
    // ACTUALLY PROVES HERE: this file's mock is hand-set, so this test pins only that step 3 is
    // still CALLED (an anti-deletion guard for the composition — real and useful, but not the
    // membership rule itself). Nothing in THIS file reads `credit_sessions.company_id` or knows
    // an expert is never a member of it — that rule is pinned one layer down, by
    // `get-drawdown-state.test.ts`'s "DENIES (null) a viewer who is not a live member of the
    // session company". Do not delete either half believing the other covers it.
    mockGetSessionDrawdownState.mockResolvedValue(null);

    const result = await resolveInCallDrawdown(MEETING_ID, EXPERT_USER_ID);

    expect(result).toBeNull();
    // ⚠ THE ANTI-DELETION ASSERTION. If step 3 is ever removed as "redundant with the
    // participation gate", this expectation fails FIRST and by name — before the null does.
    // (It does NOT by itself prove the membership rule — see the comment above.)
    expect(mockGetSessionDrawdownState).toHaveBeenCalledWith(SESSION_ID, EXPERT_USER_ID);
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Drawdown read denied — not a live member of the billed company',
      expect.objectContaining({ meetingId: MEETING_ID, sessionId: SESSION_ID })
    );
  });
});
