import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequireOnboardedUser, mockInviteMeetingGuests } = vi.hoisted(() => ({
  mockRequireOnboardedUser: vi.fn(),
  mockInviteMeetingGuests: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: mockRequireOnboardedUser,
}));
vi.mock('@/lib/meetings/guests-api-client', () => ({
  inviteMeetingGuests: mockInviteMeetingGuests,
}));

import { log } from '@/lib/logging';
import { containsEmailAddress } from '@/test/contains-email-address';
import { GUEST_ACTION_COPY } from '@/lib/meetings/guests-copy';
import { inviteOutcomeFor, performGuestInvite } from './invite-guests-flow';

/**
 * BAL-573 — the ONE shared guest-invite implementation, exercised over BOTH entry points
 * (`'in_call'` and `'case_surface'`) so a regression to a single hardcoded literal fails here
 * rather than only on the entry point the change happened to touch.
 */

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const EMAIL = 'dana@northwind.example';

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
  mockRequireOnboardedUser.mockResolvedValue({ id: 'user-1' });
  mockInviteMeetingGuests.mockResolvedValue({
    ok: true,
    data: { guests: [{ id: 'guest-1' }], participantCount: 4, participantCap: 10 },
  });
});

describe('performGuestInvite — entryPoint is forwarded verbatim', () => {
  it.each(['case_surface', 'in_call'] as const)(
    'forwards entryPoint=%s to the api client',
    async (entryPoint) => {
      await performGuestInvite({ meetingId: MEETING_ID, emails: [EMAIL], entryPoint });

      expect(mockInviteMeetingGuests).toHaveBeenCalledWith(MEETING_ID, [EMAIL], entryPoint);
    }
  );
});

describe('performGuestInvite — no address in any log line, on either entry point', () => {
  it.each(['case_surface', 'in_call'] as const)(
    'stays address-free across success, refusal and rejected-session, for %s',
    async (entryPoint) => {
      await performGuestInvite({ meetingId: MEETING_ID, emails: [EMAIL], entryPoint });

      mockInviteMeetingGuests.mockResolvedValue({
        ok: false,
        status: 409,
        code: 'guest_already_invited',
      });
      await performGuestInvite({ meetingId: MEETING_ID, emails: [EMAIL], entryPoint });

      mockRequireOnboardedUser.mockRejectedValue(new Error('no session'));
      await performGuestInvite({ meetingId: MEETING_ID, emails: [EMAIL], entryPoint });

      expect(loggedText()).not.toContain(EMAIL);
      expect(containsEmailAddress(loggedText())).toBe(false);
    }
  );
});

describe('performGuestInvite — the onboarding gate', () => {
  it('calls requireOnboardedUser exactly once and short-circuits BEFORE the hop on rejection', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('no session'));

    const result = await performGuestInvite({
      meetingId: MEETING_ID,
      emails: [EMAIL],
      entryPoint: 'case_surface',
    });

    expect(mockRequireOnboardedUser).toHaveBeenCalledTimes(1);
    expect(mockInviteMeetingGuests).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: GUEST_ACTION_COPY.unauthenticated,
      outcome: 'failed',
    });
  });
});

describe('performGuestInvite — zod validation', () => {
  it('rejects a malformed address before the hop, with an actionable sentence', async () => {
    const result = await performGuestInvite({
      meetingId: MEETING_ID,
      emails: ['nope'],
      entryPoint: 'case_surface',
    });

    expect(result).toEqual({
      success: false,
      error: 'Enter a valid email address.',
      outcome: 'failed',
    });
    expect(mockInviteMeetingGuests).not.toHaveBeenCalled();
  });

  it('refuses a batch larger than the 8-address bound before the hop', async () => {
    const emails = Array.from({ length: 9 }, (_, index) => `p${index}@x.example`);

    await expect(
      performGuestInvite({ meetingId: MEETING_ID, emails, entryPoint: 'case_surface' })
    ).resolves.toMatchObject({ success: false });
    expect(mockInviteMeetingGuests).not.toHaveBeenCalled();
  });
});

describe('inviteOutcomeFor — the wire literal is never surfaced as copy', () => {
  it.each([
    [409, 'participant_cap_reached', 'cap_reached'],
    [409, 'guest_already_invited', 'already_invited'],
    [429, 'meeting_not_found', 'rate_limited'],
    [404, 'meeting_not_found', 'failed'],
  ] as const)('maps (%s, %s) to %s', (status, code, expected) => {
    expect(inviteOutcomeFor(status, code)).toBe(expected);
  });

  it('never surfaces the wire literal as the error copy', async () => {
    mockInviteMeetingGuests.mockResolvedValue({
      ok: false,
      status: 409,
      code: 'participant_cap_reached',
    });

    const result = await performGuestInvite({
      meetingId: MEETING_ID,
      emails: [EMAIL],
      entryPoint: 'case_surface',
    });

    expect(result).toMatchObject({ success: false, outcome: 'cap_reached' });
    if (!result.success) expect(result.error).not.toContain('participant_cap_reached');
  });
});
