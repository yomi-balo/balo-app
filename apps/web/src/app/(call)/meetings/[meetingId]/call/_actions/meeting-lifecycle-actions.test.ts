import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequireUser, mockRequireOnboardedUser, mockGetMeetingState, mockEndMeeting } =
  vi.hoisted(() => ({
    mockRequireUser: vi.fn(),
    mockRequireOnboardedUser: vi.fn(),
    mockGetMeetingState: vi.fn(),
    mockEndMeeting: vi.fn(),
  }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({
  requireUser: mockRequireUser,
  requireOnboardedUser: mockRequireOnboardedUser,
}));
vi.mock('@/lib/meetings/meeting-lifecycle-client', () => ({
  getMeetingState: mockGetMeetingState,
  endMeeting: mockEndMeeting,
}));

import { MEETING_END_NOT_JOINED_CODE, MEETING_END_NOT_STARTED_CODE } from '@balo/shared/meetings';
import { log } from '@/lib/logging';
import {
  END_MEETING_FAILED_COPY,
  END_MEETING_NOT_JOINED_COPY,
  END_MEETING_NOT_STARTED_COPY,
} from '@/lib/meetings/meeting-state';
import { getMeetingStateAction } from './get-meeting-state';
import { endMeetingAction } from './end-meeting';

/**
 * BAL-134 — the two in-call meeting-lifecycle Server Actions.
 *
 * ⚠⚠ WHAT THIS FILE HOLDS, IN ORDER OF HOW EXPENSIVELY IT WOULD BREAK:
 *   1. **THE AUTH SPLIT.** The polled READ uses bare `requireUser()` (and is on the
 *      `READ_ONLY_ALLOWLIST`); the END is a MUTATION and uses `requireOnboardedUser()`.
 *      `onboarding-mutation-gate.test.ts` enforces the split structurally; this pins the
 *      behaviour.
 *   2. **`retryable` IS THE POLL'S WHOLE CONTRACT.** A transport blip must keep the schedule and
 *      a `404` must stop it — collapsing the two makes a dropped packet look like a dead meeting
 *      to a participant mid-call.
 *   3. **`alreadyEnded` IS A SUCCESS** (D10). Two holders can press End in the same instant.
 *   4. **THE POLLED READ DOES NOT LOG AT `error`.** It runs every ~10s for the length of a call,
 *      so an expired session would otherwise write one error line per tick.
 */

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';

const STATE_BODY = {
  status: 'waiting_for_participants',
  outcome: null,
  endedBy: null,
  viewerRole: 'expert',
  phase: 'running',
  clocks: {
    expertPresentMs: 60_000,
    billableMs: 0,
    expertFirstJoinedAt: '2026-08-14T10:00:00.000Z',
    billableStartedAt: null,
  },
  asOf: '2026-08-14T10:01:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({ id: 'user_1' });
  mockRequireOnboardedUser.mockResolvedValue({ id: 'user_1' });
});

