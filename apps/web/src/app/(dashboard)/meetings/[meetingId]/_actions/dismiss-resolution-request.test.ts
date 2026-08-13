import { describe, it, expect, vi, beforeEach } from 'vitest';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const USER_ID = 'b0000000-0000-4000-8000-000000000002';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';
const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000005';

vi.mock('server-only', () => ({}));

const mockClear = vi.fn();
vi.mock('@balo/db', () => ({
  caseEngagementsRepository: {
    clearResolutionRequest: (...args: unknown[]) => mockClear(...args),
  },
}));

const mockRequireOnboardedUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireOnboardedUser(),
}));

const mockHasCapability = vi.fn();
vi.mock('@/lib/authz', () => ({
  hasCapability: (...args: unknown[]) => mockHasCapability(...args),
  CAPABILITIES: { PARTICIPATE: 'participate' },
}));

const mockResolveAccess = vi.fn();
vi.mock('@/lib/meetings/resolve-recap-access', () => ({
  resolveRecapAccess: (...args: unknown[]) => mockResolveAccess(...args),
}));

const mockRevalidate = vi.fn();
vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidate(...args),
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublish(...args),
}));

const mockTrack = vi.fn();
// ⚠ THE CONSTANTS COME FROM SOURCE, NOT A HAND-RESTATED LITERAL. `apps/web/src/test/setup.ts`
// sets the precedent ("so the mock stays in sync with source"): a rename in
// `packages/analytics/src/events/recap.ts` must fail HERE rather than leave a green suite
// asserting an event name nothing emits.
vi.mock('@/lib/analytics/server', async () => {
  const events = await import('@balo/analytics/events');
  return {
    trackServerAndFlush: (...args: unknown[]) => mockTrack(...args),
    RECAP_SERVER_EVENTS: events.RECAP_SERVER_EVENTS,
  };
});

import { dismissResolutionRequestAction } from './dismiss-resolution-request';
import { log } from '@/lib/logging';

const CASE_ACCESS = {
  lens: 'client',
  meeting: {
    id: MEETING_ID,
    // The gate projects these two through for `resolveCaseAction`'s post-call guard. Dismissal
    // deliberately does NOT consult them — see the assertion at the bottom of this file.
    scheduledStart: new Date('2026-08-12T09:00:00.000Z'),
    status: 'scheduled',
  },
  subject: { contextType: 'case', contextId: ENGAGEMENT_ID },
  companyId: COMPANY_ID,
  expertProfileId: 'd0000000-0000-4000-8000-000000000004',
};

const INPUT = { meetingId: MEETING_ID };

