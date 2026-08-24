import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-411 — unit tests for the CLIENT's accept/decline actions. MEMBERSHIP axis, never
 * engagement — the mirror of `reschedule-consultation.test.ts`'s order, extended with the
 * proposal-specific failure vocabulary and the two new publishes (`booking.rescheduled` with
 * `initiatedBy: 'expert'`, and the net-new `reschedule_proposal.declined`).
 */

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';
const MEETING_ID = 'a0000000-0000-4000-8000-000000000002';
const AUDIT_ID = 'd0000000-0000-4000-8000-00000000000a';
const USER_ID = 'a0000000-0000-4000-8000-000000000003';
const COMPANY_ID = 'a0000000-0000-4000-8000-000000000004';
const EXPERT_PROFILE_ID = 'a0000000-0000-4000-8000-000000000005';
const PROPOSAL_ID = 'a0000000-0000-4000-8000-000000000006';
const OPTION_ID = 'a0000000-0000-4000-8000-000000000007';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockFindWithContexts = vi.fn();
const mockFindCompany = vi.fn();
const mockFindUser = vi.fn();
vi.mock('@balo/db', () => ({
  meetingsRepository: { findWithContexts: (...a: unknown[]) => mockFindWithContexts(...a) },
  companiesRepository: { findNameById: (...a: unknown[]) => mockFindCompany(...a) },
  usersRepository: { findDisplayById: (...a: unknown[]) => mockFindUser(...a) },
}));

const mockRequireOnboardedUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireOnboardedUser(),
}));

const mockAuthorizeCaseMutation = vi.fn();
vi.mock('../_lib/authorize-case-mutation', () => ({
  authorizeCaseMutation: (...a: unknown[]) => mockAuthorizeCaseMutation(...a),
}));

const mockHasCapability = vi.fn();
vi.mock('@/lib/authz', () => ({
  hasCapability: (...a: unknown[]) => mockHasCapability(...a),
  CAPABILITIES: { PARTICIPATE: 'participate' },
}));

const mockResolveNotificationLabels = vi.fn();
vi.mock('../_lib/reschedule-notification-labels', () => ({
  resolveNotificationLabels: (...a: unknown[]) => mockResolveNotificationLabels(...a),
}));

const mockPostAccept = vi.fn();
const mockPostDecline = vi.fn();
vi.mock('@/lib/meetings/reschedule-proposal-api-client', () => ({
  postAcceptRescheduleProposal: (...a: unknown[]) => mockPostAccept(...a),
  postDeclineRescheduleProposal: (...a: unknown[]) => mockPostDecline(...a),
}));

const mockPublishNotificationEvent = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => mockPublishNotificationEvent(...a),
}));

import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';
import {
  acceptRescheduleProposalAction,
  declineRescheduleProposalAction,
} from './respond-to-reschedule-proposal';

function meetingRow(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: MEETING_ID,
    scheduledStart: new Date('2026-09-01T09:00:00.000Z'),
    scheduledEnd: new Date('2026-09-01T09:45:00.000Z'),
    ...overrides,
  };
}

function meetingWithContexts(overrides: Record<string, unknown> = {}): unknown {
  return {
    meeting: meetingRow(),
    contexts: [{ contextType: 'case', contextId: ENGAGEMENT_ID }],
    ...overrides,
  };
}

function gateOk(overrides: Record<string, unknown> = {}): unknown {
  return {
    ok: true,
    user: { id: USER_ID },
    engagementId: ENGAGEMENT_ID,
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    lens: 'client',
    caseRow: { title: 'Salesforce integration' },
    ...overrides,
  };
}

const ACCEPT_INPUT = {
  engagementId: ENGAGEMENT_ID,
  meetingId: MEETING_ID,
  proposalId: PROPOSAL_ID,
  optionId: OPTION_ID,
};
const DECLINE_INPUT = {
  engagementId: ENGAGEMENT_ID,
  meetingId: MEETING_ID,
  proposalId: PROPOSAL_ID,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID });
  mockAuthorizeCaseMutation.mockResolvedValue(gateOk());
  mockHasCapability.mockResolvedValue(true);
  mockFindWithContexts.mockResolvedValue(meetingWithContexts());
  mockResolveNotificationLabels.mockResolvedValue({
    clientCompanyName: 'Northwind Industrial',
    expertPartyLabel: 'CloudPeak',
    expertPersonLabel: 'Dana Reyes @ CloudPeak',
  });
  mockFindCompany.mockResolvedValue({ name: 'Northwind Industrial' });
  mockFindUser.mockResolvedValue({ firstName: 'Priya', lastName: 'Shah' });
  mockPostAccept.mockResolvedValue({
    ok: true,
    data: {
      proposalId: PROPOSAL_ID,
      meetingId: MEETING_ID,
      scheduledStart: '2026-09-02T10:00:00.000Z',
      scheduledEnd: '2026-09-02T10:45:00.000Z',
      previousScheduledStart: '2026-09-01T09:00:00.000Z',
      previousScheduledEnd: '2026-09-01T09:45:00.000Z',
      rescheduleAuditId: AUDIT_ID,
    },
  });
  mockPostDecline.mockResolvedValue({
    ok: true,
    data: { proposalId: PROPOSAL_ID, status: 'declined' },
  });
});

