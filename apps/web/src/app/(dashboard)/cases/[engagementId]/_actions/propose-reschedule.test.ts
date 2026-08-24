import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ENGAGEMENT_CAPABILITIES } from '@balo/shared/authz';

/**
 * BAL-411 — unit tests for the EXPERT's propose/withdraw actions: the SECOND `apps/web`
 * consumer of the ENGAGEMENT-capability axis (`request-resolution.test.ts` is the first).
 *
 * ⚠⚠ TWO AXES, NEVER FOLDED. `authorizeCaseMutation` discharges the READ obligation, then the
 * LENS assertion runs before the engagement axis is consulted at all — the same order
 * `request-resolution.test.ts` pins for the sibling ask.
 */

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';
const MEETING_ID = 'a0000000-0000-4000-8000-000000000002';
const USER_ID = 'a0000000-0000-4000-8000-000000000003';
const COMPANY_ID = 'a0000000-0000-4000-8000-000000000004';
const EXPERT_PROFILE_ID = 'a0000000-0000-4000-8000-000000000005';
const PROPOSAL_ID = 'a0000000-0000-4000-8000-000000000006';
const OPTION_ID = 'a0000000-0000-4000-8000-000000000007';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockFindWithContexts = vi.fn();
const mockListAdminUserIds = vi.fn();
vi.mock('@balo/db', () => ({
  meetingsRepository: { findWithContexts: (...a: unknown[]) => mockFindWithContexts(...a) },
  partyMembershipsRepository: { listAdminUserIds: (...a: unknown[]) => mockListAdminUserIds(...a) },
}));

const mockRequireOnboardedUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireOnboardedUser(),
}));

const mockAuthorizeCaseMutation = vi.fn();
vi.mock('../_lib/authorize-case-mutation', () => ({
  authorizeCaseMutation: (...a: unknown[]) => mockAuthorizeCaseMutation(...a),
}));

const mockHasEngagementCapability = vi.fn();
vi.mock('@/lib/authz/engagement', () => ({
  hasEngagementCapability: (...a: unknown[]) => mockHasEngagementCapability(...a),
}));

const mockResolveNotificationLabels = vi.fn();
vi.mock('../_lib/reschedule-notification-labels', () => ({
  resolveNotificationLabels: (...a: unknown[]) => mockResolveNotificationLabels(...a),
}));

const mockPostProposeReschedule = vi.fn();
const mockPostWithdrawRescheduleProposal = vi.fn();
vi.mock('@/lib/meetings/reschedule-proposal-api-client', () => ({
  postProposeReschedule: (...a: unknown[]) => mockPostProposeReschedule(...a),
  postWithdrawRescheduleProposal: (...a: unknown[]) => mockPostWithdrawRescheduleProposal(...a),
}));

const mockPublishNotificationEvent = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => mockPublishNotificationEvent(...a),
}));

import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';
import { proposeRescheduleAction, withdrawRescheduleProposalAction } from './propose-reschedule';

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
    lens: 'expert',
    caseRow: { title: 'Salesforce integration' },
    ...overrides,
  };
}

const PROPOSE_INPUT = {
  engagementId: ENGAGEMENT_ID,
  meetingId: MEETING_ID,
  optionStartIsos: ['2026-09-02T10:00:00.000Z'],
};

const WITHDRAW_INPUT = {
  engagementId: ENGAGEMENT_ID,
  meetingId: MEETING_ID,
  proposalId: PROPOSAL_ID,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID });
  mockAuthorizeCaseMutation.mockResolvedValue(gateOk());
  mockHasEngagementCapability.mockResolvedValue(true);
  mockFindWithContexts.mockResolvedValue(meetingWithContexts());
  mockListAdminUserIds.mockResolvedValue(['admin-1']);
  mockResolveNotificationLabels.mockResolvedValue({
    clientCompanyName: 'Northwind Industrial',
    expertPartyLabel: 'CloudPeak',
    expertPersonLabel: 'Dana Reyes @ CloudPeak',
  });
  mockPostProposeReschedule.mockResolvedValue({
    ok: true,
    data: {
      proposalId: PROPOSAL_ID,
      meetingId: MEETING_ID,
      expiresAtIso: '2026-09-01T09:00:00.000Z',
      options: [
        {
          optionId: OPTION_ID,
          scheduledStart: '2026-09-02T10:00:00.000Z',
          scheduledEnd: '2026-09-02T10:45:00.000Z',
          position: 0,
        },
      ],
    },
  });
  mockPostWithdrawRescheduleProposal.mockResolvedValue({
    ok: true,
    data: { proposalId: PROPOSAL_ID, status: 'withdrawn' },
  });
});

