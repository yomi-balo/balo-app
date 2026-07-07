import { describe, it, expect, vi, beforeEach } from 'vitest';

const ENGAGEMENT_ID = 'a0000000-0000-4000-8000-000000000001';
const MILESTONE_ID = 'b0000000-0000-4000-8000-000000000002';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireUser: () => mockRequireUser(),
}));

const mockResolveLens = vi.fn();
vi.mock('@/lib/engagement/resolve-engagement-lens', () => ({
  resolveEngagementLens: (...args: unknown[]) => mockResolveLens(...args),
}));

const {
  mockFindEngagement,
  mockFindOwner,
  EngagementNotActiveError,
  InvalidMilestoneTransitionError,
} = vi.hoisted(() => {
  class EngagementNotActiveError extends Error {}
  class InvalidMilestoneTransitionError extends Error {}
  return {
    mockFindEngagement: vi.fn(),
    mockFindOwner: vi.fn(),
    EngagementNotActiveError,
    InvalidMilestoneTransitionError,
  };
});

vi.mock('@balo/db', () => ({
  engagementsRepository: {
    findEngagementWithMilestones: (...a: unknown[]) => mockFindEngagement(...a),
  },
  companiesRepository: { findOwnerByCompanyId: (...a: unknown[]) => mockFindOwner(...a) },
  EngagementNotActiveError,
  InvalidMilestoneTransitionError,
}));

import { revalidatePath } from 'next/cache';
import {
  authorizeExpertMilestone,
  requireExpertUser,
  resolveClientRecipientId,
  runExpertMilestoneAction,
  runMilestoneTransition,
  deriveEngagementTitle,
  formatCompletedOn,
} from './milestone-action-shared';
import type { EngagementParties } from '@/lib/engagement/engagement-parties';

const USER = {
  id: 'user-1',
  companyId: 'other-company',
  expertProfileId: 'ep-1',
  platformRole: 'user',
} as unknown as Parameters<typeof authorizeExpertMilestone>[0];

function milestone(overrides: Record<string, unknown> = {}) {
  return {
    id: MILESTONE_ID,
    title: 'Discovery',
    status: 'pending',
    startedAt: null,
    completedAt: null,
    completionNote: null,
    updatedAt: new Date('2026-06-30T00:00:00Z'),
    ...overrides,
  };
}

function engagement(overrides: Record<string, unknown> = {}) {
  return {
    id: ENGAGEMENT_ID,
    status: 'active',
    company: { id: COMPANY_ID, name: 'Northwind Industrial' },
    projectRequest: { id: 'req-1', title: 'CPQ implementation' },
    milestones: [milestone()],
    ...overrides,
  };
}

const EXPERT_CTX = {
  lens: 'expert',
  archetype: 'participant',
  isClientOwner: false,
  isDeliveringExpert: true,
};

function parties(overrides: Partial<EngagementParties> = {}): EngagementParties {
  return {
    isAgencyExpert: false,
    expertPerson: 'Priya Sharma',
    expertPersonShort: 'Priya',
    expertParty: 'Priya Sharma',
    expertPartyShort: 'Priya',
    expertHeadline: null,
    expertRetroFirstMention: 'Priya',
    clientCompanyName: 'Northwind Industrial',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindEngagement.mockResolvedValue(engagement());
  mockResolveLens.mockReturnValue(EXPERT_CTX);
});

describe('authorizeExpertMilestone', () => {
  it('returns NOT_FOUND when the engagement is missing (no existence leak)', async () => {
    mockFindEngagement.mockResolvedValue(undefined);
    const res = await authorizeExpertMilestone(USER, ENGAGEMENT_ID, MILESTONE_ID, 'pending');
    expect(res).toEqual({ ok: false, error: 'This engagement could not be found.' });
  });

  it('returns NOT_FOUND for a stranger (lens resolves to null)', async () => {
    mockResolveLens.mockReturnValue(null);
    const res = await authorizeExpertMilestone(USER, ENGAGEMENT_ID, MILESTONE_ID, 'pending');
    expect(res).toEqual({ ok: false, error: 'This engagement could not be found.' });
  });

  it('returns ONLY_EXPERT for a non-expert lens (incl. an admin who delivers)', async () => {
    mockResolveLens.mockReturnValue({ ...EXPERT_CTX, lens: 'admin', isDeliveringExpert: true });
    const res = await authorizeExpertMilestone(USER, ENGAGEMENT_ID, MILESTONE_ID, 'pending');
    expect(res).toEqual({
      ok: false,
      error: 'Only the delivering expert can update milestones.',
    });
  });

  it('returns ENGAGEMENT_LOCKED when the engagement is not active', async () => {
    mockFindEngagement.mockResolvedValue(engagement({ status: 'pending_acceptance' }));
    const res = await authorizeExpertMilestone(USER, ENGAGEMENT_ID, MILESTONE_ID, 'pending');
    expect(res).toEqual({
      ok: false,
      error: 'The delivery plan is locked while the project is in review.',
    });
  });

  it('returns MILESTONE_GONE for an IDOR milestoneId not in the engagement', async () => {
    const res = await authorizeExpertMilestone(
      USER,
      ENGAGEMENT_ID,
      'd0000000-0000-4000-8000-000000000999',
      'pending'
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no longer part of this engagement/);
  });

  it('returns STALE_TRANSITION when the milestone status differs from expected', async () => {
    mockFindEngagement.mockResolvedValue(
      engagement({ milestones: [milestone({ status: 'in_progress' })] })
    );
    const res = await authorizeExpertMilestone(USER, ENGAGEMENT_ID, MILESTONE_ID, 'pending');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/changed since you loaded the page/);
  });

  it('returns ok with the engagement + milestone on the happy path', async () => {
    const res = await authorizeExpertMilestone(USER, ENGAGEMENT_ID, MILESTONE_ID, 'pending');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.milestone.id).toBe(MILESTONE_ID);
      expect(res.engagement.id).toBe(ENGAGEMENT_ID);
    }
  });
});