describe('acceptRescheduleProposalAction — the two gates, in order', () => {
  it('calls requireOnboardedUser() FIRST', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('not onboarded'));
    const result = await acceptRescheduleProposalAction(ACCEPT_INPUT);
    expect(result).toEqual({
      success: false,
      code: 'unauthenticated',
      error: 'You are not signed in.',
    });
    expect(mockAuthorizeCaseMutation).not.toHaveBeenCalled();
  });

  it('denies the EXPERT lens — accept is client-initiated only', async () => {
    mockAuthorizeCaseMutation.mockResolvedValue(gateOk({ lens: 'expert' }));
    const result = await acceptRescheduleProposalAction(ACCEPT_INPUT);
    expect(result.success).toBe(false);
    expect(mockHasCapability).not.toHaveBeenCalled();
    expect(mockPostAccept).not.toHaveBeenCalled();
  });

  // N1 — `lens === 'client'` alone is not authorization.
  it('N1 — denies when hasCapability(PARTICIPATE) refuses, even with lens === "client"', async () => {
    mockHasCapability.mockResolvedValue(false);
    const result = await acceptRescheduleProposalAction(ACCEPT_INPUT);
    expect(result).toEqual({
      success: false,
      code: 'not_permitted',
      error: "You don't have permission to accept this proposal.",
    });
    expect(mockHasCapability).toHaveBeenCalledWith(
      { id: USER_ID },
      'participate',
      expect.objectContaining({ companyId: COMPANY_ID })
    );
    expect(mockPostAccept).not.toHaveBeenCalled();
  });
});

