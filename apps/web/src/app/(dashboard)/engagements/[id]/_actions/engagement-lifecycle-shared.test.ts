import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-560 fix round 1 (security F2) — the LIVE-ROW platform gate this action now runs after its
 * synchronous session check. Mocked to GRANT by default, so every pre-existing case below still
 * exercises exactly what it did before: the session gate is still what decides them. The helper's
 * own behaviour (override revoked / widened / row suspended / non-staff role) is covered
 * exhaustively in `lib/authz/live-platform-capability.test.ts`; what the suites here pin is that
 * the action CALLS it and honours a denial.
 */
const mockActorHoldsLive = vi.fn<(userId: string, capability: string) => Promise<boolean>>(
  async () => true
);
vi.mock('@/lib/authz/live-platform-capability', () => ({
  actorHoldsPlatformCapability: (userId: string, capability: string) =>
    mockActorHoldsLive(userId, capability),
}));

const ENGAGEMENT_ID = 'a0000000-0000-4000-8000-000000000001';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockResolveLens = vi.fn();
vi.mock('@/lib/engagement/resolve-engagement-lens', () => ({
  resolveEngagementLens: (...a: unknown[]) => mockResolveLens(...a),
}));

const {
  mockFindEngagement,
  MilestonesIncompleteError,
  InvalidEngagementTransitionError,
  EngagementNotActiveError,
  ChangeOrderAlreadyOpenError,
  ChangeOrderCoherenceError,
  ChangeOrderNotFoundError,
  ChangeOrderPendingError,
  InvalidChangeOrderTransitionError,
} = vi.hoisted(() => {
  class MilestonesIncompleteError extends Error {}
  class InvalidEngagementTransitionError extends Error {}
  class EngagementNotActiveError extends Error {}
  class ChangeOrderAlreadyOpenError extends Error {}
  class ChangeOrderNotFoundError extends Error {}
  class ChangeOrderPendingError extends Error {}
  class InvalidChangeOrderTransitionError extends Error {}
  class ChangeOrderCoherenceError extends Error {
    constructor(public readonly rule: string) {
      super(rule);
    }
  }
  return {
    mockFindEngagement: vi.fn(),
    MilestonesIncompleteError,
    InvalidEngagementTransitionError,
    EngagementNotActiveError,
    ChangeOrderAlreadyOpenError,
    ChangeOrderCoherenceError,
    ChangeOrderNotFoundError,
    ChangeOrderPendingError,
    InvalidChangeOrderTransitionError,
  };
});

