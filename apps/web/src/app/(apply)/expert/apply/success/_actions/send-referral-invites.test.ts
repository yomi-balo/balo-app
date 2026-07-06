import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Constants ────────────────────────────────────────────────────

const USER_ID = 'user-1';
const PROFILE_ID = 'b0000000-0000-4000-8000-000000000001';
const VERTICAL_ID = 'vertical-1';

// ── Mocks ────────────────────────────────────────────────────────

vi.mock('server-only', () => ({}));

// The action never touches next/headers directly (getSession + publish are both
// mocked), but stub it so nothing pulls the real cookie store into the test.
vi.mock('next/headers', () => ({
  cookies: vi.fn(() => ({ get: vi.fn() })),
  headers: vi.fn(() => new Headers()),
}));

const mockGetSalesforceVertical = vi.fn();
const mockFindApplicationByUserId = vi.fn();
const mockClaim = vi.fn();

vi.mock('@balo/db', () => ({
  referenceDataRepository: {
    getSalesforceVertical: (...args: unknown[]) => mockGetSalesforceVertical(...args),
  },
  expertsRepository: {
    findApplicationByUserId: (...args: unknown[]) => mockFindApplicationByUserId(...args),
  },
  expertReferralInvitesRepository: {
    claim: (...args: unknown[]) => mockClaim(...args),
  },
}));

const mockPublish = vi.fn();

vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublish(...args),
}));

let mockSessionObj: Record<string, unknown>;

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { sendReferralInvitesAction } from './send-referral-invites';

// ── Helpers ──────────────────────────────────────────────────────

function setSession(firstName: string | null, lastName: string | null): void {
  mockSessionObj = {
    user: { id: USER_ID, email: 'me@example.com', firstName, lastName },
    save: vi.fn(),
  };
}

function claimReturnsRow(id: string): { id: string } {
  return { id };
}

// ── Tests ────────────────────────────────────────────────────────

describe('sendReferralInvitesAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSession('Ada', 'Lovelace');
    mockGetSalesforceVertical.mockResolvedValue({ id: VERTICAL_ID });
    mockFindApplicationByUserId.mockResolvedValue({ id: PROFILE_ID });
    mockPublish.mockResolvedValue(undefined);
  });

  describe('authentication', () => {
    it('throws Unauthorized when the session has no user', async () => {
      mockSessionObj = { save: vi.fn() };
      await expect(sendReferralInvitesAction({ emails: ['a@b.com'] })).rejects.toThrow(
        'Unauthorized'
      );
    });
  });

  it('claims each unique email and publishes only for newly-claimed rows', async () => {
    mockClaim
      .mockResolvedValueOnce(claimReturnsRow('row-1'))
      .mockResolvedValueOnce(claimReturnsRow('row-2'));

    const result = await sendReferralInvitesAction({
      emails: ['first@example.com', 'second@example.com'],
    });

    expect(result).toEqual({
      ok: true,
      results: [
        { email: 'first@example.com', status: 'sent' },
        { email: 'second@example.com', status: 'sent' },
      ],
      sentCount: 2,
      alreadyCount: 0,
    });

    // Resolves the profile from the session — never a client-supplied id.
    expect(mockFindApplicationByUserId).toHaveBeenCalledWith(USER_ID, VERTICAL_ID);

    // One claim per unique email, keyed on the resolved profile + session user.
    expect(mockClaim).toHaveBeenCalledTimes(2);
    expect(mockClaim).toHaveBeenNthCalledWith(1, {
      expertProfileId: PROFILE_ID,
      email: 'first@example.com',
      invitedByUserId: USER_ID,
    });

    // Publish fires per newly-claimed row, correlationId === row.id.
    expect(mockPublish).toHaveBeenCalledTimes(2);
    expect(mockPublish).toHaveBeenNthCalledWith(1, 'expert.referral_invited', {
      correlationId: 'row-1',
      recipientEmail: 'first@example.com',
      inviterName: 'Ada Lovelace',
    });
  });

  it('does NOT publish for an already-invited address (claim returns undefined)', async () => {
    mockClaim.mockResolvedValueOnce(claimReturnsRow('row-1')).mockResolvedValueOnce(undefined);

    const result = await sendReferralInvitesAction({
      emails: ['new@example.com', 'dupe@example.com'],
    });

    expect(result).toEqual({
      ok: true,
      results: [
        { email: 'new@example.com', status: 'sent' },
        { email: 'dupe@example.com', status: 'already_invited' },
      ],
      sentCount: 1,
      alreadyCount: 1,
    });

    // Publish only for the newly-claimed row.
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith('expert.referral_invited', {
      correlationId: 'row-1',
      recipientEmail: 'new@example.com',
      inviterName: 'Ada Lovelace',
    });
  });

  it('returns no_application when the caller has no expert application', async () => {
    mockFindApplicationByUserId.mockResolvedValue(undefined);

    const result = await sendReferralInvitesAction({ emails: ['a@b.com'] });

    expect(result).toEqual({ ok: false, error: 'no_application' });
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('rejects invalid emails with invalid_input before touching the DB', async () => {
    const result = await sendReferralInvitesAction({ emails: ['not-an-email'] });

    expect(result).toEqual({ ok: false, error: 'invalid_input' });
    expect(mockFindApplicationByUserId).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it('rejects more than 20 emails with invalid_input', async () => {
    const emails = Array.from({ length: 21 }, (_v, i) => `user${i}@example.com`);
    const result = await sendReferralInvitesAction({ emails });
    expect(result).toEqual({ ok: false, error: 'invalid_input' });
  });

  it('lowercases and de-duplicates emails before claiming', async () => {
    mockClaim
      .mockResolvedValueOnce(claimReturnsRow('row-1'))
      .mockResolvedValueOnce(claimReturnsRow('row-2'));

    const result = await sendReferralInvitesAction({
      emails: ['Test@Example.com', 'test@example.com', 'Other@X.com'],
    });

    // Two unique normalized addresses claimed.
    expect(mockClaim).toHaveBeenCalledTimes(2);
    const claimedEmails = mockClaim.mock.calls.map((call) => (call[0] as { email: string }).email);
    expect(claimedEmails).toEqual(['test@example.com', 'other@x.com']);
    expect(result).toMatchObject({ ok: true, sentCount: 2, alreadyCount: 0 });
  });

  it('falls back to "A colleague" when BOTH first and last name are null', async () => {
    setSession(null, null);
    mockClaim.mockResolvedValueOnce(claimReturnsRow('row-1'));

    await sendReferralInvitesAction({ emails: ['a@b.com'] });

    expect(mockPublish).toHaveBeenCalledWith('expert.referral_invited', {
      correlationId: 'row-1',
      recipientEmail: 'a@b.com',
      inviterName: 'A colleague',
    });
  });

  it('uses only the present name part when one of first/last is null', async () => {
    setSession('Grace', null);
    mockClaim.mockResolvedValueOnce(claimReturnsRow('row-1'));

    await sendReferralInvitesAction({ emails: ['a@b.com'] });

    expect(mockPublish).toHaveBeenCalledWith(
      'expert.referral_invited',
      expect.objectContaining({ inviterName: 'Grace' })
    );
  });

  it('returns unknown and does not throw when a repository rejects', async () => {
    mockClaim.mockRejectedValue(new Error('DB down'));

    const result = await sendReferralInvitesAction({ emails: ['a@b.com'] });

    expect(result).toEqual({ ok: false, error: 'unknown' });
  });
});
