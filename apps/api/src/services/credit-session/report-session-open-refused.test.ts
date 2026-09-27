import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockFindWalletByCompanyId,
  mockTrackServer,
  mockRaiseAdminAlert,
  mockCaptureException,
  mockLogError,
  mockLogWarn,
} = vi.hoisted(() => ({
  mockFindWalletByCompanyId: vi.fn(),
  mockTrackServer: vi.fn(),
  mockRaiseAdminAlert: vi.fn(),
  mockCaptureException: vi.fn(),
  mockLogError: vi.fn(),
  mockLogWarn: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockLogWarn,
    error: mockLogError,
  }),
}));
vi.mock('@sentry/node', () => ({ captureException: mockCaptureException }));
vi.mock('@balo/db', () => ({
  creditWalletsRepository: { findByCompanyId: mockFindWalletByCompanyId },
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  SESSION_SERVER_EVENTS: { SESSION_OPEN_REFUSED: 'session_open_refused' },
}));
vi.mock('../admin-alerts/raise.js', () => ({ raiseAdminAlert: mockRaiseAdminAlert }));

import {
  ADMISSION_OPEN_DEFERRED_MESSAGES,
  ADMISSION_OPEN_THREW_MSG,
  SESSION_OPEN_REFUSED_MESSAGES,
  reportAdmissionOpenDeferred,
  reportAdmissionOpenOutcome,
  reportSessionOpenRefused,
} from './report-session-open-refused.js';

const FIELDS = {
  meetingId: 'meeting-1',
  companyId: 'company-1',
  userId: 'user-1',
  openedBy: 'client',
} as const;

