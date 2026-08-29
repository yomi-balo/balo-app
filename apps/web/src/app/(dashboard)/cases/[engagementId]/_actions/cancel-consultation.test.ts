import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CAPABILITIES, ENGAGEMENT_CAPABILITIES } from '@balo/shared/authz';

/**
 * BAL-410 — unit tests for `cancelConsultationAction`.
 *
 * ⚠⚠ TWO AXES, SELECTED BY LENS, NEVER FOLDED. The client arm is MEMBERSHIP (`participate`) and
 * the expert arm is ENGAGEMENT (`manage_engagement`). `lens` alone is never authorization — it
 * chooses WHICH axis to ask, and the capability call answers. Both directions are pinned below,
 * including the case that motivates the expert term at all: an agency member with role `expert`
 * can SEE the whole surface (visibility is deliberately wider — ADR-1046 §7) and must still be
 * refused here.
 */

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';
const OTHER_ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000009';
const MEETING_ID = 'a0000000-0000-4000-8000-000000000002';
const USER_ID = 'a0000000-0000-4000-8000-000000000003';
const COMPANY_ID = 'a0000000-0000-4000-8000-000000000004';
const EXPERT_PROFILE_ID = 'a0000000-0000-4000-8000-000000000005';
const AUDIT_ID = 'a0000000-0000-4000-8000-000000000006';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockFindWithContexts = vi.fn();
vi.mock('@balo/db', () => ({
  meetingsRepository: { findWithContexts: (...a: unknown[]) => mockFindWithContexts(...a) },
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
}));

const mockHasEngagementCapability = vi.fn();
vi.mock('@/lib/authz/engagement', () => ({
  hasEngagementCapability: (...a: unknown[]) => mockHasEngagementCapability(...a),
}));

const mockPostCancelMeeting = vi.fn();
vi.mock('@/lib/meetings/cancel-api-client', () => ({
  postCancelMeeting: (...a: unknown[]) => mockPostCancelMeeting(...a),
}));

import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';
import { cancelConsultationAction } from './cancel-consultation';

function boundMeeting(contextId = ENGAGEMENT_ID): unknown {
  return {
    meeting: { id: MEETING_ID },
    contexts: [{ contextType: 'case', contextId }],
  };
}

function apiOk(overrides: Record<string, unknown> = {}): unknown {
  return {
    ok: true,
    data: {
      meetingId: MEETING_ID,
      status: 'cancelled',
      scheduledStart: '2026-09-01T09:00:00.000Z',
      cancelAuditId: AUDIT_ID,
      initiatedBy: 'client',
      holdReleased: false,
      ...overrides,
    },
  };
}

const INPUT = { engagementId: ENGAGEMENT_ID, meetingId: MEETING_ID };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID });
  mockAuthorizeCaseMutation.mockResolvedValue({
    ok: true,
    lens: 'client',
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    caseRow: { title: 'Flow automation review' },
  });
  mockHasCapability.mockResolvedValue(true);
  mockHasEngagementCapability.mockResolvedValue(true);
  mockFindWithContexts.mockResolvedValue(boundMeeting());
  mockPostCancelMeeting.mockResolvedValue(apiOk());
});

// ── The gate ──────────────────────────────────────────────────────────────────

describe('cancelConsultationAction — the gate', () => {
  it('refuses an unauthenticated caller with its OWN code, not a generic not_permitted', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Unauthorized'));

    const result = await cancelConsultationAction(INPUT);

    expect(result).toEqual({
      success: false,
      code: 'unauthenticated',
      error: 'You are not signed in.',
    });
    expect(mockPostCancelMeeting).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-uuid engagementId', { engagementId: 'nope', meetingId: MEETING_ID }],
    ['a non-uuid meetingId', { engagementId: ENGAGEMENT_ID, meetingId: 'nope' }],
    // `.strict()` — an extra field is a refusal, not a silently-stripped no-op.
    ['an extra field', { ...INPUT, reason: 'expert_time_off' }],
  ])('refuses %s', async (_label, input) => {
    const result = await cancelConsultationAction(input as never);

    expect(result).toMatchObject({ success: false, code: 'invalid_request' });
    expect(mockPostCancelMeeting).not.toHaveBeenCalled();
  });

  it('refuses when the case gate itself denies', async () => {
    mockAuthorizeCaseMutation.mockResolvedValue({ ok: false, error: 'No access to this case.' });

    const result = await cancelConsultationAction(INPUT);

    expect(result).toEqual({
      success: false,
      code: 'not_permitted',
      error: 'No access to this case.',
    });
  });
});