describe('proposeRescheduleAction — the two gates, in order', () => {
  it('calls requireOnboardedUser() FIRST', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('not onboarded'));
    const result = await proposeRescheduleAction(PROPOSE_INPUT);
    expect(result).toEqual({
      success: false,
      code: 'unauthenticated',
      error: 'You are not signed in.',
    });
    expect(mockAuthorizeCaseMutation).not.toHaveBeenCalled();
  });

  it('rejects a bad payload (too many options) before touching the gate', async () => {
    const result = await proposeRescheduleAction({
      ...PROPOSE_INPUT,
      optionStartIsos: ['a', 'b', 'c', 'd'],
    });
    expect(result).toEqual({ success: false, code: 'invalid_request', error: 'Invalid request.' });
    expect(mockAuthorizeCaseMutation).not.toHaveBeenCalled();
  });

  // Item 19 (security LOW) — `optionStartIsos` is now `z.iso.datetime()`, matching every other
  // id on this action being shape-checked (`z.uuid()`) instead of a bare non-empty string.
  it('rejects a well-sized array of non-ISO-datetime strings', async () => {
    const result = await proposeRescheduleAction({
      ...PROPOSE_INPUT,
      optionStartIsos: ['not-a-datetime'],
    });
    expect(result).toEqual({ success: false, code: 'invalid_request', error: 'Invalid request.' });
    expect(mockAuthorizeCaseMutation).not.toHaveBeenCalled();
  });

  it('the case gate denial short-circuits', async () => {
    mockAuthorizeCaseMutation.mockResolvedValue({
      ok: false,
      error: 'This case is no longer available.',
    });
    const result = await proposeRescheduleAction(PROPOSE_INPUT);
    expect(result).toEqual({
      success: false,
      code: 'not_permitted',
      error: 'This case is no longer available.',
    });
    expect(mockPostProposeReschedule).not.toHaveBeenCalled();
  });

  it('REFUSES the CLIENT lens, before the engagement axis is consulted at all', async () => {
    mockAuthorizeCaseMutation.mockResolvedValue(gateOk({ lens: 'client' }));
    const result = await proposeRescheduleAction(PROPOSE_INPUT);
    expect(result.success).toBe(false);
    expect(mockHasEngagementCapability).not.toHaveBeenCalled();
    expect(mockPostProposeReschedule).not.toHaveBeenCalled();
  });

  it('gates on MANAGE_ENGAGEMENT with a subject derived from the gate, never supplied', async () => {
    await proposeRescheduleAction(PROPOSE_INPUT);
    expect(mockHasEngagementCapability).toHaveBeenCalledWith(
      { id: USER_ID },
      ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT,
      { contextType: 'case', contextId: ENGAGEMENT_ID }
    );
  });

  it('REFUSES when the engagement axis says no — the agency-role-`expert` path', async () => {
    mockHasEngagementCapability.mockResolvedValue(false);
    const result = await proposeRescheduleAction(PROPOSE_INPUT);
    expect(result.success).toBe(false);
    expect(mockPostProposeReschedule).not.toHaveBeenCalled();
  });
});

describe('proposeRescheduleAction — B3, the meeting↔engagement binding proof', () => {
  it('refuses when the meeting has no live "case" context matching engagementId', async () => {
    mockFindWithContexts.mockResolvedValue(
      meetingWithContexts({ contexts: [{ contextType: 'case', contextId: 'some-other-case' }] })
    );
    const result = await proposeRescheduleAction(PROPOSE_INPUT);
    expect(result).toEqual({
      success: false,
      code: 'meeting_not_found',
      error: "We couldn't find that consultation.",
    });
    expect(mockPostProposeReschedule).not.toHaveBeenCalled();
  });

  it('404s when the meeting itself does not resolve', async () => {
    mockFindWithContexts.mockResolvedValue(undefined);
    const result = await proposeRescheduleAction(PROPOSE_INPUT);
    expect(result).toEqual({
      success: false,
      code: 'meeting_not_found',
      error: "We couldn't find that consultation.",
    });
  });
});

