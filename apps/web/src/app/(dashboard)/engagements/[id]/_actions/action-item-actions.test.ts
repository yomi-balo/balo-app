import { describe, it, expect, vi, beforeEach } from 'vitest';

const ENGAGEMENT_ID = 'a0000000-0000-4000-8000-000000000001';
const ACTION_ITEM_ID = 'b0000000-0000-4000-8000-000000000002';
const OTHER_ENGAGEMENT_ID = 'a0000000-0000-4000-8000-000000000009';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';
const EXPERT_PROFILE_ID = 'd0000000-0000-4000-8000-000000000004';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ requireOnboardedUser: () => mockRequireUser() }));

const mockResolveLens = vi.fn();
vi.mock('@/lib/engagement/resolve-engagement-lens', () => ({
  resolveEngagementLens: (...a: unknown[]) => mockResolveLens(...a),
}));

const mockHasCapability = vi.fn();
vi.mock('@/lib/authz', () => ({
  hasCapability: (...a: unknown[]) => mockHasCapability(...a),
  CAPABILITIES: { PARTICIPATE: 'participate' },
}));

const {
  mockFindEngagement,
  mockFindOwner,
  mockFindById,
  mockCreateManual,
  mockAssign,
  mockComplete,
  mockReopen,
  mockEdit,
  mockSoftRemove,
  EngagementNotActiveError,
  InvalidActionItemTransitionError,
} = vi.hoisted(() => {
  class EngagementNotActiveError extends Error {}
  class InvalidActionItemTransitionError extends Error {}
  return {
    mockFindEngagement: vi.fn(),
    mockFindOwner: vi.fn(),
    mockFindById: vi.fn(),
    mockCreateManual: vi.fn(),
    mockAssign: vi.fn(),
    mockComplete: vi.fn(),
    mockReopen: vi.fn(),
    mockEdit: vi.fn(),
    mockSoftRemove: vi.fn(),
    EngagementNotActiveError,
    InvalidActionItemTransitionError,
  };
});

vi.mock('@balo/db', () => ({
  engagementsRepository: {
    findEngagementWithMilestones: (...a: unknown[]) => mockFindEngagement(...a),
  },
  companiesRepository: { findOwnerByCompanyId: (...a: unknown[]) => mockFindOwner(...a) },
  actionItemsRepository: {
    findById: (...a: unknown[]) => mockFindById(...a),
    createManual: (...a: unknown[]) => mockCreateManual(...a),
    assign: (...a: unknown[]) => mockAssign(...a),
    complete: (...a: unknown[]) => mockComplete(...a),
    reopen: (...a: unknown[]) => mockReopen(...a),
    edit: (...a: unknown[]) => mockEdit(...a),
    softRemove: (...a: unknown[]) => mockSoftRemove(...a),
  },
  EngagementNotActiveError,
  InvalidActionItemTransitionError,
  // Referenced (import-only) by engagement-lifecycle-shared / milestone-action-shared.
  auditEventsRepository: {},
  MilestonesIncompleteError: class extends Error {},
  InvalidEngagementTransitionError: class extends Error {},
  InvalidMilestoneTransitionError: class extends Error {},
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
  ACTION_ITEM_SERVER_EVENTS: {
    CREATED: 'action_item_created',
    ASSIGNED: 'action_item_assigned',
    COMPLETED: 'action_item_completed',
    REOPENED: 'action_item_reopened',
    EDITED: 'action_item_edited',
    REMOVED: 'action_item_removed',
  },
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => {
    mockPublish(...a);
    return Promise.resolve();
  },
}));

import { createActionItemAction } from './create-action-item';
import { assignActionItemAction } from './assign-action-item';
import { setActionItemStatusAction } from './set-action-item-status';
import { updateActionItemAction } from './update-action-item';
import { removeActionItemAction } from './remove-action-item';
import { revalidatePath } from 'next/cache';