describe('getMeetingStateAction — the polled read', () => {
  it('forwards the api body untouched on success (the BROWSER owns the parse)', async () => {
    mockGetMeetingState.mockResolvedValue({ ok: true, data: STATE_BODY });

    await expect(getMeetingStateAction({ meetingId: MEETING_ID })).resolves.toEqual({
      success: true,
      state: STATE_BODY,
    });
    expect(mockGetMeetingState).toHaveBeenCalledWith(MEETING_ID);
  });

  it('⚠ uses the bare requireUser gate — NOT the onboarding gate', async () => {
    mockGetMeetingState.mockResolvedValue({ ok: true, data: STATE_BODY });

    await getMeetingStateAction({ meetingId: MEETING_ID });

    expect(mockRequireUser).toHaveBeenCalled();
    expect(mockRequireOnboardedUser).not.toHaveBeenCalled();
  });

  it('is NOT retryable on an unauthenticated session, and reads nothing', async () => {
    mockRequireUser.mockRejectedValue(new Error('no session'));

    await expect(getMeetingStateAction({ meetingId: MEETING_ID })).resolves.toEqual({
      success: false,
      retryable: false,
    });
    expect(mockGetMeetingState).not.toHaveBeenCalled();
  });

  it('⚠⚠ writes NO error log on the unauthenticated arm — it is POLLED', async () => {
    mockRequireUser.mockRejectedValue(new Error('no session'));

    await getMeetingStateAction({ meetingId: MEETING_ID });

    expect(log.error).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid meeting id before the hop', async () => {
    await expect(getMeetingStateAction({ meetingId: 'not-a-uuid' })).resolves.toEqual({
      success: false,
      retryable: false,
    });
    expect(mockGetMeetingState).not.toHaveBeenCalled();
  });

  describe('⚠⚠ retryable — the poll keeps its schedule on a blip and stops on a verdict', () => {
    const CASES: readonly [number, boolean][] = [
      [0, true], // transport
      [429, true], // rate limited
      [500, true],
      [503, true],
      [404, false], // a verdict
      [401, false],
      [400, false],
    ];

    for (const [status, retryable] of CASES) {
      it(`status ${status} → retryable: ${retryable}`, async () => {
        mockGetMeetingState.mockResolvedValue({ ok: false, status, code: 'meeting_not_found' });

        await expect(getMeetingStateAction({ meetingId: MEETING_ID })).resolves.toMatchObject({
          success: false,
          retryable,
        });
      });
    }
  });

  it('forwards a Retry-After when the api sent one, and OMITS the key otherwise', async () => {
    mockGetMeetingState.mockResolvedValue({
      ok: false,
      status: 429,
      code: 'rate_limited',
      retryAfterSeconds: 12,
    });
    await expect(getMeetingStateAction({ meetingId: MEETING_ID })).resolves.toMatchObject({
      retryAfterSeconds: 12,
    });

    mockGetMeetingState.mockResolvedValue({ ok: false, status: 429, code: 'rate_limited' });
    const result = await getMeetingStateAction({ meetingId: MEETING_ID });
    expect(result).not.toHaveProperty('retryAfterSeconds');
  });

  it('⚠ a refusal is logged at `warn` with ids and codes only', async () => {
    mockGetMeetingState.mockResolvedValue({ ok: false, status: 404, code: 'meeting_not_found' });

    await getMeetingStateAction({ meetingId: MEETING_ID });

    expect(log.warn).toHaveBeenCalledWith(
      'Meeting state read refused',
      expect.objectContaining({ meetingId: MEETING_ID, status: 404, code: 'meeting_not_found' })
    );
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe('endMeetingAction — the mutation', () => {
  it('⚠⚠ uses requireOnboardedUser — NOT the read-only gate its sibling uses', async () => {
    mockEndMeeting.mockResolvedValue({ ok: true, data: { alreadyEnded: false } });

    await endMeetingAction({ meetingId: MEETING_ID });

    expect(mockRequireOnboardedUser).toHaveBeenCalled();
    expect(mockRequireUser).not.toHaveBeenCalled();
  });

  it('returns success on a first end', async () => {
    mockEndMeeting.mockResolvedValue({
      ok: true,
      data: { status: 'ended', alreadyEnded: false, endedBy: 'client_principal' },
    });

    await expect(endMeetingAction({ meetingId: MEETING_ID })).resolves.toEqual({
      success: true,
      alreadyEnded: false,
    });
  });

  it('⚠⚠ `alreadyEnded` IS A SUCCESS (D10) — a race that resolved correctly, not a red toast', async () => {
    mockEndMeeting.mockResolvedValue({
      ok: true,
      data: { status: 'ended', alreadyEnded: true, endedBy: 'expert_host' },
    });

    await expect(endMeetingAction({ meetingId: MEETING_ID })).resolves.toEqual({
      success: true,
      alreadyEnded: true,
    });
  });

  it('⚠ a missing `alreadyEnded` defaults to false rather than to `undefined`', async () => {
    mockEndMeeting.mockResolvedValue({ ok: true, data: {} });

    await expect(endMeetingAction({ meetingId: MEETING_ID })).resolves.toEqual({
      success: true,
      alreadyEnded: false,
    });
  });

  // BAL-474 (D6.4, R6-C6) — renamed on the record. It was "maps EVERY refusal onto the one fixed
  // literal"; `meeting_not_joined` and `meeting_not_started` are now the two refusals with their own
  // copy (pinned in the cases below), so this table covers every OTHER code the api can answer.
  it('maps every refusal except meeting_not_joined and meeting_not_started onto the one fixed literal — never prose from the wire', async () => {
    const codes = ['meeting_not_found', 'invalid_request', 'rate_limited', 'request_failed'];
    for (const status of [400, 401, 404, 409, 429, 500, 0]) {
      for (const code of codes) {
        mockEndMeeting.mockResolvedValue({ ok: false, status, code });

        await expect(endMeetingAction({ meetingId: MEETING_ID })).resolves.toEqual({
          success: false,
          error: END_MEETING_FAILED_COPY,
        });
      }
    }
  });

  it('⚠ R6-C6 — meeting_not_started maps onto ITS OWN copy, pinned against the FULL approved literal', async () => {
    mockEndMeeting.mockResolvedValue({
      ok: false,
      status: 409,
      code: MEETING_END_NOT_STARTED_CODE,
    });

    const result = await endMeetingAction({ meetingId: MEETING_ID });

    expect(result).toEqual({ success: false, error: END_MEETING_NOT_STARTED_COPY });
    expect(END_MEETING_NOT_STARTED_COPY).toBe(
      "This call can't be ended before its start time. You can leave — it stays open, so you can come back to it."
    );
    expect(END_MEETING_NOT_STARTED_COPY).not.toBe(END_MEETING_FAILED_COPY);
    expect(END_MEETING_NOT_STARTED_COPY).not.toBe(END_MEETING_NOT_JOINED_COPY);
  });

  it('⚠ the R6-C6 mapping applies ONLY to meeting_not_started — the neighbouring 409s keep their own copy', async () => {
    mockEndMeeting.mockResolvedValue({ ok: false, status: 409, code: 'meeting_not_found' });
    await expect(endMeetingAction({ meetingId: MEETING_ID })).resolves.toEqual({
      success: false,
      error: END_MEETING_FAILED_COPY,
    });
    mockEndMeeting.mockResolvedValue({ ok: false, status: 409, code: MEETING_END_NOT_JOINED_CODE });
    await expect(endMeetingAction({ meetingId: MEETING_ID })).resolves.toEqual({
      success: false,
      error: END_MEETING_NOT_JOINED_COPY,
    });
  });

  it('meeting_not_started is an EXPECTED refusal — logged at `info`, never `error`', async () => {
    mockEndMeeting.mockResolvedValue({
      ok: false,
      status: 409,
      code: MEETING_END_NOT_STARTED_CODE,
    });

    await endMeetingAction({ meetingId: MEETING_ID });

    expect(log.info).toHaveBeenCalledWith(
      'Meeting end refused — the meeting has not reached its scheduled start',
      expect.objectContaining({ meetingId: MEETING_ID, status: 409, code: 'meeting_not_started' })
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('⚠ meeting_not_joined maps onto ITS OWN copy — the call is still running, try again shortly', async () => {
    mockEndMeeting.mockResolvedValue({ ok: false, status: 409, code: MEETING_END_NOT_JOINED_CODE });

    const result = await endMeetingAction({ meetingId: MEETING_ID });

    expect(result).toEqual({ success: false, error: END_MEETING_NOT_JOINED_COPY });
    expect(END_MEETING_NOT_JOINED_COPY).toBe(
      "We couldn't end the call just yet — it can take a moment after you join. Try again shortly; everyone is still connected."
    );
    // Positive control: it really is a DIFFERENT string from the generic one.
    expect(END_MEETING_NOT_JOINED_COPY).not.toBe(END_MEETING_FAILED_COPY);
  });

  it('⚠ meeting_not_joined is an EXPECTED race — logged at `info`, never `error`', async () => {
    mockEndMeeting.mockResolvedValue({ ok: false, status: 409, code: MEETING_END_NOT_JOINED_CODE });

    await endMeetingAction({ meetingId: MEETING_ID });

    expect(log.info).toHaveBeenCalledWith(
      'Meeting end refused — the client member has not joined this meeting yet',
      expect.objectContaining({
        meetingId: MEETING_ID,
        status: 409,
        code: 'meeting_not_joined',
      })
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('fails closed with no hop when the session is not onboarded', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('onboarding incomplete'));

    await expect(endMeetingAction({ meetingId: MEETING_ID })).resolves.toEqual({
      success: false,
      error: END_MEETING_FAILED_COPY,
    });
    expect(mockEndMeeting).not.toHaveBeenCalled();
    // ⚠ `error`, NOT `warn`: unlike the polled read this is a single user-initiated act that did
    // not do what the person asked.
    expect(log.error).toHaveBeenCalled();
  });

  it('rejects a non-uuid meeting id before the hop', async () => {
    await expect(endMeetingAction({ meetingId: 'nope' })).resolves.toEqual({
      success: false,
      error: END_MEETING_FAILED_COPY,
    });
    expect(mockEndMeeting).not.toHaveBeenCalled();
  });

  it('⚠ a refusal is logged at `error` with ids and codes only', async () => {
    mockEndMeeting.mockResolvedValue({ ok: false, status: 404, code: 'meeting_not_found' });

    await endMeetingAction({ meetingId: MEETING_ID });

    expect(log.error).toHaveBeenCalledWith(
      'Meeting end refused',
      expect.objectContaining({ meetingId: MEETING_ID, status: 404, code: 'meeting_not_found' })
    );
  });

  it('⚠ logs the successful end as a business event', async () => {
    mockEndMeeting.mockResolvedValue({
      ok: true,
      data: { alreadyEnded: false, endedBy: 'client_principal' },
    });

    await endMeetingAction({ meetingId: MEETING_ID });

    expect(log.info).toHaveBeenCalledWith(
      'Meeting ended by participant',
      expect.objectContaining({ meetingId: MEETING_ID, alreadyEnded: false })
    );
  });
});