describe('report-session-open-refused (BAL-466 → BAL-474, D7.6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindWalletByCompanyId.mockResolvedValue({ id: 'wallet-1' });
    mockRaiseAdminAlert.mockResolvedValue(undefined);
  });

  describe('the message maps are pinned VERBATIM (an operator reads these)', () => {
    it('ADMISSION_OPEN_DEFERRED_MESSAGES — recoverable reasons, one stem', () => {
      expect(ADMISSION_OPEN_DEFERRED_MESSAGES).toEqual({
        wallet_busy:
          "Credit session not opened at admission — this company wallet already has a live session on another meeting; the meeting's terminal path opens and settles it (ADR-1040 Amendment 7 §D)",
        forbidden:
          "Credit session not opened at admission — the joining member lacks CONSUME_CREDITS on the billing company; the meeting's terminal path opens and settles it on behalf of the booker (ADR-1040 Amendment 7 §D)",
        wallet_missing:
          "Credit session not opened at admission — the company has no credit wallet yet; the meeting's terminal path provisions it, then opens and settles the session (ADR-1040 Amendment 7 §D)",
        meeting_not_bookable:
          "Credit session not opened at admission — the meeting did not resolve to an active case engagement; the meeting's terminal path re-checks coherence only and settles it if the engagement exists (ADR-1040 Amendment 7 §D)",
      });
    });

    it('ADMISSION_OPEN_THREW_MSG', () => {
      expect(ADMISSION_OPEN_THREW_MSG).toBe(
        "Credit session open threw at admission — no session opened; the meeting's terminal path opens and settles it (ADR-1040 Amendment 7 §D)"
      );
    });

    it('SESSION_OPEN_REFUSED_MESSAGES — the alerting reasons, admission and terminal', () => {
      expect(SESSION_OPEN_REFUSED_MESSAGES).toEqual({
        admission: {
          expert_rate_missing:
            'Credit session refused at admission — the delivering expert has no rate set; if a rate is set before this meeting ends, its terminal path bills it, otherwise that path refuses it and alarms again',
        },
        terminal: {
          expert_rate_missing:
            'Credit session refused when the meeting ended — the delivering expert has no rate set; this consultation is unbilled and the expert is unpaid',
          meeting_not_bookable:
            'Credit session refused when the meeting ended — the meeting did not resolve to a billable case engagement; this consultation is unbilled and the expert is unpaid',
          booker_unattributable:
            'Credit session refused — the meeting has no attributable booker (an unattributed meeting.booked row); no session was opened on their behalf, this consultation is unbilled and the expert is unpaid',
          retry_exhausted:
            'Credit session refused — the sessionless Case meeting could not be opened and settled within the retry window; this consultation is unbilled and the expert is unpaid',
        },
      });
    });
  });

  describe('reportAdmissionOpenDeferred — recoverable, so a truthful warn and NO alert', () => {
    it.each(['wallet_busy', 'forbidden', 'wallet_missing', 'meeting_not_bookable'] as const)(
      '%s → warn + analytics recovered_by_terminal_path: true; no Sentry, no admin alert',
      async (reason) => {
        await reportAdmissionOpenDeferred(reason, FIELDS);

        expect(mockLogWarn).toHaveBeenCalledWith(
          expect.objectContaining({ meetingId: 'meeting-1', reason, walletId: 'wallet-1' }),
          ADMISSION_OPEN_DEFERRED_MESSAGES[reason]
        );
        expect(mockTrackServer).toHaveBeenCalledWith('session_open_refused', {
          meeting_id: 'meeting-1',
          company_id: 'company-1',
          wallet_id: 'wallet-1',
          reason,
          opened_by: 'client',
          recovered_by_terminal_path: true,
          distinct_id: 'company-1',
        });
        expect(mockCaptureException).not.toHaveBeenCalled();
        expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
        expect(mockLogError).not.toHaveBeenCalled();
      }
    );

    it('a failed diagnostic wallet lookup degrades to wallet_id: null and never throws', async () => {
      mockFindWalletByCompanyId.mockRejectedValue(new Error('db down'));
      await expect(reportAdmissionOpenDeferred('wallet_busy', FIELDS)).resolves.toBeUndefined();
      expect(mockTrackServer).toHaveBeenCalledWith(
        'session_open_refused',
        expect.objectContaining({ wallet_id: null })
      );
    });

    it('an unresolved company skips the wallet read and falls the distinct id back to the meeting', async () => {
      await reportAdmissionOpenDeferred('meeting_not_bookable', {
        ...FIELDS,
        companyId: null,
        openedBy: 'guest',
      });
      expect(mockFindWalletByCompanyId).not.toHaveBeenCalled();
      expect(mockTrackServer).toHaveBeenCalledWith('session_open_refused', {
        meeting_id: 'meeting-1',
        company_id: null,
        wallet_id: null,
        reason: 'meeting_not_bookable',
        opened_by: 'guest',
        recovered_by_terminal_path: true,
        distinct_id: 'meeting-1',
      });
    });
  });

  describe('reportSessionOpenRefused — the ONE writer of the `session.open_refused` alert', () => {
    it('ADMISSION expert_rate_missing → error + Sentry + analytics (not recovered) + an alert titled for admission', async () => {
      await reportSessionOpenRefused('expert_rate_missing', FIELDS);

      const message = SESSION_OPEN_REFUSED_MESSAGES.admission.expert_rate_missing;
      expect(mockLogError).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'expert_rate_missing', openedBy: 'client' }),
        message
      );
      expect(mockCaptureException).toHaveBeenCalledWith(new Error(message), {
        extra: expect.objectContaining({ meetingId: 'meeting-1', openedBy: 'client' }),
      });
      expect(mockTrackServer).toHaveBeenCalledWith(
        'session_open_refused',
        expect.objectContaining({ recovered_by_terminal_path: false, opened_by: 'client' })
      );
      expect(mockRaiseAdminAlert).toHaveBeenCalledWith({
        kind: 'session.open_refused',
        entityType: 'meeting',
        entityId: 'meeting-1',
        detail: {
          title: 'Credit session refused at admission',
          entityLabel: 'Meeting meeting-1',
          evidence: message,
          facts: [
            ['Meeting', 'meeting-1'],
            ['Company', 'company-1'],
            ['Wallet', 'wallet-1'],
            ['Reason', 'expert_rate_missing'],
            ['Opened by', 'client'],
          ],
        },
      });
    });

    it('a GUEST opener is titled for guest admission', async () => {
      await reportSessionOpenRefused('expert_rate_missing', { ...FIELDS, openedBy: 'guest' });
      expect(mockRaiseAdminAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: expect.objectContaining({ title: 'Credit session refused at guest admission' }),
        })
      );
    });

    it.each([
      'expert_rate_missing',
      'meeting_not_bookable',
      'booker_unattributable',
      'retry_exhausted',
    ] as const)(
      'a SYSTEM opener reports %s with the TERMINAL message and title',
      async (reason) => {
        await reportSessionOpenRefused(reason, {
          ...FIELDS,
          userId: null,
          openedBy: 'system',
        });

        const message = SESSION_OPEN_REFUSED_MESSAGES.terminal[reason];
        expect(mockLogError).toHaveBeenCalledWith(expect.objectContaining({ reason }), message);
        expect(mockRaiseAdminAlert).toHaveBeenCalledWith(
          expect.objectContaining({
            detail: expect.objectContaining({
              title: 'Credit session refused when the meeting ended',
              evidence: message,
            }),
          })
        );
      }
    );

    it('an unresolved company reads "unresolved" in the alert facts and still alerts once', async () => {
      await reportSessionOpenRefused('meeting_not_bookable', {
        ...FIELDS,
        companyId: null,
        userId: null,
        openedBy: 'system',
      });
      expect(mockRaiseAdminAlert).toHaveBeenCalledTimes(1);
      const call = mockRaiseAdminAlert.mock.calls[0]?.[0] as {
        detail: { facts: Array<[string, string]> };
      };
      expect(call.detail.facts).toContainEqual(['Company', 'unresolved']);
      expect(call.detail.facts).toContainEqual(['Wallet', 'unknown']);
    });
  });

  describe('reportAdmissionOpenOutcome — routes a reason to the right map', () => {
    it('expert_rate_missing PAGES (the one admission reason no terminal path recovers unless a rate is set in time)', async () => {
      await reportAdmissionOpenOutcome('expert_rate_missing', FIELDS);
      expect(mockRaiseAdminAlert).toHaveBeenCalledTimes(1);
    });

    it.each(['wallet_busy', 'forbidden', 'wallet_missing', 'meeting_not_bookable'] as const)(
      '%s does NOT page',
      async (reason) => {
        await reportAdmissionOpenOutcome(reason, FIELDS);
        expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
        expect(mockLogWarn).toHaveBeenCalled();
      }
    );
  });
});