function engagement(overrides: Record<string, unknown> = {}) {
  return {
    id: ENGAGEMENT_ID,
    status: 'active',
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    company: { id: COMPANY_ID, name: 'Northwind Industrial' },
    projectRequest: { id: 'req-1', title: 'CPQ implementation' },
    expertProfile: {
      user: { firstName: 'Priya', lastName: 'Sharma' },
      agency: null,
      headline: null,
      type: 'freelancer',
    },
    milestones: [],
    ...overrides,
  };
}

function actionItem(overrides: Record<string, unknown> = {}) {
  return {
    id: ACTION_ITEM_ID,
    engagementId: ENGAGEMENT_ID,
    deletedAt: null,
    body: 'Send the migration plan',
    status: 'open',
    source: 'manual',
    assigneeParty: null,
    dueAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({
    id: 'user-1',
    firstName: 'Dana',
    lastName: 'Okafor',
    platformRole: 'user',
  });
  mockFindEngagement.mockResolvedValue(engagement());
  mockResolveLens.mockReturnValue({
    lens: 'expert',
    archetype: 'participant',
    isClientOwner: false,
    isDeliveringExpert: true,
  });
  mockHasCapability.mockResolvedValue(true);
  mockFindOwner.mockResolvedValue({ id: 'owner-1' });
  mockFindById.mockResolvedValue(actionItem());
  mockCreateManual.mockResolvedValue(actionItem());
  mockAssign.mockResolvedValue(actionItem());
  mockComplete.mockResolvedValue(actionItem({ status: 'done' }));
  mockReopen.mockResolvedValue(actionItem({ status: 'open' }));
  mockEdit.mockResolvedValue(actionItem());
  mockSoftRemove.mockResolvedValue(actionItem({ deletedAt: new Date() }));
});

describe('createActionItemAction — gate + validation', () => {
  const INPUT = { engagementId: ENGAGEMENT_ID, body: 'Send the migration plan' };

  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await createActionItemAction(INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
    expect(mockCreateManual).not.toHaveBeenCalled();
  });

  it('rejects an unknown key (strict) and an empty body', async () => {
    expect(
      await createActionItemAction({ ...INPUT, valueCents: 1 } as unknown as typeof INPUT)
    ).toEqual({ success: false, error: 'Invalid request.' });
    expect(await createActionItemAction({ engagementId: ENGAGEMENT_ID, body: '   ' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockCreateManual).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND for a stranger (lens null) without leaking existence', async () => {
    mockResolveLens.mockReturnValue(null);
    expect(await createActionItemAction(INPUT)).toEqual({
      success: false,
      error: 'This engagement could not be found.',
    });
    expect(mockCreateManual).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND when the engagement is missing', async () => {
    mockFindEngagement.mockResolvedValue(undefined);
    expect(await createActionItemAction(INPUT)).toEqual({
      success: false,
      error: 'This engagement could not be found.',
    });
  });

  it('blocks a client with no live PARTICIPATE capability (stale membership)', async () => {
    mockResolveLens.mockReturnValue({ lens: 'client' });
    mockHasCapability.mockResolvedValue(false);
    expect(await createActionItemAction(INPUT)).toEqual({
      success: false,
      error: 'Only people on this project can do that.',
    });
    expect(mockCreateManual).not.toHaveBeenCalled();
  });

  it('re-checks LIVE capability for the client lens against the engagement company', async () => {
    mockResolveLens.mockReturnValue({ lens: 'client' });
    await createActionItemAction(INPUT);
    expect(mockHasCapability).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      'participate',
      { companyId: COMPANY_ID }
    );
  });

  it('blocks writes on a non-active engagement', async () => {
    mockFindEngagement.mockResolvedValue(engagement({ status: 'pending_acceptance' }));
    expect(await createActionItemAction(INPUT)).toEqual({
      success: false,
      error: "This project isn't active.",
    });
    expect(mockCreateManual).not.toHaveBeenCalled();
  });

  it('allows the admin (observer) lens to write (no capability check)', async () => {
    mockResolveLens.mockReturnValue({ lens: 'admin' });
    const result = await createActionItemAction(INPUT);
    expect(result).toEqual({ success: true, actionItemId: ACTION_ITEM_ID });
    expect(mockHasCapability).not.toHaveBeenCalled();
    expect(mockCreateManual).toHaveBeenCalled();
  });
});

