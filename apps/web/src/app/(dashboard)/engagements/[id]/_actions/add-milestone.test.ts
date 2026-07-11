import { describe, it, expect, vi, beforeEach } from 'vitest';

const ENGAGEMENT_ID = 'a0000000-0000-4000-8000-000000000001';
const NEW_MILESTONE_ID = 'b0000000-0000-4000-8000-000000000010';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ requireOnboardedUser: () => mockRequireUser() }));

const mockResolveLens = vi.fn();
vi.mock('@/lib/engagement/resolve-engagement-lens', () => ({
  resolveEngagementLens: (...a: unknown[]) => mockResolveLens(...a),
}));

const {
  mockFindEngagement,
  mockFindOwner,
  mockAdd,
  EngagementNotActiveError,
  InvalidMilestoneTransitionError,
  MilestoneReorderMismatchError,
} = vi.hoisted(() => {
  class EngagementNotActiveError extends Error {}
  class InvalidMilestoneTransitionError extends Error {}
  class MilestoneReorderMismatchError extends Error {}
  return {
    mockFindEngagement: vi.fn(),
    mockFindOwner: vi.fn(),
    mockAdd: vi.fn(),
    EngagementNotActiveError,
    InvalidMilestoneTransitionError,
    MilestoneReorderMismatchError,
  };
});

vi.mock('@balo/db', () => ({
  engagementsRepository: {
    findEngagementWithMilestones: (...a: unknown[]) => mockFindEngagement(...a),
  },
  companiesRepository: { findOwnerByCompanyId: (...a: unknown[]) => mockFindOwner(...a) },
  engagementMilestonesRepository: { add: (...a: unknown[]) => mockAdd(...a) },
  EngagementNotActiveError,
  InvalidMilestoneTransitionError,
  MilestoneReorderMismatchError,
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
  ENGAGEMENT_SERVER_EVENTS: {
    MILESTONE_STARTED: 'engagement_milestone_started',
    MILESTONE_COMPLETED: 'engagement_milestone_completed',
    MILESTONE_REVERTED: 'engagement_milestone_reverted',
    MILESTONE_ADDED: 'engagement_milestone_added',
    MILESTONE_EDITED: 'engagement_milestone_edited',
    MILESTONE_REMOVED: 'engagement_milestone_removed',
  },
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => {
    mockPublish(...a);
    return Promise.resolve();
  },
}));

// Identity-ish marker so the edge-sanitise call is assertable in the `add` args.
vi.mock('@/lib/sanitize/project-html', () => ({
  sanitizeProjectHtml: (html: string) => `SANITIZED:${html}`,
}));

import { addMilestoneAction } from './add-milestone';
import { revalidatePath } from 'next/cache';

type AddInput = Parameters<typeof addMilestoneAction>[0];

const EXPERT_CTX = {
  lens: 'expert',
  archetype: 'participant',
  isClientOwner: false,
  isDeliveringExpert: true,
};

function engagement(overrides: Record<string, unknown> = {}) {
  return {
    id: ENGAGEMENT_ID,
    status: 'active',
    company: { id: COMPANY_ID, name: 'Northwind Industrial' },
    projectRequest: { id: 'req-1', title: 'CPQ implementation' },
    expertProfile: {
      user: { firstName: 'Priya', lastName: 'Sharma' },
      agency: null,
      headline: null,
      type: 'freelancer',
    },
    milestones: [{ id: 'existing-1', title: 'Discovery', status: 'pending' }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({ id: 'user-1', platformRole: 'user' });
  mockFindEngagement.mockResolvedValue(engagement());
  mockResolveLens.mockReturnValue(EXPERT_CTX);
  mockFindOwner.mockResolvedValue({ id: 'owner-1' });
  mockAdd.mockResolvedValue({
    id: NEW_MILESTONE_ID,
    title: 'Data migration dry-run',
    status: 'pending',
  });
});

const HAPPY: AddInput = {
  engagementId: ENGAGEMENT_ID,
  title: 'Data migration dry-run',
  descriptionText: 'Rehearse the cutover.',
};

describe('addMilestoneAction', () => {
  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await addMilestoneAction(HAPPY)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('rejects a missing title with INVALID_REQUEST', async () => {
    expect(await addMilestoneAction({ engagementId: ENGAGEMENT_ID } as AddInput)).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('rejects a smuggled valueCents (strict schema) with INVALID_REQUEST', async () => {
    const input = {
      engagementId: ENGAGEMENT_ID,
      title: 'X',
      valueCents: 500_00,
    } as unknown as AddInput;
    expect(await addMilestoneAction(input)).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('returns ONLY_EXPERT for a non-expert lens', async () => {
    mockResolveLens.mockReturnValue({ ...EXPERT_CTX, lens: 'admin' });
    expect(await addMilestoneAction(HAPPY)).toEqual({
      success: false,
      error: 'Only the delivering expert can update milestones.',
    });
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('returns ENGAGEMENT_LOCKED when the engagement is not active', async () => {
    mockFindEngagement.mockResolvedValue(engagement({ status: 'pending_acceptance' }));
    expect(await addMilestoneAction(HAPPY)).toEqual({
      success: false,
      error: 'The delivery plan is locked while the project is in review.',
    });
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('adds without valueCents, sanitises the description, tracks + notifies, revalidates', async () => {
    const result = await addMilestoneAction(HAPPY);
    expect(result).toEqual({ success: true, milestoneId: NEW_MILESTONE_ID, status: 'pending' });

    expect(mockAdd).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      userId: 'user-1',
      title: 'Data migration dry-run',
      descriptionHtml: 'SANITIZED:<p>Rehearse the cutover.</p>',
      acceptanceCriteria: null,
      estimatedMinutes: null,
    });
    // The money axis is unrepresentable — never forwarded to the repo.
    const [addArg] = mockAdd.mock.calls[0] as [Record<string, unknown>];
    expect(addArg).not.toHaveProperty('valueCents');

    expect(mockTrack).toHaveBeenCalledWith('engagement_milestone_added', {
      engagement_id: ENGAGEMENT_ID,
      milestones_total: 2,
      distinct_id: 'user-1',
    });
    expect(mockPublish).toHaveBeenCalledWith('engagement.scope_changed', {
      correlationId: `${NEW_MILESTONE_ID}:added`,
      engagementId: ENGAGEMENT_ID,
      milestoneId: NEW_MILESTONE_ID,
      recipientId: 'owner-1',
      actorExpertLabel: 'Priya',
      projectTitle: 'CPQ implementation',
      changeKind: 'added',
      changeSummary: "added 'Data migration dry-run'",
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/engagements/${ENGAGEMENT_ID}`);
  });

  it('passes descriptionHtml null when no description text is supplied', async () => {
    await addMilestoneAction({ engagementId: ENGAGEMENT_ID, title: 'Bare' });
    expect(mockAdd).toHaveBeenCalledWith(
      expect.objectContaining({ descriptionHtml: null, acceptanceCriteria: null })
    );
  });

  it('omits recipientId when the owner lookup fails (retainer / no-owner)', async () => {
    mockFindOwner.mockRejectedValue(new Error('no owner'));
    await addMilestoneAction(HAPPY);
    const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.recipientId).toBeUndefined();
  });
});
