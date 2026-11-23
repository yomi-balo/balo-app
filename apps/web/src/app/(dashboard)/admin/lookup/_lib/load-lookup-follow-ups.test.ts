import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reminderSequenceKey } from '@balo/shared/notifications';
import type { SessionUser } from '@/lib/auth/session';

const {
  mockListRows,
  mockFindEngagementRequestId,
  mockFindUserIdByProfileId,
  mockFindById,
  mockListReviewCandidates,
} = vi.hoisted(() => ({
  mockListRows: vi.fn(),
  mockFindEngagementRequestId: vi.fn(),
  mockFindUserIdByProfileId: vi.fn(),
  mockFindById: vi.fn(),
  mockListReviewCandidates: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  reminderWaitsRepository: {
    listRows: mockListRows,
    findEngagementRequestId: mockFindEngagementRequestId,
  },
  expertsRepository: { findUserIdByProfileId: mockFindUserIdByProfileId },
  usersRepository: { findById: mockFindById },
  proposalsRepository: { listReviewCandidates: mockListReviewCandidates },
}));

import { log } from '@/lib/logging';
import { LOOKUP_FOLLOW_UPS_ROW_LIMIT, loadLookupFollowUps } from './load-lookup-follow-ups';

const NOW = new Date('2026-11-23T05:00:00.000Z');
const ANCHOR_ISO = '2026-11-16T03:00:00.000Z';
const REQUEST_ID = 'req-1';
const USER_ID = 'user-9';

function viewer(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'staff-1',
    email: 'staff@example.com',
    firstName: 'S',
    lastName: 'T',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'admin',
    companyId: 'company-1',
    companyName: 'Balo',
    companyRole: 'owner',
    ...overrides,
  };
}

function dbRow(stepKey: string, status = 'published') {
  return {
    id: `row-${stepKey}`,
    dedupeKey: reminderSequenceKey({
      sequenceId: 'proposal_review',
      entityId: REQUEST_ID,
      stepKey,
      userId: USER_ID,
      anchorIso: ANCHOR_ISO,
    }),
    event: 'project.proposal_review_reminder',
    status,
    scheduledFor: new Date('2026-11-19T22:00:00.000Z'),
    publishedAt: new Date('2026-11-19T22:00:00.000Z'),
    skipReason: null,
    lastError: null,
    attempts: 1,
    createdAt: new Date(ANCHOR_ISO),
    updatedAt: new Date('2026-11-19T22:00:00.000Z'),
    payload: { entityId: REQUEST_ID, recipientUserId: USER_ID, awaitingCount: 2 },
    recipient: { firstName: 'Dana', lastName: 'Whitfield', timezone: 'Australia/Melbourne' },
    entity: { title: 'Salesforce CPQ rollout', companyName: 'Northwind Industrial' },
  };
}

const CANDIDATE = {
  projectRequestId: REQUEST_ID,
  companyId: 'c1',
  createdByUserId: USER_ID,
  title: 'Salesforce CPQ rollout',
  relationshipId: 'rel-1',
  relationshipStatus: 'proposal_submitted',
  proposalStatus: 'submitted',
  submittedAt: new Date(ANCHOR_ISO),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockListRows.mockResolvedValue([]);
  mockListReviewCandidates.mockResolvedValue([CANDIDATE]);
  mockFindById.mockResolvedValue({ firstName: 'Dana', timezone: 'Australia/Melbourne' });
});

describe('loadLookupFollowUps — the authorization proof (AC1)', () => {
  it('a non-holder gets forbidden with zero repository calls', async () => {
    const result = await loadLookupFollowUps(viewer({ platformRole: 'user' }), {
      type: 'user',
      id: USER_ID,
    });
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    expect(log.warn).toHaveBeenCalled();
    expect(mockListRows).not.toHaveBeenCalled();
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockListReviewCandidates).not.toHaveBeenCalled();
    expect(mockFindEngagementRequestId).not.toHaveBeenCalled();
    expect(mockFindUserIdByProfileId).not.toHaveBeenCalled();
  });
});

