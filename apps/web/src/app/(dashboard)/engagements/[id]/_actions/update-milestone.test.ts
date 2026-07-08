import { describe, it, expect, vi, beforeEach } from 'vitest';

const ENGAGEMENT_ID = 'a0000000-0000-4000-8000-000000000001';
const MILESTONE_ID = 'b0000000-0000-4000-8000-000000000002';
const OTHER_MILESTONE_ID = 'b0000000-0000-4000-8000-000000000999';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';
const UPDATED_AT = new Date('2026-07-01T00:00:00Z');

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ requireUser: () => mockRequireUser() }));

const mockResolveLens = vi.fn();
vi.mock('@/lib/engagement/resolve-engagement-lens', () => ({
  resolveEngagementLens: (...a: unknown[]) => mockResolveLens(...a),
}));

const {
  mockFindEngagement,
  mockFindOwner,
  mockEdit,
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
    mockEdit: vi.fn(),
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
  engagementMilestonesRepository: { editDescriptive: (...a: unknown[]) => mockEdit(...a) },
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

vi.mock('@/lib/sanitize/project-html', () => ({
  sanitizeProjectHtml: (html: string) => `SANITIZED:${html}`,
}));

import { updateMilestoneAction } from './update-milestone';
import { revalidatePath } from 'next/cache';

type UpdateInput = Parameters<typeof updateMilestoneAction>[0];

const EXPERT_CTX = {
  lens: 'expert',
  archetype: 'participant',
  isClientOwner: false,
  isDeliveringExpert: true,
};

function milestone(overrides: Record<string, unknown> = {}) {
  return {
    id: MILESTONE_ID,
    title: 'Discovery',
    status: 'in_progress',
    descriptionHtml: '<p>old</p>',
    acceptanceCriteria: 'Old criteria',
    estimatedMinutes: 120,
    updatedAt: new Date('2026-06-20T00:00:00Z'),
    ...overrides,
  };
}

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
    milestones: [milestone()],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({ id: 'user-1', platformRole: 'user' });
  mockFindEngagement.mockResolvedValue(engagement());
  mockResolveLens.mockReturnValue(EXPERT_CTX);
  mockFindOwner.mockResolvedValue({ id: 'owner-1' });
  mockEdit.mockResolvedValue({
    id: MILESTONE_ID,
    title: 'Discovery',
    status: 'in_progress',
    updatedAt: UPDATED_AT,
  });
});

