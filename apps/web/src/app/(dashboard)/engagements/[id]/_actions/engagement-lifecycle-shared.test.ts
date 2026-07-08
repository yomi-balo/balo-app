import { describe, it, expect, vi, beforeEach } from 'vitest';

const ENGAGEMENT_ID = 'a0000000-0000-4000-8000-000000000001';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockResolveLens = vi.fn();
vi.mock('@/lib/engagement/resolve-engagement-lens', () => ({
  resolveEngagementLens: (...a: unknown[]) => mockResolveLens(...a),
}));

const { mockFindEngagement, MilestonesIncompleteError, InvalidEngagementTransitionError } =
  vi.hoisted(() => {
    class MilestonesIncompleteError extends Error {}
    class InvalidEngagementTransitionError extends Error {}
    return {
      mockFindEngagement: vi.fn(),
      MilestonesIncompleteError,
      InvalidEngagementTransitionError,
    };
  });

vi.mock('@balo/db', () => ({
  engagementsRepository: {
    findEngagementWithMilestones: (...a: unknown[]) => mockFindEngagement(...a),
  },
  companiesRepository: { findOwnerByCompanyId: vi.fn() },
  MilestonesIncompleteError,
  InvalidEngagementTransitionError,
  EngagementNotActiveError: class extends Error {},
  InvalidMilestoneTransitionError: class extends Error {},
}));

import {
  gateExpertEngagement,
  gateAdminEngagement,
  runEngagementLifecycleAction,
  type EngagementActionResult,
} from './engagement-lifecycle-shared';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const USER = { id: 'user-1', platformRole: 'user' } as never;

function engagement(status = 'active') {
  return { id: ENGAGEMENT_ID, status, milestones: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindEngagement.mockResolvedValue(engagement('active'));
  mockResolveLens.mockReturnValue({ lens: 'expert' });
});

describe('gateExpertEngagement', () => {
  it('returns NOT_FOUND when the engagement is missing', async () => {
    mockFindEngagement.mockResolvedValue(undefined);
    const res = await gateExpertEngagement(USER, ENGAGEMENT_ID, 'active');
    expect(res).toEqual({ ok: false, error: 'This engagement could not be found.' });
  });

  it('returns NOT_FOUND for a stranger (null lens) — no existence leak', async () => {
    mockResolveLens.mockReturnValue(null);
    const res = await gateExpertEngagement(USER, ENGAGEMENT_ID, 'active');
    expect(res).toEqual({ ok: false, error: 'This engagement could not be found.' });
  });

  it('returns ONLY_EXPERT for a non-expert lens', async () => {
    mockResolveLens.mockReturnValue({ lens: 'admin' });
    const res = await gateExpertEngagement(USER, ENGAGEMENT_ID, 'active');
    expect(res).toEqual({ ok: false, error: 'Only the delivering expert can do that.' });
  });

  it('returns NOT_ACTIVE when requiredStatus is active but the engagement is under review', async () => {
    mockFindEngagement.mockResolvedValue(engagement('pending_acceptance'));
    const res = await gateExpertEngagement(USER, ENGAGEMENT_ID, 'active');
    expect(res).toEqual({ ok: false, error: "This project isn't active." });
  });

  it('returns NOT_UNDER_REVIEW when requiredStatus is pending_acceptance but the engagement is active', async () => {
    const res = await gateExpertEngagement(USER, ENGAGEMENT_ID, 'pending_acceptance');
    expect(res).toEqual({ ok: false, error: "This project isn't under review." });
  });

  it('passes for the expert lens on the required status', async () => {
    const res = await gateExpertEngagement(USER, ENGAGEMENT_ID, 'active');
    expect(res.ok).toBe(true);
  });
});

describe('gateAdminEngagement', () => {
  it('returns ONLY_ADMIN for a non-admin lens', async () => {
    mockResolveLens.mockReturnValue({ lens: 'expert' });
    const res = await gateAdminEngagement(USER, ENGAGEMENT_ID);
    expect(res).toEqual({ ok: false, error: 'Only Balo can cancel an engagement.' });
  });

  it('returns ENGAGEMENT_CLOSED for a terminal engagement', async () => {
    mockResolveLens.mockReturnValue({ lens: 'admin' });
    mockFindEngagement.mockResolvedValue(engagement('cancelled'));
    const res = await gateAdminEngagement(USER, ENGAGEMENT_ID);
    expect(res).toEqual({ ok: false, error: 'This engagement is already closed.' });
  });

  it.each(['active', 'pending_acceptance'] as const)(
    'passes for the admin lens on a cancellable %s engagement',
    async (status) => {
      mockResolveLens.mockReturnValue({ lens: 'admin' });
      mockFindEngagement.mockResolvedValue(engagement(status));
      const res = await gateAdminEngagement(USER, ENGAGEMENT_ID);
      expect(res.ok).toBe(true);
    }
  );
});

describe('runEngagementLifecycleAction', () => {
  const ok = { ok: true as const, engagement: engagement('active') as never };
  const perform = (result: EngagementActionResult) => () => Promise.resolve(result);

  it('returns the authorize error and does NOT revalidate when the gate fails', async () => {
    const res = await runEngagementLifecycleAction(
      ENGAGEMENT_ID,
      {},
      'fail',
      () => Promise.resolve({ ok: false, error: 'nope' }),
      perform({ success: true })
    );
    expect(res).toEqual({ success: false, error: 'nope' });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('revalidates on a successful perform', async () => {
    const res = await runEngagementLifecycleAction(
      ENGAGEMENT_ID,
      {},
      'fail',
      () => Promise.resolve(ok),
      perform({ success: true })
    );
    expect(res).toEqual({ success: true });
    expect(revalidatePath).toHaveBeenCalledWith(`/engagements/${ENGAGEMENT_ID}`);
  });

  it('does NOT revalidate when perform reports a typed-race failure result', async () => {
    const res = await runEngagementLifecycleAction(
      ENGAGEMENT_ID,
      {},
      'fail',
      () => Promise.resolve(ok),
      perform({ success: false, error: 'race' })
    );
    expect(res).toEqual({ success: false, error: 'race' });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('maps a thrown MilestonesIncompleteError to MILESTONES_INCOMPLETE without logging an error', async () => {
    const res = await runEngagementLifecycleAction(
      ENGAGEMENT_ID,
      {},
      'fail',
      () => Promise.resolve(ok),
      () => {
        throw new MilestonesIncompleteError('x');
      }
    );
    expect(res).toEqual({
      success: false,
      error:
        'Not every milestone is complete yet — finish them before sending the project for review.',
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('maps a thrown InvalidEngagementTransitionError to STATUS_CHANGED', async () => {
    const res = await runEngagementLifecycleAction(
      ENGAGEMENT_ID,
      {},
      'fail',
      () => Promise.resolve(ok),
      () => {
        throw new InvalidEngagementTransitionError('x');
      }
    );
    expect(res).toEqual({
      success: false,
      error: "This project's status changed. Refresh and try again.",
    });
  });

  it('maps an unexpected throw to GENERIC_FAILURE and logs it under failLabel', async () => {
    const res = await runEngagementLifecycleAction(
      ENGAGEMENT_ID,
      { userId: 'user-1' },
      'Failed to do the thing',
      () => Promise.resolve(ok),
      () => {
        throw new Error('boom');
      }
    );
    expect(res).toEqual({ success: false, error: 'Something went wrong. Please try again.' });
    expect(log.error).toHaveBeenCalledWith('Failed to do the thing', expect.any(Object));
  });
});