describe('dismissResolutionRequestAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID });
    mockResolveAccess.mockResolvedValue(CASE_ACCESS);
    mockHasCapability.mockResolvedValue(true);
    mockClear.mockResolvedValue({ engagementId: ENGAGEMENT_ID, resolutionRequestedAt: null });
  });

  it('rejects when not signed in, before the gate runs', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await dismissResolutionRequestAction(INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockResolveAccess).not.toHaveBeenCalled();
  });

  it('rejects an un-onboarded user (mutations require requireOnboardedUser)', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Onboarding not completed'));
    const result = await dismissResolutionRequestAction(INPUT);
    expect(result.success).toBe(false);
    expect(mockClear).not.toHaveBeenCalled();
  });

  it('rejects a malformed meetingId before the gate', async () => {
    const result = await dismissResolutionRequestAction({ meetingId: 'nope' });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockResolveAccess).not.toHaveBeenCalled();
  });

  it('rejects a gate denial with generic copy and never writes', async () => {
    mockResolveAccess.mockResolvedValue(null);
    const result = await dismissResolutionRequestAction(INPUT);
    expect(result).toEqual({ success: false, error: 'This recap is no longer available.' });
    expect(mockClear).not.toHaveBeenCalled();
  });

  it('rejects the EXPERT lens', async () => {
    mockResolveAccess.mockResolvedValue({ ...CASE_ACCESS, lens: 'expert' });
    const result = await dismissResolutionRequestAction(INPUT);
    expect(result.success).toBe(false);
    expect(mockClear).not.toHaveBeenCalled();
  });

  it('rejects a NON-case context', async () => {
    mockResolveAccess.mockResolvedValue({
      ...CASE_ACCESS,
      subject: { contextType: 'project_kickoff', contextId: ENGAGEMENT_ID },
    });
    const result = await dismissResolutionRequestAction(INPUT);
    expect(result.success).toBe(false);
    expect(mockClear).not.toHaveBeenCalled();
  });

  it("resolves the capability on the MEMBERSHIP axis, with the GATE's companyId", async () => {
    await dismissResolutionRequestAction(INPUT);
    expect(mockHasCapability).toHaveBeenCalledWith({ id: USER_ID }, 'participate', {
      companyId: COMPANY_ID,
    });
  });

  it('rejects when the capability check fails, and never writes', async () => {
    mockHasCapability.mockResolvedValue(false);
    const result = await dismissResolutionRequestAction(INPUT);
    expect(result.success).toBe(false);
    expect(mockClear).not.toHaveBeenCalled();
  });

  it('clears the request using the ENGAGEMENT ID FROM THE GATE, never from input', async () => {
    const result = await dismissResolutionRequestAction(INPUT);
    expect(result).toEqual({ success: true });
    expect(mockClear).toHaveBeenCalledWith({ engagementId: ENGAGEMENT_ID });
  });

  it('leaves the case OPEN — it never calls close', async () => {
    await dismissResolutionRequestAction(INPUT);
    // The repository mock exposes ONLY `clearResolutionRequest`; a `close()` call would throw.
    expect(mockClear).toHaveBeenCalledTimes(1);
  });

  it('publishes NOTHING — dismissal is silent (owner decision D-E)', async () => {
    await dismissResolutionRequestAction(INPUT);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('tracks the dismissal with the meeting and engagement ids', async () => {
    await dismissResolutionRequestAction(INPUT);
    expect(mockTrack).toHaveBeenCalledWith('case_resolution_request_dismissed', {
      meeting_id: MEETING_ID,
      engagement_id: ENGAGEMENT_ID,
      distinct_id: USER_ID,
    });
  });

  it('revalidates the recap path so the banner does not survive the refresh', async () => {
    await dismissResolutionRequestAction(INPUT);
    expect(mockRevalidate).toHaveBeenCalledWith('/meetings/' + MEETING_ID);
  });

  // ⚠ NAMED FOR WHAT IT ACTUALLY PROVES. The repository mock always returns a row, so this
  // cannot fail on idempotency — it proves the ACTION re-runs cleanly and, decisively, that a
  // second dismissal still publishes NOTHING (owner decision D-E). The real idempotency proof
  // is `case-engagements.integration.test.ts` against live Postgres.
  it('re-runs cleanly and still publishes NOTHING on a second dismissal', async () => {
    await dismissResolutionRequestAction(INPUT);
    const second = await dismissResolutionRequestAction(INPUT);
    expect(second).toEqual({ success: true });
    expect(mockClear).toHaveBeenCalledTimes(2);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('refuses a case context that names no expert, with the SAME denial literal', async () => {
    // `engagements.expert_profile_id` is NOT NULL, so this cannot happen on a case — which is
    // exactly why the gate narrows it once instead of every caller carrying a dead `!== null`
    // branch. The narrowing collapses into the one denial copy, never a distinct message.
    mockResolveAccess.mockResolvedValue({ ...CASE_ACCESS, expertProfileId: null });
    const result = await dismissResolutionRequestAction(INPUT);
    expect(result).toEqual({ success: false, error: 'This recap is no longer available.' });
    expect(mockClear).not.toHaveBeenCalled();
  });

  it('reports a closed case as unavailable rather than pretending to succeed', async () => {
    mockClear.mockResolvedValue(undefined);
    const result = await dismissResolutionRequestAction(INPUT);
    expect(result).toEqual({ success: false, error: 'This case is no longer open.' });
  });

  it('logs and returns friendly copy when the write throws', async () => {
    mockClear.mockRejectedValue(new Error('boom'));
    const result = await dismissResolutionRequestAction(INPUT);
    expect(result).toEqual({ success: false, error: 'Something went wrong. Please try again.' });
    expect(log.error).toHaveBeenCalled();
  });

  /**
   * BAL-389 SECURITY FIX — SCOPE. `resolveCaseAction` now refuses a close when the consultation
   * has not taken place. That guard is deliberately NOT in the SHARED gate, so dismissal keeps
   * working on a future or cancelled meeting.
   *
   * ⚠ THIS IS A DELIBERATE NON-EXTENSION, NOT AN OVERSIGHT. Dismissal clears two columns and
   * leaves the case OPEN — its outcome is indistinguishable from doing nothing — so it is not one
   * of the two CONSEQUENTIAL controls the finding concerns, and tightening a third control would
   * be scope the ruling did not ask for. If that judgement is ever revisited, this test is the
   * one to change, and the guard belongs in `authorizeRecapCaseMutation` at that point.
   */
  it('is NOT gated by the post-call rule — a future or cancelled meeting still dismisses', async () => {
    for (const meeting of [
      { id: MEETING_ID, scheduledStart: new Date('2099-01-01T09:00:00.000Z'), status: 'scheduled' },
      { id: MEETING_ID, scheduledStart: new Date('2026-08-12T09:00:00.000Z'), status: 'cancelled' },
    ]) {
      mockClear.mockClear();
      mockResolveAccess.mockResolvedValue({ ...CASE_ACCESS, meeting });
      expect(await dismissResolutionRequestAction(INPUT), meeting.status).toEqual({
        success: true,
      });
      expect(mockClear).toHaveBeenCalledWith({ engagementId: ENGAGEMENT_ID });
    }
  });
});
