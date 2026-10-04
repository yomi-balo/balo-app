import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for the case-grain done / reopen action. `authorizeCaseMutation` is REAL (that is
 * how the session + tenancy gate is exercised); the capability predicate is mocked because it
 * has its own suite — what matters here is the subject this action hands it and that its
 * `false` is honoured.
 */

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';
const USER_ID = 'u0000000-0000-4000-8000-000000000002';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';
const PROFILE_ID = 'p0000000-0000-4000-8000-000000000004';
const ITEM_ID = 'a0000000-0000-4000-8000-000000000005';
const OTHER_ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000009';

vi.mock('server-only', () => ({}));

const { MockEngagementNotActiveError, MockInvalidActionItemTransitionError } = vi.hoisted(() => ({
  MockEngagementNotActiveError: class extends Error {},
  MockInvalidActionItemTransitionError: class extends Error {},
}));

const mockFindCase = vi.fn();
const mockFindItem = vi.fn();
const mockComplete = vi.fn();
const mockReopen = vi.fn();
vi.mock('@balo/db', () => ({
  caseEngagementsRepository: {
    findByEngagementId: (...a: unknown[]) => mockFindCase(...a),
  },
  actionItemsRepository: {
    findById: (...a: unknown[]) => mockFindItem(...a),
    complete: (...a: unknown[]) => mockComplete(...a),
    reopen: (...a: unknown[]) => mockReopen(...a),
  },
  EngagementNotActiveError: MockEngagementNotActiveError,
  InvalidActionItemTransitionError: MockInvalidActionItemTransitionError,
}));

const mockRequireOnboardedUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireOnboardedUser(),
}));

const mockResolveCaseAccess = vi.fn();
vi.mock('@/lib/cases/resolve-case-access', () => ({
  resolveCaseAccess: (...a: unknown[]) => mockResolveCaseAccess(...a),
}));

const mockMayToggle = vi.fn();
vi.mock('@/lib/cases/may-toggle-case-action-items', () => ({
  mayToggleCaseActionItems: (...a: unknown[]) => mockMayToggle(...a),
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
  ACTION_ITEM_SERVER_EVENTS: {
    COMPLETED: 'action_item_completed',
    REOPENED: 'action_item_reopened',
  },
}));

const mockRevalidate = vi.fn();
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => mockRevalidate(...a) }));

import { setCaseActionItemStatusAction } from './set-case-action-item-status';
import { log } from '@/lib/logging';

const ACCESS = {
  lens: 'client',
  engagementId: ENGAGEMENT_ID,
  companyId: COMPANY_ID,
  expertProfileId: PROFILE_ID,
  engagementStatus: 'active',
  conversationId: 'conv-1',
  conversationWritable: true,
};

const ITEM = {
  id: ITEM_ID,
  engagementId: ENGAGEMENT_ID,
  deletedAt: null,
  source: 'ai_extracted',
  status: 'open',
};

const DONE = { engagementId: ENGAGEMENT_ID, actionItemId: ITEM_ID, status: 'done' as const };
const REOPEN = { ...DONE, status: 'open' as const };
const CASE_CLOSED = 'This case is closed, so its action items can no longer change.';

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID });
  mockResolveCaseAccess.mockResolvedValue(ACCESS);
  mockFindCase.mockResolvedValue({ engagementId: ENGAGEMENT_ID, closedAt: null });
  mockMayToggle.mockResolvedValue(true);
  mockFindItem.mockResolvedValue(ITEM);
  mockComplete.mockResolvedValue({ ...ITEM, status: 'done' });
  mockReopen.mockResolvedValue({ ...ITEM, status: 'open' });
});