describe('acceptRescheduleProposalAction — B3 and the write', () => {
  it('B3 — refuses when the meeting has no live "case" context matching engagementId', async () => {
    mockFindWithContexts.mockResolvedValue(
      meetingWithContexts({ contexts: [{ contextType: 'case', contextId: 'some-other-case' }] })
    );
    const result = await acceptRescheduleProposalAction(ACCEPT_INPUT);
    expect(result).toEqual({
      success: false,
      code: 'meeting_not_found',
      error: "We couldn't find that consultation.",
    });
    expect(mockPostAccept).not.toHaveBeenCalled();
  });

  it('posts the chosen optionId and revalidates on success', async () => {
    const result = await acceptRescheduleProposalAction(ACCEPT_INPUT);
    expect(mockPostAccept).toHaveBeenCalledWith(MEETING_ID, PROPOSAL_ID, { optionId: OPTION_ID });
    expect(result).toEqual({
      success: true,
      proposalId: PROPOSAL_ID,
      scheduledStart: '2026-09-02T10:00:00.000Z',
      scheduledEnd: '2026-09-02T10:45:00.000Z',
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/cases/${ENGAGEMENT_ID}`);
  });

  it('publishes booking.rescheduled with initiatedBy: expert, keyed on the audit id', async () => {
    await acceptRescheduleProposalAction(ACCEPT_INPUT);
    expect(mockPublishNotificationEvent).toHaveBeenCalledWith(
      'booking.rescheduled',
      expect.objectContaining({
        correlationId: `${MEETING_ID}:${AUDIT_ID}`,
        meetingId: MEETING_ID,
        engagementId: ENGAGEMENT_ID,
        recipientId: USER_ID,
        expertProfileId: EXPERT_PROFILE_ID,
        clientCompanyName: 'Northwind Industrial',
        expertPartyLabel: 'CloudPeak',
        caseTitle: 'Salesforce integration',
        previousScheduledStartIso: '2026-09-01T09:00:00.000Z',
        scheduledStartIso: '2026-09-02T10:00:00.000Z',
        durationMinutes: 45,
        initiatedBy: 'expert',
      })
    );
  });

  it('warns and falls back to a window key when the API omits rescheduleAuditId', async () => {
    mockPostAccept.mockResolvedValue({
      ok: true,
      data: {
        proposalId: PROPOSAL_ID,
        meetingId: MEETING_ID,
        scheduledStart: '2026-09-02T10:00:00.000Z',
        scheduledEnd: '2026-09-02T10:45:00.000Z',
        previousScheduledStart: '2026-09-01T09:00:00.000Z',
        previousScheduledEnd: '2026-09-01T09:45:00.000Z',
        // no rescheduleAuditId
      },
    });
    const result = await acceptRescheduleProposalAction(ACCEPT_INPUT);
    expect(result.success).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('rescheduleAuditId'),
      expect.objectContaining({ meetingId: MEETING_ID, proposalId: PROPOSAL_ID })
    );
    expect(mockPublishNotificationEvent).toHaveBeenCalledWith(
      'booking.rescheduled',
      expect.objectContaining({ correlationId: `${MEETING_ID}:2026-09-02T10:00:00.000Z` })
    );
  });

  it('maps a slot-lost 409 (window_not_available) to slot_unavailable', async () => {
    mockPostAccept.mockResolvedValue({ ok: false, status: 409, code: 'window_not_available' });
    const result = await acceptRescheduleProposalAction(ACCEPT_INPUT);
    expect(result).toEqual({
      success: false,
      code: 'slot_unavailable',
      error: 'That time was just taken.',
    });
    expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
  });

  it('maps a proposal_stale 409 to its own code and copy', async () => {
    mockPostAccept.mockResolvedValue({ ok: false, status: 409, code: 'proposal_stale' });
    const result = await acceptRescheduleProposalAction(ACCEPT_INPUT);
    expect(result).toEqual({
      success: false,
      code: 'proposal_stale',
      error: 'This proposal no longer matches the booking — refresh the page.',
    });
  });
});

describe('declineRescheduleProposalAction', () => {
  it('denies the EXPERT lens', async () => {
    mockAuthorizeCaseMutation.mockResolvedValue(gateOk({ lens: 'expert' }));
    const result = await declineRescheduleProposalAction(DECLINE_INPUT);
    expect(result.success).toBe(false);
    expect(mockPostDecline).not.toHaveBeenCalled();
  });

  it('declines, revalidates, and publishes reschedule_proposal.declined with a retrospective label', async () => {
    const result = await declineRescheduleProposalAction(DECLINE_INPUT);
    expect(result).toEqual({ success: true, proposalId: PROPOSAL_ID });
    expect(revalidatePath).toHaveBeenCalledWith(`/cases/${ENGAGEMENT_ID}`);
    expect(mockPublishNotificationEvent).toHaveBeenCalledWith(
      'reschedule_proposal.declined',
      expect.objectContaining({
        correlationId: PROPOSAL_ID,
        proposalId: PROPOSAL_ID,
        meetingId: MEETING_ID,
        engagementId: ENGAGEMENT_ID,
        expertProfileId: EXPERT_PROFILE_ID,
        clientCompanyName: 'Northwind Industrial',
        caseTitle: 'Salesforce integration',
        declinedByLabel: 'Priya Shah @ Northwind Industrial',
        originalScheduledStartIso: '2026-09-01T09:00:00.000Z',
        durationMinutes: 45,
      })
    );
  });

  it('still succeeds and publishes with fallback labels when the label reads reject AFTER commit', async () => {
    mockFindCompany.mockRejectedValue(new Error('pool blip'));
    mockFindUser.mockRejectedValue(new Error('pool blip'));
    const result = await declineRescheduleProposalAction(DECLINE_INPUT);
    expect(result).toEqual({ success: true, proposalId: PROPOSAL_ID });
    expect(mockPublishNotificationEvent).toHaveBeenCalledWith(
      'reschedule_proposal.declined',
      expect.objectContaining({
        clientCompanyName: 'your company',
        declinedByLabel: 'A team member @ your company',
      })
    );
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('company name'),
      expect.objectContaining({ meetingId: MEETING_ID, proposalId: PROPOSAL_ID })
    );
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('decliner display name'),
      expect.objectContaining({ meetingId: MEETING_ID, proposalId: PROPOSAL_ID })
    );
  });

  it('maps a proposal_not_answerable 409', async () => {
    mockPostDecline.mockResolvedValue({ ok: false, status: 409, code: 'proposal_not_answerable' });
    const result = await declineRescheduleProposalAction(DECLINE_INPUT);
    expect(result).toEqual({
      success: false,
      code: 'proposal_not_answerable',
      error: 'This proposal has already been answered.',
    });
    expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
  });

  it('logs and returns friendly copy when an unexpected error is thrown', async () => {
    mockPostDecline.mockRejectedValue(new Error('boom'));
    const result = await declineRescheduleProposalAction(DECLINE_INPUT);
    expect(result).toEqual({
      success: false,
      code: 'unknown',
      error: 'Something went wrong. Please try again.',
    });
    expect(log.error).toHaveBeenCalled();
  });
});
