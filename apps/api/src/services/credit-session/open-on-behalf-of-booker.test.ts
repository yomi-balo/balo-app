import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockResolveSubject,
  mockFindBooker,
  mockMeetingFindById,
  mockEnsureForCompany,
  mockOpen,
  mockFindUserIdByProfileId,
  mockGetMemberRole,
  DB,
} = vi.hoisted(() => ({
  mockResolveSubject: vi.fn(),
  mockFindBooker: vi.fn(),
  mockMeetingFindById: vi.fn(),
  mockEnsureForCompany: vi.fn(),
  mockOpen: vi.fn(),
  mockFindUserIdByProfileId: vi.fn(),
  mockGetMemberRole: vi.fn(),
  DB: { __db: true },
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  db: DB,
  clientPartyRecipientsRepository: { findMeetingBookerUserId: mockFindBooker },
  meetingsRepository: { findById: mockMeetingFindById },
  creditWalletsRepository: { ensureForCompany: mockEnsureForCompany },
  creditSessionsRepository: { open: mockOpen },
  expertsRepository: { findUserIdByProfileId: mockFindUserIdByProfileId },
  partyMembershipsRepository: { getMemberRole: mockGetMemberRole },
}));
vi.mock('./case-billing-subject.js', () => ({ resolveCaseBillingSubject: mockResolveSubject }));

import {
  openSessionOnBehalfOfBooker,
  resolveMeetingBooker,
  resolveOnBehalfOpenInput,
} from './open-on-behalf-of-booker.js';

const MEETING_ID = 'meeting-1';
const SUBJECT = {
  engagementId: 'engagement-1',
  companyId: 'company-1',
  expertProfileId: 'expert-1',
  isActive: true,
  closedAt: null,
};
const START = new Date('2026-09-25T10:00:00.000Z');
const END = new Date('2026-09-25T10:30:00.000Z');

