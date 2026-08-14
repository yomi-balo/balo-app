import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRequireUser,
  mockRequireOnboardedUser,
  mockGetMeetingGuests,
  mockInviteMeetingGuests,
  mockDecideMeetingGuestAdmission,
  mockResendMeetingGuestLink,
} = vi.hoisted(() => ({
  mockRequireUser: vi.fn(),
  mockRequireOnboardedUser: vi.fn(),
  mockGetMeetingGuests: vi.fn(),
  mockInviteMeetingGuests: vi.fn(),
  mockDecideMeetingGuestAdmission: vi.fn(),
  mockResendMeetingGuestLink: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({
  requireUser: mockRequireUser,
  requireOnboardedUser: mockRequireOnboardedUser,
}));
vi.mock('@/lib/meetings/guests-api-client', () => ({
  getMeetingGuests: mockGetMeetingGuests,
  inviteMeetingGuests: mockInviteMeetingGuests,
  decideMeetingGuestAdmission: mockDecideMeetingGuestAdmission,
  resendMeetingGuestLink: mockResendMeetingGuestLink,
}));

import { log } from '@/lib/logging';
import { containsEmailAddress } from '@/test/contains-email-address';
import { GUEST_ACTION_COPY } from '@/lib/meetings/guests-copy';
import { getMeetingGuestsAction } from './get-meeting-guests';
import { inviteMeetingGuestsAction } from './invite-meeting-guests';
import { decideGuestAdmissionAction } from './decide-guest-admission';
import { resendGuestLinkAction } from './resend-guest-link';

/**
 * BAL-436 — the four in-call guest Server Actions.
 *
 * ⚠⚠ WHAT THIS FILE HOLDS, IN ORDER OF HOW EXPENSIVELY IT WOULD BREAK:
 *   1. **THE AUTH SPLIT.** The read uses bare `requireUser()` (and is on the
 *      `READ_ONLY_ALLOWLIST`); all three mutations use `requireOnboardedUser()`.
 *   2. **NO LOG LINE CARRIES AN ADDRESS OR A TOKEN**, on any arm.
 *   3. **FIXED COPY, MAPPED FROM FIXED LITERALS** — never `err.message`, never prose from a
 *      response body.
 *   4. **`already_decided` IS NOT A FAILURE OUTCOME.**
 */

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const GUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EMAIL = 'dana@northwind.example';

/** Everything logged across every level, as one string, for the leak sweeps. */
function loggedText(): string {
  const calls = [
    ...vi.mocked(log.error).mock.calls,
    ...vi.mocked(log.warn).mock.calls,
    ...vi.mocked(log.info).mock.calls,
  ];
  return JSON.stringify(calls);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({ id: 'user-1' });
  mockRequireOnboardedUser.mockResolvedValue({ id: 'user-1' });
  mockGetMeetingGuests.mockResolvedValue({
    ok: true,
    data: { guests: [], canHost: true, participantCount: 3, participantCap: 10 },
  });
  mockInviteMeetingGuests.mockResolvedValue({
    ok: true,
    data: { guests: [{ id: GUEST_ID }], participantCount: 4, participantCap: 10 },
  });
  mockDecideMeetingGuestAdmission.mockResolvedValue({ ok: true, data: { id: GUEST_ID } });
  mockResendMeetingGuestLink.mockResolvedValue({
    ok: true,
    data: { id: GUEST_ID, expiresAt: '2026-09-08T11:00:00.000Z' },
  });
});

describe('getMeetingGuestsAction — ⚠ the READ, and it must stay read-only', () => {
  it('authenticates with BARE `requireUser()`, never the onboarding gate', async () => {
    await getMeetingGuestsAction({ meetingId: MEETING_ID });

    expect(mockRequireUser).toHaveBeenCalledTimes(1);
    expect(mockRequireOnboardedUser).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ **BOTH VALUES, AND THAT IS THE WHOLE POINT OF THE `it.each`.**
   *
   * `canHost` is the verdict that gates the entire admit/deny queue. An earlier version of this
   * test only ever exercised `true` — which `beforeEach` already defaults to — so hardcoding
   * `canHost: true` in the action left the whole suite green. A pass-through test that only
   * sees one value cannot distinguish a pass-through from a constant.
   */
  it.each([true, false])(
    '⚠⚠ passes the SERVER`s `canHost` verdict through UNCHANGED (%s)',
    async (canHost) => {
      mockGetMeetingGuests.mockResolvedValue({
        ok: true,
        data: { guests: [], canHost, participantCount: 3, participantCap: 10 },
      });

      const result = await getMeetingGuestsAction({ meetingId: MEETING_ID });

      expect(result).toEqual({
        success: true,
        data: { guests: [], canHost, participantCount: 3, participantCap: 10 },
      });
    }
  );

  it('⚠ a signed-out session is NOT logged — this action is POLLED every ~10s', async () => {
    // An expired session would otherwise write one error line per tick for the length of a
    // call. The person is told immediately by the panel; Axiom does not need 360 copies.
    mockRequireUser.mockRejectedValue(new Error('no session'));

    const result = await getMeetingGuestsAction({ meetingId: MEETING_ID });

    expect(result).toEqual({
      success: false,
      error: GUEST_ACTION_COPY.unauthenticated,
      retryable: false,
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it.each([
    ['a transport blip', 0, true],
    ['a rate limit', 429, true],
    ['a 500', 500, true],
    ['a 404 verdict', 404, false],
    ['a 400', 400, false],
  ])(
    'marks %s retryable=%s — the poll keeps its schedule only on the blips',
    async (_label, status, retryable) => {
      mockGetMeetingGuests.mockResolvedValue({ ok: false, status, code: 'meeting_not_found' });

      const result = await getMeetingGuestsAction({ meetingId: MEETING_ID });

      expect(result).toMatchObject({ success: false, retryable });
    }
  );

  it('⚠ logs a refusal at WARN, not ERROR — the poll must not flood Axiom', async () => {
    mockGetMeetingGuests.mockResolvedValue({ ok: false, status: 404, code: 'meeting_not_found' });

    await getMeetingGuestsAction({ meetingId: MEETING_ID });

    expect(log.warn).toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('rejects a malformed meeting id before the hop', async () => {
    await expect(getMeetingGuestsAction({ meetingId: 'nope' })).resolves.toMatchObject({
      success: false,
      retryable: false,
    });
    expect(mockGetMeetingGuests).not.toHaveBeenCalled();
  });
});

describe('inviteMeetingGuestsAction', () => {
  it('⚠ MUTATING ⇒ `requireOnboardedUser()`', async () => {
    await inviteMeetingGuestsAction({ meetingId: MEETING_ID, emails: [EMAIL] });

    expect(mockRequireOnboardedUser).toHaveBeenCalledTimes(1);
  });

  it('forwards the addresses and returns the post-write seat counts', async () => {
    const result = await inviteMeetingGuestsAction({ meetingId: MEETING_ID, emails: [EMAIL] });

    expect(mockInviteMeetingGuests).toHaveBeenCalledWith(MEETING_ID, [EMAIL]);
    expect(result).toEqual({
      success: true,
      invitedCount: 1,
      participantCount: 4,
      participantCap: 10,
    });
  });

  it('⚠⚠ NO LOG LINE CARRIES THE ADDRESS — on the success arm or on any failure arm', async () => {
    await inviteMeetingGuestsAction({ meetingId: MEETING_ID, emails: [EMAIL] });
    mockInviteMeetingGuests.mockResolvedValue({
      ok: false,
      status: 409,
      code: 'guest_already_invited',
    });
    await inviteMeetingGuestsAction({ meetingId: MEETING_ID, emails: [EMAIL] });
    mockRequireOnboardedUser.mockRejectedValue(new Error('no session'));
    await inviteMeetingGuestsAction({ meetingId: MEETING_ID, emails: [EMAIL] });

    expect(loggedText()).not.toContain(EMAIL);
    expect(loggedText()).not.toContain('northwind.example');
  });

  it.each([
    ['participant_cap_reached', 409, 'cap_reached'],
    ['guest_already_invited', 409, 'already_invited'],
    ['rate_limited', 429, 'rate_limited'],
    ['meeting_not_found', 404, 'failed'],
  ])('maps %s to the %s outcome, with fixed copy', async (code, status, outcome) => {
    mockInviteMeetingGuests.mockResolvedValue({ ok: false, status, code });

    const result = await inviteMeetingGuestsAction({ meetingId: MEETING_ID, emails: [EMAIL] });

    expect(result).toMatchObject({ success: false, outcome });
    // ⚠ THE LITERAL IS NEVER SURFACED **AS COPY** — it is mapped, not echoed. Asserted on the
    // `error` string alone: `outcome` is an ANALYTICS dimension whose vocabulary legitimately
    // overlaps the wire literals (`rate_limited` is both), and it never reaches a screen.
    if (!result.success) expect(result.error).not.toContain(code);
  });

  it('rejects a malformed address before the hop, with an actionable sentence', async () => {
    const result = await inviteMeetingGuestsAction({ meetingId: MEETING_ID, emails: ['nope'] });

    expect(result).toEqual({
      success: false,
      error: 'Enter a valid email address.',
      outcome: 'failed',
    });
    expect(mockInviteMeetingGuests).not.toHaveBeenCalled();
  });

  it('⚠ refuses a batch larger than the api`s own parse-time bound', async () => {
    const emails = Array.from({ length: 9 }, (_, index) => `p${index}@x.example`);

    await expect(
      inviteMeetingGuestsAction({ meetingId: MEETING_ID, emails })
    ).resolves.toMatchObject({ success: false });
    expect(mockInviteMeetingGuests).not.toHaveBeenCalled();
  });
});

describe('decideGuestAdmissionAction', () => {
  it('⚠ MUTATING ⇒ `requireOnboardedUser()`', async () => {
    await decideGuestAdmissionAction({
      meetingId: MEETING_ID,
      guestId: GUEST_ID,
      decision: 'admit',
    });

    expect(mockRequireOnboardedUser).toHaveBeenCalledTimes(1);
  });

  /**
   * ⚠ THE SIGNED-OUT ARM IS LOGGED HERE, unlike the read above — this one is a MUTATION a host
   * fired deliberately, so exactly one line per attempt, not one per poll tick. It must never
   * reach the api: a rejected session short-circuits before the hop.
   */
  it('⚠ a rejected session returns the fixed copy, logs once, and never hops', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('no session'));

    const result = await decideGuestAdmissionAction({
      meetingId: MEETING_ID,
      guestId: GUEST_ID,
      decision: 'admit',
    });

    expect(result).toEqual({
      success: false,
      error: GUEST_ACTION_COPY.unauthenticated,
      outcome: 'failed',
    });
    expect(mockDecideMeetingGuestAdmission).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  /**
   * ⚠ A NON-`Error` REJECTION AND A NON-STRING id ARE BOTH REACHABLE. This is a Server Action:
   * the argument crosses the wire unvalidated, so `input.meetingId` is `string` only by
   * declaration. Both defensive arms exist precisely so the log line cannot itself throw.
   */
  it('⚠ survives a non-Error rejection and a non-string meetingId without throwing', async () => {
    mockRequireOnboardedUser.mockRejectedValue('no session');

    const result = await decideGuestAdmissionAction({
      meetingId: 12345 as unknown as string,
      guestId: GUEST_ID,
      decision: 'admit',
    });

    expect(result).toMatchObject({ success: false, outcome: 'failed' });
    expect(vi.mocked(log.error).mock.calls[0]?.[1]).toMatchObject({
      meetingId: undefined,
      error: 'no session',
      stack: undefined,
    });
  });

  it.each(['admit' as const, 'deny' as const])(
    'forwards the %s decision verbatim',
    async (decision) => {
      await decideGuestAdmissionAction({ meetingId: MEETING_ID, guestId: GUEST_ID, decision });

      expect(mockDecideMeetingGuestAdmission).toHaveBeenCalledWith(MEETING_ID, GUEST_ID, decision);
    }
  );

  it('⚠⚠ `guest_not_pending` IS A RACE — outcome `already_decided`, logged at WARN', async () => {
    mockDecideMeetingGuestAdmission.mockResolvedValue({
      ok: false,
      status: 409,
      code: 'guest_not_pending',
    });

    const result = await decideGuestAdmissionAction({
      meetingId: MEETING_ID,
      guestId: GUEST_ID,
      decision: 'admit',
    });

    expect(result).toEqual({
      success: false,
      error: GUEST_ACTION_COPY.guest_not_pending,
      outcome: 'already_decided',
    });
    expect(log.warn).toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('a REAL refusal is `failed`, and IS logged at error', async () => {
    mockDecideMeetingGuestAdmission.mockResolvedValue({
      ok: false,
      status: 404,
      code: 'guest_not_found',
    });

    const result = await decideGuestAdmissionAction({
      meetingId: MEETING_ID,
      guestId: GUEST_ID,
      decision: 'deny',
    });

    expect(result).toMatchObject({ success: false, outcome: 'failed' });
    expect(log.error).toHaveBeenCalled();
  });

  /**
   * ⚠⚠ THE BAIT IS IN THE **API RESPONSE**, WHICH IS THE ONLY PLACE AN ADDRESS COULD COME FROM
   * ON THIS ACTION.
   *
   * `decideGuestAdmissionAction` is handed two uuids and a decision — no address is in scope
   * from its arguments, so an earlier version of this sweep ran over a string that could not
   * have contained one and therefore could not fail. What CAN leak here is the api's answer: a
   * `log.error(..., { body })` or a `result.message` spread into the context would carry
   * whatever the api returned, and the api's own guest rows carry addresses.
   */
  it('⚠⚠ NO ADDRESS FROM THE API RESPONSE REACHES A LOG LINE — ids and the decision only', async () => {
    const leaked = 'taylor@somewhere.example';
    mockDecideMeetingGuestAdmission.mockResolvedValue({
      ok: false,
      status: 404,
      code: 'guest_not_found',
      // ⚠ SHAPES THE HAZARD: an api answer that happens to carry a guest's address. Nothing in
      // the action's contract reads this field — and this test is what keeps that true.
      detail: `no live guest ${leaked} on this meeting`,
      guestEmail: leaked,
    });

    await decideGuestAdmissionAction({
      meetingId: MEETING_ID,
      guestId: GUEST_ID,
      decision: 'admit',
    });

    const text = loggedText();
    expect(text).not.toContain(leaked);
    expect(containsEmailAddress(text)).toBe(false);
    // ⚠ THE BAIT IS REAL. Without this the sweep could pass because the scan itself broke.
    expect(containsEmailAddress(leaked)).toBe(true);
  });

  it('rejects an unknown decision before the hop', async () => {
    await expect(
      decideGuestAdmissionAction({
        meetingId: MEETING_ID,
        guestId: GUEST_ID,
        decision: 'maybe' as 'admit',
      })
    ).resolves.toMatchObject({ success: false, outcome: 'failed' });
    expect(mockDecideMeetingGuestAdmission).not.toHaveBeenCalled();
  });
});

describe('resendGuestLinkAction', () => {
  it('⚠ MUTATING ⇒ `requireOnboardedUser()`', async () => {
    await resendGuestLinkAction({ meetingId: MEETING_ID, guestId: GUEST_ID });

    expect(mockRequireOnboardedUser).toHaveBeenCalledTimes(1);
  });

  it('reports success without surfacing anything the api returned', async () => {
    const result = await resendGuestLinkAction({ meetingId: MEETING_ID, guestId: GUEST_ID });

    expect(result).toEqual({ success: true });
  });

  /**
   * ⚠⚠ A REJECTED SESSION MUST NOT ROTATE A CREDENTIAL. The re-send kills the previous link, so
   * short-circuiting BEFORE the hop is the difference between "nothing happened" and "the guest's
   * working link just died for an unauthenticated caller".
   */
  it('⚠ a rejected session returns the fixed copy and never rotates the link', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('no session'));

    const result = await resendGuestLinkAction({ meetingId: MEETING_ID, guestId: GUEST_ID });

    expect(result).toEqual({ success: false, error: GUEST_ACTION_COPY.unauthenticated });
    expect(mockResendMeetingGuestLink).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  /** ⚠ The defensive arms of the log line — a non-`Error` throw and a non-string id. */
  it('⚠ survives a non-Error rejection and a non-string meetingId without throwing', async () => {
    mockRequireOnboardedUser.mockRejectedValue('no session');

    const result = await resendGuestLinkAction({
      meetingId: 12345 as unknown as string,
      guestId: GUEST_ID,
    });

    expect(result).toMatchObject({ success: false });
    expect(vi.mocked(log.error).mock.calls[0]?.[1]).toMatchObject({
      meetingId: undefined,
      error: 'no session',
      stack: undefined,
    });
  });

  /** ⚠ No address or token leaks on the signed-out arm either. */
  it('logs no identifier beyond the meeting id when the session is rejected', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('no session'));

    await resendGuestLinkAction({ meetingId: MEETING_ID, guestId: GUEST_ID });

    expect(containsEmailAddress(loggedText())).toBe(false);
  });

  it('maps `guest_link_not_resendable` to its own sentence', async () => {
    mockResendMeetingGuestLink.mockResolvedValue({
      ok: false,
      status: 409,
      code: 'guest_link_not_resendable',
    });

    await expect(
      resendGuestLinkAction({ meetingId: MEETING_ID, guestId: GUEST_ID })
    ).resolves.toEqual({
      success: false,
      error: GUEST_ACTION_COPY.guest_link_not_resendable,
    });
  });

  /**
   * ⚠⚠ THE BAIT IS ON **BOTH** API ANSWERS, because this is the one action whose success arm
   * genuinely handles a credential-adjacent payload.
   *
   * A re-send mails a freshly ROTATED raw token to an address an anonymous visitor typed. The
   * action's arguments are two uuids, so — as with admit/deny — the only address in scope comes
   * back from the api. An earlier version swept a string that could not contain one. Here the
   * success answer carries a raw token AND the recipient, which is exactly the shape a
   * well-meaning `log.info('re-sent', result.data)` would spill.
   */
  it('⚠⚠ NO TOKEN AND NO ADDRESS IN ANY LOG LINE, on either arm', async () => {
    const leaked = 'taylor@somewhere.example';
    const rawToken = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde';
    mockResendMeetingGuestLink.mockResolvedValue({
      ok: true,
      data: {
        id: GUEST_ID,
        expiresAt: '2026-09-08T11:00:00.000Z',
        // ⚠ NEITHER FIELD IS ON THE REAL RESPONSE — the api deliberately returns no token. They
        // are here so that a caller who started spreading `result.data` into a log fails.
        recipientEmail: leaked,
        joinToken: rawToken,
      },
    });
    await resendGuestLinkAction({ meetingId: MEETING_ID, guestId: GUEST_ID });

    mockResendMeetingGuestLink.mockResolvedValue({
      ok: false,
      status: 404,
      code: 'guest_not_found',
      detail: `no live guest ${leaked} on this meeting`,
    });
    await resendGuestLinkAction({ meetingId: MEETING_ID, guestId: GUEST_ID });

    const text = loggedText();
    expect(text).not.toContain(leaked);
    expect(text).not.toContain(rawToken);
    expect(containsEmailAddress(text)).toBe(false);
    expect(text.toLowerCase()).not.toContain('token');
    expect(containsEmailAddress(leaked)).toBe(true);
  });

  it('rejects a malformed guest id before the hop', async () => {
    await expect(
      resendGuestLinkAction({ meetingId: MEETING_ID, guestId: 'nope' })
    ).resolves.toMatchObject({ success: false });
    expect(mockResendMeetingGuestLink).not.toHaveBeenCalled();
  });
});