// ── The CLIENT axis — membership ──────────────────────────────────────────────

describe('cancelConsultationAction — the CLIENT arm asks the MEMBERSHIP axis', () => {
  it('asks `participate` against the gate’s company, and NOT the engagement axis', async () => {
    await cancelConsultationAction(INPUT);

    expect(mockHasCapability).toHaveBeenCalledWith({ id: USER_ID }, CAPABILITIES.PARTICIPATE, {
      companyId: COMPANY_ID,
    });
    expect(mockHasEngagementCapability).not.toHaveBeenCalled();
  });

  it('refuses a client-lens actor without `participate`', async () => {
    mockHasCapability.mockResolvedValue(false);

    const result = await cancelConsultationAction(INPUT);

    expect(result).toEqual({
      success: false,
      code: 'not_permitted',
      error: "You don't have permission to cancel this consultation.",
    });
    expect(mockPostCancelMeeting).not.toHaveBeenCalled();
  });
});

// ── The EXPERT axis — engagement ──────────────────────────────────────────────

describe('cancelConsultationAction — the EXPERT arm asks the ENGAGEMENT axis', () => {
  beforeEach(() => {
    mockAuthorizeCaseMutation.mockResolvedValue({
      ok: true,
      lens: 'expert',
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      caseRow: { title: 'Flow automation review' },
    });
  });

  it('asks `manage_engagement` on the case context, and NOT the membership axis', async () => {
    await cancelConsultationAction(INPUT);

    expect(mockHasEngagementCapability).toHaveBeenCalledWith(
      { id: USER_ID },
      ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT,
      { contextType: 'case', contextId: ENGAGEMENT_ID }
    );
    expect(mockHasCapability).not.toHaveBeenCalled();
  });

  /**
   * ⚠ THE CASE THAT MOTIVATES THE CAPABILITY TERM AT ALL. An agency member with role `expert`
   * resolves the EXPERT lens (visibility is deliberately wider — ADR-1046 §7) but is NOT a
   * `manage_engagement` holder. Without this check they would get a dead-end button.
   */
  it('refuses an expert-lens actor who is NOT a manage_engagement holder', async () => {
    mockHasEngagementCapability.mockResolvedValue(false);

    const result = await cancelConsultationAction(INPUT);

    expect(result).toMatchObject({ success: false, code: 'not_permitted' });
    expect(mockPostCancelMeeting).not.toHaveBeenCalled();
  });
});

// ── B3 — the meeting↔engagement binding proof ─────────────────────────────────

describe('cancelConsultationAction — the meeting must belong to the engagement', () => {
  /**
   * ⚠ TWO GATES, TWO SUBJECTS, AND NOTHING JOINING THEM WITHOUT THIS. A caller could otherwise
   * submit `{engagementId: A, meetingId: B}` — two cases they can each reach on their own — and
   * cancel B while this action revalidates A's page.
   */
  it('refuses a meetingId bound to a DIFFERENT engagement', async () => {
    mockFindWithContexts.mockResolvedValue(boundMeeting(OTHER_ENGAGEMENT_ID));

    const result = await cancelConsultationAction(INPUT);

    expect(result).toMatchObject({ success: false, code: 'meeting_not_found' });
    expect(mockPostCancelMeeting).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('does not belong to engagementId'),
      expect.objectContaining({ meetingId: MEETING_ID, engagementId: ENGAGEMENT_ID })
    );
  });

  it('refuses a meeting that does not exist', async () => {
    mockFindWithContexts.mockResolvedValue(undefined);

    const result = await cancelConsultationAction(INPUT);

    expect(result).toMatchObject({ success: false, code: 'meeting_not_found' });
  });
});