describe('createActionItemAction — create + analytics + notify', () => {
  it('creates WITHOUT an assignee: manual source, unassigned, count 1, no publish', async () => {
    const result = await createActionItemAction({
      engagementId: ENGAGEMENT_ID,
      body: 'Send the migration plan',
    });
    expect(result).toEqual({ success: true, actionItemId: ACTION_ITEM_ID });
    expect(mockCreateManual).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      userId: 'user-1',
      body: 'Send the migration plan',
      assigneeParty: null,
      dueAt: null,
    });
    expect(mockTrack).toHaveBeenCalledWith('action_item_created', {
      engagement_id: ENGAGEMENT_ID,
      source: 'manual',
      assignee_role: 'unassigned',
      count: 1,
      distinct_id: 'user-1',
    });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith(`/engagements/${ENGAGEMENT_ID}`);
  });

  it('create-with-assignee (client) by the expert lens publishes to the client owner', async () => {
    mockCreateManual.mockResolvedValue(
      actionItem({ assigneeParty: 'client', dueAt: new Date('2026-07-09T00:00:00Z') })
    );
    await createActionItemAction({
      engagementId: ENGAGEMENT_ID,
      body: 'Send the migration plan',
      assigneeParty: 'client',
      dueAt: '2026-07-09T00:00:00Z',
    });
    expect(mockCreateManual).toHaveBeenCalledWith(
      expect.objectContaining({ assigneeParty: 'client', dueAt: new Date('2026-07-09T00:00:00Z') })
    );
    expect(mockTrack).toHaveBeenCalledWith(
      'action_item_created',
      expect.objectContaining({ assignee_role: 'client' })
    );
    const [event, payload] = mockPublish.mock.calls[0]!;
    expect(event).toBe('action_item.assigned');
    expect(payload).toMatchObject({
      engagementId: ENGAGEMENT_ID,
      actionItemId: ACTION_ITEM_ID,
      assigneeParty: 'client',
      recipientId: 'owner-1',
      actorLabel: 'Priya', // expert retro first-mention (freelancer)
      projectTitle: 'CPQ implementation',
      actionItemBody: 'Send the migration plan',
      dueOn: '9 Jul 2026',
    });
    expect(payload.expertProfileId).toBeUndefined();
    expect(payload.correlationId).toContain(`${ACTION_ITEM_ID}:assigned:`);
  });

  it('create-with-assignee (expert) by the admin lens publishes to the expert, actor "Balo"', async () => {
    mockResolveLens.mockReturnValue({ lens: 'admin' });
    mockCreateManual.mockResolvedValue(actionItem({ assigneeParty: 'expert' }));
    await createActionItemAction({
      engagementId: ENGAGEMENT_ID,
      body: 'Send the migration plan',
      assigneeParty: 'expert',
    });
    const [, payload] = mockPublish.mock.calls[0]!;
    expect(payload).toMatchObject({
      assigneeParty: 'expert',
      expertProfileId: EXPERT_PROFILE_ID,
      actorLabel: 'Balo',
    });
    expect(payload.recipientId).toBeUndefined();
    expect(payload.dueOn).toBeUndefined();
  });

  it('names the client actor "Person @ Company" when the client lens assigns', async () => {
    mockResolveLens.mockReturnValue({ lens: 'client' });
    mockCreateManual.mockResolvedValue(actionItem({ assigneeParty: 'expert' }));
    await createActionItemAction({
      engagementId: ENGAGEMENT_ID,
      body: 'Send the migration plan',
      assigneeParty: 'expert',
    });
    const [, payload] = mockPublish.mock.calls[0]!;
    expect(payload.actorLabel).toBe('Dana @ Northwind Industrial');
  });
});