describe('setCaseActionItemStatusAction — gates', () => {
  it('rejects malformed input before any read', async () => {
    expect(await setCaseActionItemStatusAction({ ...DONE, actionItemId: 'nope' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockRequireOnboardedUser).not.toHaveBeenCalled();
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
  });

  it('refuses an unsigned session before the tenancy gate', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('no session'));
    expect(await setCaseActionItemStatusAction(DONE)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
  });

  it('re-runs the full tenancy gate, and a stranger gets the not-available copy with no write', async () => {
    mockResolveCaseAccess.mockResolvedValue(null);
    expect(await setCaseActionItemStatusAction(DONE)).toEqual({
      success: false,
      error: 'This case is no longer available.',
    });
    expect(mockResolveCaseAccess).toHaveBeenCalledWith(ENGAGEMENT_ID, USER_ID);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('refuses a CLOSED case without resolving a capability', async () => {
    mockFindCase.mockResolvedValue({ engagementId: ENGAGEMENT_ID, closedAt: new Date() });
    expect(await setCaseActionItemStatusAction(DONE)).toEqual({
      success: false,
      error: CASE_CLOSED,
    });
    expect(mockMayToggle).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('hands the capability check the LOADED lens + company, never input', async () => {
    mockResolveCaseAccess.mockResolvedValue({ ...ACCESS, lens: 'expert' });
    await setCaseActionItemStatusAction(DONE);
    expect(mockMayToggle).toHaveBeenCalledWith(
      { id: USER_ID },
      { lens: 'expert', engagementId: ENGAGEMENT_ID, companyId: COMPANY_ID }
    );
  });

  it('honours a false capability answer — no write, a warn, the permission copy', async () => {
    mockMayToggle.mockResolvedValue(false);
    expect(await setCaseActionItemStatusAction(DONE)).toEqual({
      success: false,
      error: "You don't have permission to do that.",
    });
    expect(mockFindItem).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      'Case action item status change denied',
      expect.objectContaining({ engagementId: ENGAGEMENT_ID, userId: USER_ID })
    );
  });

  it.each([
    ['missing', undefined],
    ['from another engagement', { ...ITEM, engagementId: OTHER_ENGAGEMENT_ID }],
    ['soft-deleted', { ...ITEM, deletedAt: new Date() }],
  ])('rejects an item that is %s (IDOR) with no write', async (_label, row) => {
    mockFindItem.mockResolvedValue(row);
    expect(await setCaseActionItemStatusAction(DONE)).toEqual({
      success: false,
      error: 'This action item is no longer here — refresh and try again.',
    });
    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });
});

describe('setCaseActionItemStatusAction — writes', () => {
  it('completes, tracks with the actor lens + ai flag, and revalidates the case', async () => {
    expect(await setCaseActionItemStatusAction(DONE)).toEqual({
      success: true,
      actionItemId: ITEM_ID,
    });
    expect(mockComplete).toHaveBeenCalledWith({ actionItemId: ITEM_ID, userId: USER_ID });
    expect(mockReopen).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith('action_item_completed', {
      engagement_id: ENGAGEMENT_ID,
      engagement_type: 'case',
      action_item_id: ITEM_ID,
      completed_by_role: 'client',
      was_ai_extracted: true,
      distinct_id: USER_ID,
    });
    expect(mockRevalidate).toHaveBeenCalledWith('/cases/' + ENGAGEMENT_ID);
  });

  it('reopens and tracks the reopen', async () => {
    expect(await setCaseActionItemStatusAction(REOPEN)).toEqual({
      success: true,
      actionItemId: ITEM_ID,
    });
    expect(mockReopen).toHaveBeenCalledWith({ actionItemId: ITEM_ID, userId: USER_ID });
    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith('action_item_reopened', {
      engagement_id: ENGAGEMENT_ID,
      engagement_type: 'case',
      action_item_id: ITEM_ID,
      reopened_by_role: 'client',
      distinct_id: USER_ID,
    });
  });

  it('maps a close racing the write (EngagementNotActiveError) to the closed copy, unlogged', async () => {
    mockComplete.mockRejectedValue(new MockEngagementNotActiveError('not active'));
    expect(await setCaseActionItemStatusAction(DONE)).toEqual({
      success: false,
      error: CASE_CLOSED,
    });
    expect(vi.mocked(log.error)).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it('maps a double-toggle race to the status-changed copy, unlogged', async () => {
    mockComplete.mockRejectedValue(new MockInvalidActionItemTransitionError('done → done'));
    expect(await setCaseActionItemStatusAction(DONE)).toEqual({
      success: false,
      error: 'This action item changed since you loaded the page. Refresh and try again.',
    });
    expect(vi.mocked(log.error)).not.toHaveBeenCalled();
  });

  it('logs any other failure and returns the generic copy', async () => {
    mockComplete.mockRejectedValue(new Error('db down'));
    expect(await setCaseActionItemStatusAction(DONE)).toEqual({
      success: false,
      error: 'Something went wrong. Please try again.',
    });
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      'Failed to update case action item status',
      expect.objectContaining({ engagementId: ENGAGEMENT_ID, error: 'db down' })
    );
  });
});