vi.mock('@balo/db', () => ({
  projectEngagementsRepository: {
    findWithMilestones: (...a: unknown[]) => mockFindEngagement(...a),
  },
  companiesRepository: { findOwnerByCompanyId: vi.fn() },
  MilestonesIncompleteError,
  InvalidEngagementTransitionError,
  EngagementNotActiveError,
  InvalidMilestoneTransitionError: class extends Error {},
  ChangeOrderAlreadyOpenError,
  ChangeOrderCoherenceError,
  ChangeOrderNotFoundError,
  ChangeOrderPendingError,
  InvalidChangeOrderTransitionError,
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
const BALO_USER = { id: 'balo-1', platformRole: 'admin' } as never;
const SUPER_USER = { id: 'su-1', platformRole: 'super_admin' } as never;

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
  it('returns ONLY_BALO for a caller without CANCEL_ANY_ENGAGEMENT', async () => {
    mockResolveLens.mockReturnValue({ lens: 'client' });
    const res = await gateAdminEngagement(USER, ENGAGEMENT_ID);
    expect(res).toEqual({ ok: false, error: 'Only Balo can cancel an engagement.' });
  });

  it('returns ENGAGEMENT_CLOSED for a terminal engagement', async () => {
    mockResolveLens.mockReturnValue({ lens: 'admin' });
    mockFindEngagement.mockResolvedValue(engagement('cancelled'));
    const res = await gateAdminEngagement(BALO_USER, ENGAGEMENT_ID);
    expect(res).toEqual({ ok: false, error: 'This engagement is already closed.' });
  });

  it.each(['active', 'pending_acceptance'] as const)(
    'passes for the admin lens on a cancellable %s engagement',
    async (status) => {
      mockResolveLens.mockReturnValue({ lens: 'admin' });
      mockFindEngagement.mockResolvedValue(engagement(status));
      const res = await gateAdminEngagement(BALO_USER, ENGAGEMENT_ID);
      expect(res.ok).toBe(true);
    }
  );

  it('denies a lens-admin caller who does not hold the capability — the gate reads the TOKEN, not the lens', async () => {
    mockResolveLens.mockReturnValue({ lens: 'admin' });
    const res = await gateAdminEngagement(USER, ENGAGEMENT_ID);
    expect(res).toEqual({ ok: false, error: 'Only Balo can cancel an engagement.' });
  });

  // ⚠ BAL-560/F2 — the cookie still grants; the LIVE row does not. A Server Action never runs
  // `checkSessionDrift`, so this is the only thing enforcing a revoked override on this path.
  it('BAL-560/F2: denies a super_admin whose LIVE row has revoked the override', async () => {
    mockResolveLens.mockReturnValue({ lens: 'admin' });
    mockActorHoldsLive.mockResolvedValueOnce(false);

    const res = await gateAdminEngagement(SUPER_USER, ENGAGEMENT_ID);

    expect(res).toEqual({ ok: false, error: 'Only Balo can cancel an engagement.' });
  });

  it('passes for super_admin', async () => {
    mockResolveLens.mockReturnValue({ lens: 'admin' });
    const res = await gateAdminEngagement(SUPER_USER, ENGAGEMENT_ID);
    expect(res.ok).toBe(true);
  });
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

  it.each([
    [
      'ChangeOrderAlreadyOpenError',
      () => new ChangeOrderAlreadyOpenError('x'),
      "There's already a change open on this project. You can start another once it's decided.",
    ],
    [
      'InvalidChangeOrderTransitionError',
      () => new InvalidChangeOrderTransitionError('x'),
      "This project's status changed. Refresh and try again.",
    ],
    [
      'ChangeOrderNotFoundError',
      () => new ChangeOrderNotFoundError('x'),
      "This project's status changed. Refresh and try again.",
    ],
    [
      'ChangeOrderCoherenceError (note_missing)',
      () => new ChangeOrderCoherenceError('note_missing'),
      "Add a short summary of what's changing and why.",
    ],
    [
      'ChangeOrderCoherenceError (tm_add_missing_estimate)',
      () => new ChangeOrderCoherenceError('tm_add_missing_estimate'),
      'Add an estimate in hours for each new milestone.',
    ],
    [
      'ChangeOrderCoherenceError (effective_price_negative)',
      () => new ChangeOrderCoherenceError('effective_price_negative'),
      'Enter a price or cap of zero or more.',
    ],
    [
      'ChangeOrderCoherenceError (empty_change)',
      () => new ChangeOrderCoherenceError('empty_change'),
      'Change at least one milestone or the price.',
    ],
    [
      'ChangeOrderCoherenceError (line_target_not_live)',
      () => new ChangeOrderCoherenceError('line_target_not_live'),
      'The delivery plan changed since you loaded the page. Refresh and try again.',
    ],
    [
      'EngagementNotActiveError',
      () => new EngagementNotActiveError('x'),
      "This project isn't active.",
    ],
    [
      'ChangeOrderPendingError',
      () => new ChangeOrderPendingError('x'),
      "A change to this project is still open. You can mark it ready once it's decided.",
    ],
  ])('maps a thrown %s to its friendly copy without logging', async (_name, make, copy) => {
    const res = await runEngagementLifecycleAction(
      ENGAGEMENT_ID,
      {},
      'fail',
      () => Promise.resolve(ok),
      () => {
        throw make();
      }
    );
    expect(res).toEqual({ success: false, error: copy });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('revalidates the composer route as well as the workspace on success', async () => {
    await runEngagementLifecycleAction(
      ENGAGEMENT_ID,
      {},
      'fail',
      () => Promise.resolve(ok),
      () => Promise.resolve({ success: true })
    );
    expect(revalidatePath).toHaveBeenCalledWith(`/engagements/${ENGAGEMENT_ID}`);
    expect(revalidatePath).toHaveBeenCalledWith(`/engagements/${ENGAGEMENT_ID}/change-order`);
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