describe('proposeRescheduleAction — the write and its publish', () => {
  it('posts the option ISOs to the api and revalidates on success', async () => {
    const result = await proposeRescheduleAction(PROPOSE_INPUT);
    expect(mockPostProposeReschedule).toHaveBeenCalledWith(MEETING_ID, {
      options: [{ scheduledStart: '2026-09-02T10:00:00.000Z' }],
    });
    expect(result).toEqual({
      success: true,
      proposalId: PROPOSAL_ID,
      meetingId: MEETING_ID,
      expiresAtIso: '2026-09-01T09:00:00.000Z',
      options: [
        {
          optionId: OPTION_ID,
          scheduledStart: '2026-09-02T10:00:00.000Z',
          scheduledEnd: '2026-09-02T10:45:00.000Z',
          position: 0,
        },
      ],
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/cases/${ENGAGEMENT_ID}`);
  });

  it('publishes reschedule_proposal.sent keyed on the proposalId, with the resolved labels', async () => {
    await proposeRescheduleAction(PROPOSE_INPUT);
    expect(mockPublishNotificationEvent).toHaveBeenCalledWith(
      'reschedule_proposal.sent',
      expect.objectContaining({
        correlationId: PROPOSAL_ID,
        proposalId: PROPOSAL_ID,
        meetingId: MEETING_ID,
        engagementId: ENGAGEMENT_ID,
        recipientUserIds: ['admin-1'],
        expertPartyLabel: 'CloudPeak',
        expertPersonLabel: 'Dana Reyes @ CloudPeak',
        clientCompanyName: 'Northwind Industrial',
        caseTitle: 'Salesforce integration',
        optionStartIsos: ['2026-09-02T10:00:00.000Z'],
        expiresAtIso: '2026-09-01T09:00:00.000Z',
      })
    );
  });

  // Item 5 — `hoursToStart` must be the EXACT fractional value, never `hoursBetween`'s
  // rounded one. `rules.ts` gates the <2h SMS arm on `hoursToStart < 2`; a real "1h50m before
  // the call" propose (1.8333h) must NOT round up to 2 and silently disarm SMS in exactly the
  // band the arm exists for.
  it('publishes a FRACTIONAL hoursToStart, never rounded', async () => {
    vi.useFakeTimers();
    try {
      // Meeting starts 2026-09-01T09:00:00.000Z; "now" is 1h50m before it.
      vi.setSystemTime(new Date('2026-09-01T07:10:00.000Z'));
      await proposeRescheduleAction(PROPOSE_INPUT);
    } finally {
      vi.useRealTimers();
    }
    expect(mockPublishNotificationEvent).toHaveBeenCalledWith(
      'reschedule_proposal.sent',
      expect.objectContaining({ hoursToStart: expect.closeTo(11 / 6, 10) })
    );
  });

  // Item 7 — a `published` row that reaches nobody is the worst possible shape. Mirrors the
  // `scheduling/reschedule-proposal.ts` recheck's own rule at the FIRST publish.
  it('skips the publish and warns when the client company has zero live recipients', async () => {
    mockListAdminUserIds.mockResolvedValue([]);
    const result = await proposeRescheduleAction(PROPOSE_INPUT);
    expect(result.success).toBe(true);
    expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('no live recipient'),
      expect.objectContaining({ meetingId: MEETING_ID, engagementId: ENGAGEMENT_ID })
    );
  });

  it('maps a proposal_already_pending 409 to its own code and copy', async () => {
    mockPostProposeReschedule.mockResolvedValue({
      ok: false,
      status: 409,
      code: 'proposal_already_pending',
    });
    const result = await proposeRescheduleAction(PROPOSE_INPUT);
    expect(result).toEqual({
      success: false,
      code: 'proposal_already_pending',
      error: 'You already have a proposal waiting on this consultation.',
    });
    expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('maps a window_not_available 409 to slot_unavailable', async () => {
    mockPostProposeReschedule.mockResolvedValue({
      ok: false,
      status: 409,
      code: 'window_not_available',
    });
    const result = await proposeRescheduleAction(PROPOSE_INPUT);
    expect(result).toEqual({
      success: false,
      code: 'slot_unavailable',
      error: 'One of those times was just taken.',
    });
  });

  it('maps a case_closed 409 to its own code', async () => {
    mockPostProposeReschedule.mockResolvedValue({ ok: false, status: 409, code: 'case_closed' });
    const result = await proposeRescheduleAction(PROPOSE_INPUT);
    expect(result).toEqual({
      success: false,
      code: 'case_closed',
      error: 'This case is no longer open.',
    });
  });
});

describe('withdrawRescheduleProposalAction', () => {
  it('REFUSES the CLIENT lens before touching the api', async () => {
    mockAuthorizeCaseMutation.mockResolvedValue(gateOk({ lens: 'client' }));
    const result = await withdrawRescheduleProposalAction(WITHDRAW_INPUT);
    expect(result.success).toBe(false);
    expect(mockPostWithdrawRescheduleProposal).not.toHaveBeenCalled();
  });

  it('withdraws and revalidates — and publishes NOTHING (§D5)', async () => {
    const result = await withdrawRescheduleProposalAction(WITHDRAW_INPUT);
    expect(result).toEqual({ success: true, proposalId: PROPOSAL_ID });
    expect(revalidatePath).toHaveBeenCalledWith(`/cases/${ENGAGEMENT_ID}`);
    expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
  });

  it('maps a proposal_not_answerable 409 (client already accepted)', async () => {
    mockPostWithdrawRescheduleProposal.mockResolvedValue({
      ok: false,
      status: 409,
      code: 'proposal_not_answerable',
    });
    const result = await withdrawRescheduleProposalAction(WITHDRAW_INPUT);
    expect(result).toEqual({
      success: false,
      code: 'proposal_not_answerable',
      error: 'This proposal has already been answered.',
    });
  });

  it('logs and returns friendly copy when an unexpected error is thrown', async () => {
    mockPostWithdrawRescheduleProposal.mockRejectedValue(new Error('boom'));
    const result = await withdrawRescheduleProposalAction(WITHDRAW_INPUT);
    expect(result).toEqual({
      success: false,
      code: 'unknown',
      error: 'Something went wrong. Please try again.',
    });
    expect(log.error).toHaveBeenCalled();
  });
});