// ── The api hop ───────────────────────────────────────────────────────────────

describe('cancelConsultationAction — api failure mapping', () => {
  it.each([
    [401, 'unauthenticated', 'unauthenticated'],
    [400, 'invalid_request', 'invalid_request'],
    [404, 'meeting_not_found', 'meeting_not_found'],
    [409, 'meeting_not_cancellable', 'meeting_not_cancellable'],
    [429, 'rate_limited', 'rate_limited'],
    [500, 'something_else', 'unknown'],
  ])('maps %s/%s → %s', async (status, code, expected) => {
    mockPostCancelMeeting.mockResolvedValue({ ok: false, status, code });

    const result = await cancelConsultationAction(INPUT);

    expect(result).toMatchObject({ success: false, code: expected });
    // ⚠ Never a raw server literal on the wire back to the user.
    expect(result).not.toMatchObject({ error: code });
  });

  it('logs the api hop failure at the caught boundary', async () => {
    mockPostCancelMeeting.mockResolvedValue({ ok: false, status: 500, code: 'boom' });

    await cancelConsultationAction(INPUT);

    expect(log.error).toHaveBeenCalledWith(
      'Cancel api hop failed',
      expect.objectContaining({ meetingId: MEETING_ID, status: 500 })
    );
  });

  it('maps an unexpected THROW to `unknown` and logs it', async () => {
    mockPostCancelMeeting.mockRejectedValue(new Error('socket hang up'));

    const result = await cancelConsultationAction(INPUT);

    expect(result).toMatchObject({ success: false, code: 'unknown' });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to cancel consultation',
      expect.objectContaining({ meetingId: MEETING_ID })
    );
  });
});

// ── Success ───────────────────────────────────────────────────────────────────

describe('cancelConsultationAction — success', () => {
  it('revalidates the case page and returns the SERVER’s values', async () => {
    mockPostCancelMeeting.mockResolvedValue(apiOk({ initiatedBy: 'client', holdReleased: true }));

    const result = await cancelConsultationAction(INPUT);

    expect(result).toEqual({
      success: true,
      scheduledStart: '2026-09-01T09:00:00.000Z',
      initiatedBy: 'client',
      holdReleased: true,
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/cases/${ENGAGEMENT_ID}`);
  });

  /**
   * ⚠ `initiatedBy` IS THE API'S ARM, NEVER RE-DERIVED FROM THE LENS. The api resolves it from
   * whichever authorization arm matched; re-deriving it here would let the analytics funnel
   * disagree with the audit row about who cancelled.
   */
  it('passes the API’s `initiatedBy` through even when it disagrees with the lens', async () => {
    mockPostCancelMeeting.mockResolvedValue(apiOk({ initiatedBy: 'admin' }));

    const result = await cancelConsultationAction(INPUT);

    expect(result).toMatchObject({ success: true, initiatedBy: 'admin' });
  });

  it('logs the business event with the arm and the hold outcome', async () => {
    mockPostCancelMeeting.mockResolvedValue(apiOk({ holdReleased: true }));

    await cancelConsultationAction(INPUT);

    expect(log.info).toHaveBeenCalledWith(
      'Consultation cancelled',
      expect.objectContaining({
        meetingId: MEETING_ID,
        userId: USER_ID,
        initiatedBy: 'client',
        holdReleased: true,
      })
    );
  });

  it('sends an EMPTY body — `reason` and `initiatedBy` are server decisions', async () => {
    await cancelConsultationAction(INPUT);

    expect(mockPostCancelMeeting).toHaveBeenCalledWith(MEETING_ID);
    expect(mockPostCancelMeeting).toHaveBeenCalledTimes(1);
  });
});