describe('loadLookupFollowUps — a user (person lens)', () => {
  it('reads every sequence prefix for that recipient, 90 days plus the span back', async () => {
    mockListRows.mockResolvedValue([dbRow('day_2')]);
    const result = await loadLookupFollowUps(viewer(), { type: 'user', id: USER_ID }, NOW);
    const input = mockListRows.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      keyPrefixes: ['seq:proposal_review:'],
      recipientUserId: USER_ID,
      limit: LOOKUP_FOLLOW_UPS_ROW_LIMIT,
    });
    // 90 days + (9 days + 4 days of padding) before now.
    expect(input.createdSince.toISOString()).toBe('2026-08-12T05:00:00.000Z');
    expect(mockListReviewCandidates).toHaveBeenCalledWith({ projectRequestIds: [REQUEST_ID] });
    expect(mockFindById).toHaveBeenCalledWith(USER_ID);
    expect(result.ok && result.view.lens).toBe('person');
    expect(result.ok && result.view.now).toHaveLength(1);
  });

  it('a user that does not exist is not_found', async () => {
    mockFindById.mockResolvedValue(undefined);
    const result = await loadLookupFollowUps(viewer(), { type: 'user', id: USER_ID }, NOW);
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('warns when the row limit is hit', async () => {
    mockListRows.mockResolvedValue(
      Array.from({ length: LOOKUP_FOLLOW_UPS_ROW_LIMIT }, () => dbRow('day_2'))
    );
    await loadLookupFollowUps(viewer(), { type: 'user', id: USER_ID }, NOW);
    expect(log.warn).toHaveBeenCalledWith(
      'Admin lookup follow-ups hit the row limit',
      expect.objectContaining({ limit: LOOKUP_FOLLOW_UPS_ROW_LIMIT })
    );
  });

  it('skips the live lookup for a row whose key names no entity', async () => {
    mockListRows.mockResolvedValue([{ ...dbRow('day_2'), dedupeKey: 'not-a-sequence-key' }]);
    await loadLookupFollowUps(viewer(), { type: 'user', id: USER_ID }, NOW);
    expect(mockListReviewCandidates).not.toHaveBeenCalled();
  });

  it('takes the entity from the row key, not the stored payload', async () => {
    mockListRows.mockResolvedValue([
      { ...dbRow('day_2'), payload: { entityId: 'someone-elses-request' } },
    ]);
    await loadLookupFollowUps(viewer(), { type: 'user', id: USER_ID }, NOW);
    expect(mockListReviewCandidates).toHaveBeenCalledWith({ projectRequestIds: [REQUEST_ID] });
  });

  it('asks for every distinct request in ONE read, however many waits there are', async () => {
    const other = 'req-2';
    const otherRow = {
      ...dbRow('day_2'),
      id: 'row-other',
      dedupeKey: reminderSequenceKey({
        sequenceId: 'proposal_review',
        entityId: other,
        stepKey: 'day_2',
        userId: USER_ID,
        anchorIso: ANCHOR_ISO,
      }),
    };
    mockListRows.mockResolvedValue([dbRow('day_2'), dbRow('day_5'), otherRow]);
    mockListReviewCandidates.mockResolvedValue([
      CANDIDATE,
      { ...CANDIDATE, projectRequestId: other, title: 'Second request' },
    ]);

    const result = await loadLookupFollowUps(viewer(), { type: 'user', id: USER_ID }, NOW);

    expect(mockListReviewCandidates).toHaveBeenCalledTimes(1);
    expect(mockListReviewCandidates).toHaveBeenCalledWith({
      projectRequestIds: [REQUEST_ID, other],
    });
    expect(result.ok && result.view.now).toHaveLength(2);
  });

  it('reads a request as stopped when nothing awaits review any more', async () => {
    mockListRows.mockResolvedValue([dbRow('day_2')]);
    mockListReviewCandidates.mockResolvedValue([]);
    const result = await loadLookupFollowUps(viewer(), { type: 'user', id: USER_ID }, NOW);
    expect(result.ok && result.view.earlier).toHaveLength(1);
    expect(result.ok && result.view.now).toHaveLength(0);
  });
});