describe('runMilestoneTransition', () => {
  it('maps EngagementNotActiveError → ENGAGEMENT_LOCKED', async () => {
    const res = await runMilestoneTransition(() => {
      throw new EngagementNotActiveError('x');
    });
    expect(res).toEqual({
      ok: false,
      error: 'The delivery plan is locked while the project is in review.',
    });
  });

  it('maps InvalidMilestoneTransitionError → STALE_TRANSITION', async () => {
    const res = await runMilestoneTransition(() => {
      throw new InvalidMilestoneTransitionError('x');
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/changed since you loaded the page/);
  });

  it('rethrows any other error to the caller boundary', async () => {
    await expect(
      runMilestoneTransition(() => {
        throw new Error('db down');
      })
    ).rejects.toThrow('db down');
  });

  it('returns the value on success', async () => {
    const res = await runMilestoneTransition(async () => 42);
    expect(res).toEqual({ ok: true, value: 42 });
  });
});

describe('requireExpertUser', () => {
  it('returns the user when signed in', async () => {
    mockRequireUser.mockResolvedValue({ id: 'user-1' });
    expect(await requireExpertUser()).toEqual({ ok: true, user: { id: 'user-1' } });
  });

  it('returns NOT_SIGNED_IN when requireUser throws', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await requireExpertUser()).toEqual({ ok: false, error: 'You are not signed in.' });
  });
});

describe('resolveClientRecipientId', () => {
  it('returns the owner id on success', async () => {
    mockFindOwner.mockResolvedValue({ id: 'owner-1' });
    expect(await resolveClientRecipientId(COMPANY_ID)).toBe('owner-1');
  });

  it('returns undefined when the owner lookup throws (never propagates)', async () => {
    mockFindOwner.mockRejectedValue(new Error('no owner'));
    expect(await resolveClientRecipientId(COMPANY_ID)).toBeUndefined();
  });
});

describe('deriveEngagementTitle', () => {
  it('uses the source request title when present', () => {
    expect(deriveEngagementTitle(engagement() as never, parties())).toBe('CPQ implementation');
  });

  it('falls back to "Delivery with {expert}" for a retainer (no request)', () => {
    expect(deriveEngagementTitle(engagement({ projectRequest: null }) as never, parties())).toBe(
      'Delivery with Priya'
    );
  });

  it('falls back when the request title is blank', () => {
    expect(
      deriveEngagementTitle(
        engagement({ projectRequest: { id: 'r', title: '   ' } }) as never,
        parties()
      )
    ).toBe('Delivery with Priya');
  });
});

describe('formatCompletedOn', () => {
  it('formats a date as "30 Jun 2026" (UTC en-GB)', () => {
    expect(formatCompletedOn(new Date('2026-06-30T12:00:00Z'))).toBe('30 Jun 2026');
  });
});

describe('runExpertMilestoneAction', () => {
  it('revalidates on a successful perform and returns its result', async () => {
    const perform = vi.fn().mockResolvedValue({
      success: true,
      milestoneId: MILESTONE_ID,
      status: 'in_progress',
    });
    const res = await runExpertMilestoneAction(
      USER,
      { engagementId: ENGAGEMENT_ID, milestoneId: MILESTONE_ID },
      'pending',
      'Failed to start milestone',
      perform
    );
    expect(res).toEqual({ success: true, milestoneId: MILESTONE_ID, status: 'in_progress' });
    expect(revalidatePath).toHaveBeenCalledWith(`/engagements/${ENGAGEMENT_ID}`);
  });

  it('does NOT revalidate when perform returns a failure', async () => {
    const perform = vi.fn().mockResolvedValue({ success: false, error: 'nope' });
    const res = await runExpertMilestoneAction(
      USER,
      { engagementId: ENGAGEMENT_ID, milestoneId: MILESTONE_ID },
      'pending',
      'Failed to start milestone',
      perform
    );
    expect(res).toEqual({ success: false, error: 'nope' });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('short-circuits to the authorize error without calling perform', async () => {
    mockFindEngagement.mockResolvedValue(undefined);
    const perform = vi.fn();
    const res = await runExpertMilestoneAction(
      USER,
      { engagementId: ENGAGEMENT_ID, milestoneId: MILESTONE_ID },
      'pending',
      'Failed to start milestone',
      perform
    );
    expect(res).toEqual({ success: false, error: 'This engagement could not be found.' });
    expect(perform).not.toHaveBeenCalled();
  });

  it('maps a thrown error inside perform to GENERIC_FAILURE', async () => {
    const perform = vi.fn().mockRejectedValue(new Error('boom'));
    const res = await runExpertMilestoneAction(
      USER,
      { engagementId: ENGAGEMENT_ID, milestoneId: MILESTONE_ID },
      'pending',
      'Failed to start milestone',
      perform
    );
    expect(res).toEqual({ success: false, error: 'Something went wrong. Please try again.' });
  });
});