describe('updateMilestoneAction', () => {
  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    expect(
      await updateMilestoneAction({ engagementId: ENGAGEMENT_ID, milestoneId: MILESTONE_ID })
    ).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockEdit).not.toHaveBeenCalled();
  });

  it('rejects a smuggled valueCents (strict schema) with INVALID_REQUEST', async () => {
    const input = {
      engagementId: ENGAGEMENT_ID,
      milestoneId: MILESTONE_ID,
      valueCents: 999_00,
    } as unknown as UpdateInput;
    expect(await updateMilestoneAction(input)).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockEdit).not.toHaveBeenCalled();
  });

  it('returns MILESTONE_GONE for a milestoneId not in the engagement (IDOR)', async () => {
    const res = await updateMilestoneAction({
      engagementId: ENGAGEMENT_ID,
      milestoneId: OTHER_MILESTONE_ID,
      title: 'Whatever',
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toMatch(/no longer part of this engagement/);
    expect(mockEdit).not.toHaveBeenCalled();
  });

  it('material edit (acceptance criteria) → fresh updatedAt correlationId + fields_changed', async () => {
    const result = await updateMilestoneAction({
      engagementId: ENGAGEMENT_ID,
      milestoneId: MILESTONE_ID,
      acceptanceCriteria: 'New criteria',
    });
    expect(result).toEqual({ success: true, milestoneId: MILESTONE_ID, status: 'in_progress' });

    expect(mockEdit).toHaveBeenCalledWith({
      milestoneId: MILESTONE_ID,
      userId: 'user-1',
      acceptanceCriteria: 'New criteria',
    });
    const [editArg] = mockEdit.mock.calls[0] as [Record<string, unknown>];
    expect(editArg).not.toHaveProperty('valueCents');

    expect(mockTrack).toHaveBeenCalledWith('engagement_milestone_edited', {
      engagement_id: ENGAGEMENT_ID,
      milestone_id: MILESTONE_ID,
      fields_changed: ['acceptance_criteria'],
      distinct_id: 'user-1',
    });
    expect(mockPublish).toHaveBeenCalledWith('engagement.scope_changed', {
      correlationId: `${MILESTONE_ID}:edited:${UPDATED_AT.getTime()}`,
      engagementId: ENGAGEMENT_ID,
      milestoneId: MILESTONE_ID,
      recipientId: 'owner-1',
      actorExpertLabel: 'Priya',
      projectTitle: 'CPQ implementation',
      changeKind: 'edited',
      changeSummary: "revised 'Discovery'",
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/engagements/${ENGAGEMENT_ID}`);
  });

  it('title-only edit → bucketed (cosmetic) correlationId + fields_changed:["title"]', async () => {
    mockEdit.mockResolvedValue({
      id: MILESTONE_ID,
      title: 'Discovery v2',
      status: 'in_progress',
      updatedAt: UPDATED_AT,
    });
    await updateMilestoneAction({
      engagementId: ENGAGEMENT_ID,
      milestoneId: MILESTONE_ID,
      title: 'Discovery v2',
    });
    expect(mockTrack).toHaveBeenCalledWith(
      'engagement_milestone_edited',
      expect.objectContaining({ fields_changed: ['title'] })
    );
    const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    // Time-bucketed key (Math.floor(now / DEBOUNCE)) — assert the shape, not the bucket.
    expect(payload.correlationId).toMatch(new RegExp(`^${MILESTONE_ID}:edited:\\d+$`));
    expect(payload.changeSummary).toBe("revised 'Discovery v2'");
  });

  it('re-sending an unchanged field alongside a real change writes + audits only what changed', async () => {
    mockEdit.mockResolvedValue({
      id: MILESTONE_ID,
      title: 'Discovery v2',
      status: 'in_progress',
      updatedAt: UPDATED_AT,
    });
    await updateMilestoneAction({
      engagementId: ENGAGEMENT_ID,
      milestoneId: MILESTONE_ID,
      title: 'Discovery v2', // changed
      acceptanceCriteria: 'Old criteria', // identical to the pre-loaded node — must be dropped
    });
    // Only the genuinely-changed field reaches the repo (no over-write / over-audit of the
    // unchanged acceptance criteria) — the DB audit `fields` now matches `fields_changed`.
    expect(mockEdit).toHaveBeenCalledWith({
      milestoneId: MILESTONE_ID,
      userId: 'user-1',
      title: 'Discovery v2',
    });
    expect(mockTrack).toHaveBeenCalledWith(
      'engagement_milestone_edited',
      expect.objectContaining({ fields_changed: ['title'] })
    );
  });

  it('sanitises the description on the edge (write path)', async () => {
    await updateMilestoneAction({
      engagementId: ENGAGEMENT_ID,
      milestoneId: MILESTONE_ID,
      descriptionText: 'New body',
    });
    expect(mockEdit).toHaveBeenCalledWith({
      milestoneId: MILESTONE_ID,
      userId: 'user-1',
      descriptionHtml: 'SANITIZED:<p>New body</p>',
    });
    expect(mockTrack).toHaveBeenCalledWith(
      'engagement_milestone_edited',
      expect.objectContaining({ fields_changed: ['description_html'] })
    );
  });

  it('does not flatten a RICH description or over-notify on a title-only edit that re-sends its unchanged plain text (B1)', async () => {
    // A proposal-snapshotted milestone holds rich HTML; the edit form prefills its
    // plain-text projection ('Alpha Beta') and the rail re-sends it on every save.
    mockFindEngagement.mockResolvedValue(
      engagement({
        milestones: [milestone({ descriptionHtml: '<ul><li>Alpha</li><li>Beta</li></ul>' })],
      })
    );
    mockEdit.mockResolvedValue({
      id: MILESTONE_ID,
      title: 'Discovery v2',
      status: 'in_progress',
      updatedAt: UPDATED_AT,
    });

    await updateMilestoneAction({
      engagementId: ENGAGEMENT_ID,
      milestoneId: MILESTONE_ID,
      title: 'Discovery v2', // the only genuine change
      descriptionText: 'Alpha Beta', // htmlToPlainText of the RICH description — untouched
    });

    // description_html is NOT written → the rich HTML is preserved (no silent flatten).
    const [editArg] = mockEdit.mock.calls[0] as [Record<string, unknown>];
    expect(editArg).not.toHaveProperty('descriptionHtml');
    expect(editArg).toEqual({ milestoneId: MILESTONE_ID, userId: 'user-1', title: 'Discovery v2' });
    // Classified COSMETIC (title-only) → bucketed correlationId, NOT the material updatedAt key.
    expect(mockTrack).toHaveBeenCalledWith(
      'engagement_milestone_edited',
      expect.objectContaining({ fields_changed: ['title'] })
    );
    const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.correlationId).toMatch(new RegExp(`^${MILESTONE_ID}:edited:\\d+$`));
    expect(payload.correlationId).not.toBe(`${MILESTONE_ID}:edited:${UPDATED_AT.getTime()}`);
  });

  it('clears a field when passed null (acceptanceCriteria → null)', async () => {
    await updateMilestoneAction({
      engagementId: ENGAGEMENT_ID,
      milestoneId: MILESTONE_ID,
      acceptanceCriteria: null,
    });
    expect(mockEdit).toHaveBeenCalledWith({
      milestoneId: MILESTONE_ID,
      userId: 'user-1',
      acceptanceCriteria: null,
    });
  });

  it('is a no-op (no write / track / notify) when nothing changed', async () => {
    const result = await updateMilestoneAction({
      engagementId: ENGAGEMENT_ID,
      milestoneId: MILESTONE_ID,
      title: 'Discovery',
    });
    expect(result).toEqual({ success: true, milestoneId: MILESTONE_ID, status: 'in_progress' });
    expect(mockEdit).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });
});