describe('open-on-behalf-of-booker (BAL-474, D3 / D4 / D5.6 / D5.9 / D7.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSubject.mockResolvedValue(SUBJECT);
    mockFindBooker.mockResolvedValue('booker-1');
    mockMeetingFindById.mockResolvedValue({
      id: MEETING_ID,
      scheduledStart: START,
      scheduledEnd: END,
    });
    mockEnsureForCompany.mockResolvedValue({ id: 'wallet-1' });
    mockFindUserIdByProfileId.mockResolvedValue({ user: { id: 'expert-user-1' } });
    mockGetMemberRole.mockResolvedValue('member');
  });

  describe('resolveMeetingBooker', () => {
    it("delegates to the repository's one definition of the booker (the `meeting.booked` actor)", async () => {
      await expect(resolveMeetingBooker(MEETING_ID)).resolves.toBe('booker-1');
      expect(mockFindBooker).toHaveBeenCalledWith(MEETING_ID);
    });

    it('is null when the repository resolves no booker — never a fabricated actor', async () => {
      mockFindBooker.mockResolvedValue(null);
      await expect(resolveMeetingBooker(MEETING_ID)).resolves.toBeNull();
    });
  });

  describe('resolveOnBehalfOpenInput', () => {
    it('⚠ Rule A — `onBehalfOfUserId` (a present client MEMBER) is the attributed initiating member; no booker lookup runs', async () => {
      const result = await resolveOnBehalfOpenInput({
        meetingId: MEETING_ID,
        openedBy: 'system',
        trigger: 'billing_start',
        attended: true,
        onBehalfOfUserId: 'present-member-1',
      });
      expect(result.ok && result.open.initiatingMemberId).toBe('present-member-1');
      expect(mockFindBooker).not.toHaveBeenCalled();
    });

    it('⚠ R6F-16 — the present member is attributed only after a LIVE-membership check against the engagement’s company', async () => {
      await resolveOnBehalfOpenInput({
        meetingId: MEETING_ID,
        openedBy: 'system',
        trigger: 'billing_start',
        attended: true,
        onBehalfOfUserId: 'present-member-1',
      });
      expect(mockGetMemberRole).toHaveBeenCalledWith('company', 'company-1', 'present-member-1');
    });

    it('⚠⚠ R6F-16 — a member REMOVED mid-call (no live role) whose presence row is still open falls back to the booker', async () => {
      mockGetMemberRole.mockResolvedValue(undefined);
      const result = await resolveOnBehalfOpenInput({
        meetingId: MEETING_ID,
        openedBy: 'system',
        trigger: 'billing_start',
        attended: true,
        onBehalfOfUserId: 'removed-member-1',
      });
      expect(result.ok && result.open.initiatingMemberId).toBe('booker-1');
      expect(mockFindBooker).toHaveBeenCalledTimes(1);
    });

    it('with no `onBehalfOfUserId` no membership read runs at all', async () => {
      await resolveOnBehalfOpenInput({
        meetingId: MEETING_ID,
        openedBy: 'system',
        trigger: 'billing_start',
        attended: true,
      });
      expect(mockGetMemberRole).not.toHaveBeenCalled();
    });

    it('without `onBehalfOfUserId` the booker is attributed, exactly as before', async () => {
      const result = await resolveOnBehalfOpenInput({
        meetingId: MEETING_ID,
        openedBy: 'system',
        trigger: 'billing_start',
        attended: true,
      });
      expect(result.ok && result.open.initiatingMemberId).toBe('booker-1');
      expect(mockFindBooker).toHaveBeenCalledTimes(1);
    });

    it('builds the tolerant, presence-sourced input on the booker, with the wallet PROVISIONED on `db` first', async () => {
      const result = await resolveOnBehalfOpenInput({
        meetingId: MEETING_ID,
        openedBy: 'system',
        trigger: 'lifecycle_sweep',
        attended: true,
      });

      expect(result).toEqual({
        ok: true,
        subject: SUBJECT,
        open: {
          walletId: 'wallet-1',
          companyId: 'company-1',
          expertProfileId: 'expert-1',
          initiatingMemberId: 'booker-1',
          estimatedMinutes: 30,
          meetingId: MEETING_ID,
          engagementId: 'engagement-1',
          durationSource: 'presence',
          fundingPolicy: 'overdraft_tolerant',
          openedBy: 'system',
          trigger: 'lifecycle_sweep',
        },
      });
      // D7.5 — `ensureForCompany(db, companyId)`, never a `wallet_missing` refusal.
      expect(mockEnsureForCompany).toHaveBeenCalledWith(DB, 'company-1');
      // D5.6 — coherence only.
      expect(mockResolveSubject).toHaveBeenCalledWith(MEETING_ID, { requireActive: false });
    });

    it('carries the admitted guest’s id for a guest open', async () => {
      const result = await resolveOnBehalfOpenInput({
        meetingId: MEETING_ID,
        openedBy: 'guest',
        meetingGuestId: 'guest-1',
        trigger: 'guest_admission',
        attended: true,
      });
      expect(result.ok && result.open).toMatchObject({
        openedBy: 'guest',
        meetingGuestId: 'guest-1',
      });
    });

    it('takes the window from the caller when it already holds the row — no second meeting read', async () => {
      await resolveOnBehalfOpenInput({
        meetingId: MEETING_ID,
        openedBy: 'system',
        trigger: 'backstop',
        attended: true,
        window: { scheduledStart: START, scheduledEnd: new Date(START.getTime() + 45 * 60_000) },
      });
      expect(mockMeetingFindById).not.toHaveBeenCalled();
    });

    it('a meeting that does not resolve to a billable case is `meeting_not_bookable` with no company', async () => {
      mockResolveSubject.mockResolvedValue(undefined);
      await expect(
        resolveOnBehalfOpenInput({
          meetingId: MEETING_ID,
          openedBy: 'system',
          trigger: 'backstop',
          attended: true,
        })
      ).resolves.toEqual({ ok: false, code: 'meeting_not_bookable', companyId: null });
      expect(mockFindBooker).not.toHaveBeenCalled();
      expect(mockEnsureForCompany).not.toHaveBeenCalled();
    });

    it('⚠ a NULL or missing booker is a REFUSAL — and no wallet is provisioned for it', async () => {
      mockFindBooker.mockResolvedValue(null);
      await expect(
        resolveOnBehalfOpenInput({
          meetingId: MEETING_ID,
          openedBy: 'system',
          trigger: 'backstop',
          attended: true,
        })
      ).resolves.toEqual({ ok: false, code: 'booker_unattributable', companyId: 'company-1' });
      expect(mockEnsureForCompany).not.toHaveBeenCalled();
    });

    it('a meeting that vanished between the subject read and the window read is `meeting_not_bookable`', async () => {
      mockMeetingFindById.mockResolvedValue(undefined);
      await expect(
        resolveOnBehalfOpenInput({
          meetingId: MEETING_ID,
          openedBy: 'system',
          trigger: 'backstop',
          attended: true,
        })
      ).resolves.toEqual({ ok: false, code: 'meeting_not_bookable', companyId: 'company-1' });
    });

    describe('⚠ D10.5 — a non-active case bills only if it was closed AT OR AFTER the meeting’s scheduled start', () => {
      const CLOSED_SUBJECT = { ...SUBJECT, isActive: false };
      // An UNATTENDED call (a no-show): the only kind a closure voids (D12.1c).
      const run = () =>
        resolveOnBehalfOpenInput({
          meetingId: MEETING_ID,
          openedBy: 'system',
          trigger: 'backstop',
          attended: false,
        });
      const runAttended = () =>
        resolveOnBehalfOpenInput({
          meetingId: MEETING_ID,
          openedBy: 'system',
          trigger: 'backstop',
          attended: true,
        });

      it('⚠ D12.1(c) — an ATTENDED call bills whatever the case’s status: closed before the start, with no close instant, or a day early', async () => {
        for (const closedAt of [
          new Date(START.getTime() - 1),
          null,
          new Date(START.getTime() - 86_400_000),
        ]) {
          mockResolveSubject.mockResolvedValue({ ...CLOSED_SUBJECT, closedAt });
          await expect(runAttended()).resolves.toMatchObject({ ok: true });
        }
      });

      it('an ATTENDED call on an ACTIVE case bills too (the attended flag never blocks a billable open)', async () => {
        mockResolveSubject.mockResolvedValue(SUBJECT);
        await expect(runAttended()).resolves.toMatchObject({ ok: true });
      });

      it('closed AFTER the start (the client resolved it while the expert waited) ⇒ still billable', async () => {
        mockResolveSubject.mockResolvedValue({
          ...CLOSED_SUBJECT,
          closedAt: new Date(START.getTime() + 60_000),
        });
        await expect(run()).resolves.toMatchObject({ ok: true });
      });

      it('closed EXACTLY at the start ⇒ billable (the boundary is inclusive)', async () => {
        mockResolveSubject.mockResolvedValue({ ...CLOSED_SUBJECT, closedAt: START });
        await expect(run()).resolves.toMatchObject({ ok: true });
      });

      it('closed one millisecond BEFORE the start ⇒ `case_closed_before_start`, and nothing else is read', async () => {
        mockResolveSubject.mockResolvedValue({
          ...CLOSED_SUBJECT,
          closedAt: new Date(START.getTime() - 1),
        });
        await expect(run()).resolves.toEqual({
          ok: false,
          code: 'case_closed_before_start',
          companyId: 'company-1',
        });
        expect(mockFindBooker).not.toHaveBeenCalled();
        expect(mockEnsureForCompany).not.toHaveBeenCalled();
      });

      it('a non-active case that records NO close instant ⇒ `case_closed_before_start` (never billed on a guess)', async () => {
        mockResolveSubject.mockResolvedValue({ ...CLOSED_SUBJECT, closedAt: null });
        await expect(run()).resolves.toMatchObject({ ok: false, code: 'case_closed_before_start' });
      });

      it('an ACTIVE case never consults the close instant', async () => {
        mockResolveSubject.mockResolvedValue({ ...SUBJECT, closedAt: new Date(0) });
        await expect(run()).resolves.toMatchObject({ ok: true });
      });

      it('the guest path surfaces the same code', async () => {
        mockResolveSubject.mockResolvedValue({
          ...CLOSED_SUBJECT,
          closedAt: new Date(START.getTime() - 1),
        });
        await expect(
          openSessionOnBehalfOfBooker({
            meetingId: MEETING_ID,
            openedBy: 'guest',
            meetingGuestId: 'guest-1',
            guestInvitedById: 'inviter-1',
          })
        ).resolves.toEqual({ ok: false, code: 'case_closed_before_start', companyId: 'company-1' });
        expect(mockOpen).not.toHaveBeenCalled();
      });
    });

    it('the GUARD runs after the subject resolves and BEFORE the booker / wallet reads (D5.9)', async () => {
      const guard = vi.fn().mockResolvedValue('expert_invited_guest');
      await expect(
        resolveOnBehalfOpenInput({
          meetingId: MEETING_ID,
          openedBy: 'system',
          trigger: 'backstop',
          attended: true,
          guard,
        })
      ).resolves.toEqual({ ok: false, code: 'expert_invited_guest', companyId: 'company-1' });
      expect(guard).toHaveBeenCalledWith(SUBJECT);
      expect(mockFindBooker).not.toHaveBeenCalled();
      expect(mockEnsureForCompany).not.toHaveBeenCalled();
    });

    it('a guard that passes (undefined) lets the resolution continue', async () => {
      const result = await resolveOnBehalfOpenInput({
        meetingId: MEETING_ID,
        openedBy: 'system',
        trigger: 'backstop',
        attended: true,
        guard: vi.fn().mockResolvedValue(undefined),
      });
      expect(result.ok).toBe(true);
    });
  });

  describe('openSessionOnBehalfOfBooker (a client-side email guest’s admission)', () => {
    const INPUT = {
      meetingId: MEETING_ID,
      openedBy: 'guest',
      meetingGuestId: 'guest-1',
      guestInvitedById: 'inviter-1',
    } as const;

    it('opens through the repository with the tolerant guest input and returns the session id and tolerated gates', async () => {
      mockOpen.mockResolvedValue({
        ok: true,
        session: { id: 'session-1' },
        toleratedGates: ['negative_balance'],
      });

      await expect(openSessionOnBehalfOfBooker(INPUT)).resolves.toEqual({
        ok: true,
        sessionId: 'session-1',
        toleratedGates: ['negative_balance'],
      });
      expect(mockOpen).toHaveBeenCalledWith(
        expect.objectContaining({
          initiatingMemberId: 'booker-1',
          openedBy: 'guest',
          meetingGuestId: 'guest-1',
          fundingPolicy: 'overdraft_tolerant',
          durationSource: 'presence',
          trigger: 'guest_admission',
        })
      );
    });

    it('⚠ D5.9 — a guest INVITED BY THE DELIVERING EXPERT opens nothing', async () => {
      mockFindUserIdByProfileId.mockResolvedValue({ user: { id: 'inviter-1' } });

      await expect(openSessionOnBehalfOfBooker(INPUT)).resolves.toEqual({
        ok: false,
        code: 'expert_invited_guest',
        companyId: 'company-1',
      });
      expect(mockOpen).not.toHaveBeenCalled();
      expect(mockFindUserIdByProfileId).toHaveBeenCalledWith('expert-1');
    });

    it('a guest invited by anyone else passes the guard', async () => {
      mockOpen.mockResolvedValue({ ok: true, session: { id: 'session-1' }, toleratedGates: [] });
      await expect(openSessionOnBehalfOfBooker(INPUT)).resolves.toMatchObject({ ok: true });
    });

    it('a guest row with no inviter never looks the expert up', async () => {
      mockOpen.mockResolvedValue({ ok: true, session: { id: 'session-1' }, toleratedGates: [] });
      await openSessionOnBehalfOfBooker({ ...INPUT, guestInvitedById: null });
      expect(mockFindUserIdByProfileId).not.toHaveBeenCalled();
    });

    it('a missing expert user never trips the guard', async () => {
      mockFindUserIdByProfileId.mockResolvedValue(undefined);
      mockOpen.mockResolvedValue({ ok: true, session: { id: 'session-1' }, toleratedGates: [] });
      await expect(openSessionOnBehalfOfBooker(INPUT)).resolves.toMatchObject({ ok: true });
    });

    it.each([
      [
        'meeting_session_exists',
        { ok: false, code: 'meeting_session_exists', existingSessionId: 's' },
      ],
      ['session_in_progress', { ok: false, code: 'session_in_progress' }],
      ['expert_rate_missing', { ok: false, code: 'expert_rate_missing' }],
    ] as const)(
      'maps the repository refusal %s onto the result with the billing company',
      async (code, refusal) => {
        mockOpen.mockResolvedValue(refusal);
        await expect(openSessionOnBehalfOfBooker(INPUT)).resolves.toEqual({
          ok: false,
          code,
          companyId: 'company-1',
        });
      }
    );

    it.each(['account_hold', 'settlement_pending', 'insufficient_no_mandate'] as const)(
      'a GATED refusal (%s) is unreachable under the tolerant policy — it THROWS (a programming error), never a silent no-op',
      async (code) => {
        mockOpen.mockResolvedValue({ ok: false, code });
        await expect(openSessionOnBehalfOfBooker(INPUT)).rejects.toThrow(
          `on-behalf open returned a gated refusal: ${code}`
        );
      }
    );

    it('a subject / booker refusal is passed through without touching the repository', async () => {
      mockFindBooker.mockResolvedValue(null);
      await expect(openSessionOnBehalfOfBooker(INPUT)).resolves.toEqual({
        ok: false,
        code: 'booker_unattributable',
        companyId: 'company-1',
      });
      expect(mockOpen).not.toHaveBeenCalled();
    });

    it('the open throwing propagates — the caller’s contract is that a join is never failed, so IT catches', async () => {
      mockOpen.mockRejectedValue(new Error('db unavailable'));
      await expect(openSessionOnBehalfOfBooker(INPUT)).rejects.toThrow('db unavailable');
    });
  });
});