describe('loadLookupFollowUps — an expert', () => {
  it('resolves the profile to its user first (decision 7)', async () => {
    mockFindUserIdByProfileId.mockResolvedValue({ user: { id: USER_ID } });
    await loadLookupFollowUps(viewer(), { type: 'expert', id: 'profile-1' }, NOW);
    expect(mockFindUserIdByProfileId).toHaveBeenCalledWith('profile-1');
    expect(mockListRows).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: USER_ID })
    );
  });

  it('a profile with no user is not_found and reads no rows', async () => {
    mockFindUserIdByProfileId.mockResolvedValue(undefined);
    const result = await loadLookupFollowUps(viewer(), { type: 'expert', id: 'p' }, NOW);
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(mockListRows).not.toHaveBeenCalled();
  });
});

describe('loadLookupFollowUps — a project request (entity lens)', () => {
  it('reads that one request’s key prefix, with no recipient filter', async () => {
    mockListRows.mockResolvedValue([dbRow('day_2')]);
    const result = await loadLookupFollowUps(
      viewer(),
      { type: 'project_request', id: REQUEST_ID },
      NOW
    );
    const input = mockListRows.mock.calls[0]?.[0];
    expect(input.keyPrefixes).toEqual([`seq:proposal_review:${REQUEST_ID}:`]);
    expect(input.recipientUserId).toBeUndefined();
    expect(mockFindById).not.toHaveBeenCalled();
    expect(result.ok && result.view.lens).toBe('entity');
    expect(result.ok && result.view.origin).toBeNull();
    expect(result.ok && result.view.limit).toBeNull();
  });
});

describe('loadLookupFollowUps — an engagement (decision 1)', () => {
  it('shows the originating request’s waits with an origin note', async () => {
    mockFindEngagementRequestId.mockResolvedValue({ projectRequestId: REQUEST_ID });
    mockListRows.mockResolvedValue([dbRow('day_2')]);
    const result = await loadLookupFollowUps(viewer(), { type: 'engagement', id: 'eng-1' }, NOW);
    expect(mockListRows.mock.calls[0]?.[0].keyPrefixes).toEqual([
      `seq:proposal_review:${REQUEST_ID}:`,
    ]);
    expect(result.ok && result.view.origin).toEqual({ requestTitle: 'Salesforce CPQ rollout' });
  });

  it('takes the origin title from the rows when the request no longer awaits review', async () => {
    mockFindEngagementRequestId.mockResolvedValue({ projectRequestId: REQUEST_ID });
    mockListRows.mockResolvedValue([dbRow('day_2')]);
    mockListReviewCandidates.mockResolvedValue([]);
    const result = await loadLookupFollowUps(viewer(), { type: 'engagement', id: 'eng-1' }, NOW);
    expect(result.ok && result.view.origin).toEqual({ requestTitle: 'Salesforce CPQ rollout' });
  });

  it('an engagement with no originating request shows the empty entity view', async () => {
    mockFindEngagementRequestId.mockResolvedValue({ projectRequestId: null });
    const result = await loadLookupFollowUps(viewer(), { type: 'engagement', id: 'eng-1' }, NOW);
    expect(result).toMatchObject({
      ok: true,
      view: {
        lens: 'entity',
        now: [],
        earlier: [],
        origin: null,
        engagementWithoutRequest: true,
      },
    });
    expect(mockListRows).not.toHaveBeenCalled();
  });

  it('an unknown engagement is not_found', async () => {
    mockFindEngagementRequestId.mockResolvedValue(undefined);
    const result = await loadLookupFollowUps(viewer(), { type: 'engagement', id: 'nope' }, NOW);
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(mockListRows).not.toHaveBeenCalled();
  });
});