describe('assignActionItemAction', () => {
  const INPUT = {
    engagementId: ENGAGEMENT_ID,
    actionItemId: ACTION_ITEM_ID,
    assigneeParty: 'client' as const,
  };

  it('rejects a forged actionItemId from another engagement (IDOR) before any write', async () => {
    mockFindById.mockResolvedValue(actionItem({ engagementId: OTHER_ENGAGEMENT_ID }));
    expect(await assignActionItemAction(INPUT)).toEqual({
      success: false,
      error: 'This action item is no longer here — refresh and try again.',
    });
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it('rejects a soft-removed / missing action item (IDOR)', async () => {
    mockFindById.mockResolvedValue(undefined);
    expect(await assignActionItemAction(INPUT)).toEqual({
      success: false,
      error: 'This action item is no longer here — refresh and try again.',
    });
  });

  it('assigns to a side, fires ASSIGNED, and publishes to that side', async () => {
    mockAssign.mockResolvedValue(actionItem({ assigneeParty: 'client' }));
    const result = await assignActionItemAction(INPUT);
    expect(result).toEqual({ success: true, actionItemId: ACTION_ITEM_ID });
    expect(mockAssign).toHaveBeenCalledWith({
      actionItemId: ACTION_ITEM_ID,
      userId: 'user-1',
      assigneeParty: 'client',
    });
    expect(mockTrack).toHaveBeenCalledWith('action_item_assigned', {
      engagement_id: ENGAGEMENT_ID,
      action_item_id: ACTION_ITEM_ID,
      assignee_role: 'client',
      distinct_id: 'user-1',
    });
    expect(mockPublish).toHaveBeenCalledWith(
      'action_item.assigned',
      expect.objectContaining({ assigneeParty: 'client', recipientId: 'owner-1' })
    );
  });

  it('clearing (null) fires ASSIGNED as "unassigned" and does NOT publish', async () => {
    mockAssign.mockResolvedValue(actionItem({ assigneeParty: null }));
    await assignActionItemAction({ ...INPUT, assigneeParty: null });
    expect(mockAssign).toHaveBeenCalledWith(expect.objectContaining({ assigneeParty: null }));
    expect(mockTrack).toHaveBeenCalledWith(
      'action_item_assigned',
      expect.objectContaining({ assignee_role: 'unassigned' })
    );
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('rejects a missing assigneeParty key (strict)', async () => {
    expect(
      await assignActionItemAction({
        engagementId: ENGAGEMENT_ID,
        actionItemId: ACTION_ITEM_ID,
      } as unknown as typeof INPUT)
    ).toEqual({ success: false, error: 'Invalid request.' });
  });
});

describe('setActionItemStatusAction', () => {
  const base = { engagementId: ENGAGEMENT_ID, actionItemId: ACTION_ITEM_ID };

  it('completes (done): calls complete, fires COMPLETED with the actor lens + ai flag', async () => {
    mockFindById.mockResolvedValue(actionItem({ source: 'ai_extracted' }));
    mockResolveLens.mockReturnValue({ lens: 'expert' });
    const result = await setActionItemStatusAction({ ...base, status: 'done' });
    expect(result).toEqual({ success: true, actionItemId: ACTION_ITEM_ID });
    expect(mockComplete).toHaveBeenCalledWith({ actionItemId: ACTION_ITEM_ID, userId: 'user-1' });
    expect(mockReopen).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith('action_item_completed', {
      engagement_id: ENGAGEMENT_ID,
      action_item_id: ACTION_ITEM_ID,
      completed_by_role: 'expert',
      was_ai_extracted: true,
      distinct_id: 'user-1',
    });
  });

  it('reopens (open): calls reopen, fires REOPENED', async () => {
    await setActionItemStatusAction({ ...base, status: 'open' });
    expect(mockReopen).toHaveBeenCalledWith({ actionItemId: ACTION_ITEM_ID, userId: 'user-1' });
    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith('action_item_reopened', {
      engagement_id: ENGAGEMENT_ID,
      action_item_id: ACTION_ITEM_ID,
      distinct_id: 'user-1',
    });
  });

  it('maps InvalidActionItemTransitionError to STATUS_CHANGED (expected race, no revalidate)', async () => {
    mockComplete.mockRejectedValue(new InvalidActionItemTransitionError('done→done'));
    expect(await setActionItemStatusAction({ ...base, status: 'done' })).toEqual({
      success: false,
      error: 'This action item changed since you loaded the page. Refresh and try again.',
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe('updateActionItemAction', () => {
  const base = { engagementId: ENGAGEMENT_ID, actionItemId: ACTION_ITEM_ID };

  it('edits body + due: forwards a parsed Date and reports both changed fields', async () => {
    await updateActionItemAction({
      ...base,
      body: 'Revised body',
      dueAt: '2026-07-09T00:00:00Z',
    });
    expect(mockEdit).toHaveBeenCalledWith({
      actionItemId: ACTION_ITEM_ID,
      userId: 'user-1',
      body: 'Revised body',
      dueAt: new Date('2026-07-09T00:00:00Z'),
    });
    expect(mockTrack).toHaveBeenCalledWith('action_item_edited', {
      engagement_id: ENGAGEMENT_ID,
      action_item_id: ACTION_ITEM_ID,
      fields_changed: ['body', 'due_at'],
      distinct_id: 'user-1',
    });
  });

  it('clears the due date with an explicit null (only due_at changed)', async () => {
    await updateActionItemAction({ ...base, dueAt: null });
    expect(mockEdit).toHaveBeenCalledWith({
      actionItemId: ACTION_ITEM_ID,
      userId: 'user-1',
      dueAt: null,
    });
    expect(mockTrack).toHaveBeenCalledWith(
      'action_item_edited',
      expect.objectContaining({ fields_changed: ['due_at'] })
    );
  });

  it('rejects an empty edit (no body and no dueAt) as INVALID_REQUEST', async () => {
    expect(await updateActionItemAction(base)).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockEdit).not.toHaveBeenCalled();
  });

  it('never publishes a notification for an edit', async () => {
    await updateActionItemAction({ ...base, body: 'Revised body' });
    expect(mockPublish).not.toHaveBeenCalled();
  });
});

describe('removeActionItemAction', () => {
  const base = { engagementId: ENGAGEMENT_ID, actionItemId: ACTION_ITEM_ID };

  it('soft-removes and fires REMOVED', async () => {
    const result = await removeActionItemAction(base);
    expect(result).toEqual({ success: true, actionItemId: ACTION_ITEM_ID });
    expect(mockSoftRemove).toHaveBeenCalledWith({
      actionItemId: ACTION_ITEM_ID,
      userId: 'user-1',
    });
    expect(mockTrack).toHaveBeenCalledWith('action_item_removed', {
      engagement_id: ENGAGEMENT_ID,
      action_item_id: ACTION_ITEM_ID,
      distinct_id: 'user-1',
    });
  });

  it('maps EngagementNotActiveError to NOT_ACTIVE (race under the repo lock)', async () => {
    mockSoftRemove.mockRejectedValue(new EngagementNotActiveError('not active'));
    expect(await removeActionItemAction(base)).toEqual({
      success: false,
      error: "This project isn't active.",
    });
  });

  it('maps an unexpected repo error to GENERIC_FAILURE', async () => {
    mockSoftRemove.mockRejectedValue(new Error('db exploded'));
    expect(await removeActionItemAction(base)).toEqual({
      success: false,
      error: 'Something went wrong. Please try again.',
    });
  });
});
