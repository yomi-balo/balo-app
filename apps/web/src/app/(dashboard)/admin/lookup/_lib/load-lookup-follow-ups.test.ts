import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reminderSequenceKey } from '@balo/shared/notifications';
import type { SessionUser } from '@/lib/auth/session';

const {
  mockListRows,
  mockFindEngagementRequestId,
  mockFindUserIdByProfileId,
  mockFindById,
  mockListReviewCandidates,
  mockListRequestRelationshipIds,
  mockListDeliveryReviewStates,
  mockListInvitationCandidates,
  mockRelationshipsWithExpertMessage,
  mockListDeliveryOutcomes,
} = vi.hoisted(() => ({
  mockListRows: vi.fn(),
  mockFindEngagementRequestId: vi.fn(),
  mockFindUserIdByProfileId: vi.fn(),
  mockFindById: vi.fn(),
  mockListReviewCandidates: vi.fn(),
  mockListRequestRelationshipIds: vi.fn(),
  mockListDeliveryReviewStates: vi.fn(),
  mockListInvitationCandidates: vi.fn(),
  mockRelationshipsWithExpertMessage: vi.fn(),
  mockListDeliveryOutcomes: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  REQUEST_RELATIONSHIP_IDS_LIMIT: 3,
  reminderWaitsRepository: {
    listRows: mockListRows,
    findEngagementRequestId: mockFindEngagementRequestId,
    listRequestRelationshipIds: mockListRequestRelationshipIds,
    listDeliveryReviewStates: mockListDeliveryReviewStates,
    listDeliveryOutcomes: mockListDeliveryOutcomes,
  },
  requestExpertRelationshipsRepository: {
    listInvitationReminderCandidates: mockListInvitationCandidates,
  },
  conversationsRepository: { relationshipsWithExpertMessage: mockRelationshipsWithExpertMessage },
  expertsRepository: { findUserIdByProfileId: mockFindUserIdByProfileId },
  usersRepository: { findById: mockFindById },
  proposalsRepository: { listReviewCandidates: mockListReviewCandidates },
}));

import { log } from '@/lib/logging';
import { LOOKUP_FOLLOW_UPS_ROW_LIMIT, loadLookupFollowUps } from './load-lookup-follow-ups';

const NOW = new Date('2026-11-23T05:00:00.000Z');
const ANCHOR_ISO = '2026-11-16T03:00:00.000Z';
const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
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
    correlationId: `corr-${stepKey}` as string | null,
    recipient: { firstName: 'Dana', lastName: 'Whitfield', timezone: 'Australia/Melbourne' },
    entity: {
      title: 'Salesforce CPQ rollout',
      companyName: 'Northwind Industrial',
      agencyName: null,
    },
  };
}

function keyedRow(
  sequenceId: 'delivery_review' | 'invitation',
  entityId: string,
  anchorIso: string
) {
  return {
    ...dbRow('day_2'),
    id: `row-${sequenceId}-${entityId}`,
    dedupeKey: reminderSequenceKey({
      sequenceId,
      entityId,
      stepKey: sequenceId === 'delivery_review' ? 'pre_auto_accept' : 'day_1',
      userId: USER_ID,
      anchorIso,
    }),
    createdAt: new Date(anchorIso),
  };
}

const CANDIDATE = {
  projectRequestId: REQUEST_ID,
  companyId: 'c1',
  createdByUserId: USER_ID,
  title: 'Salesforce CPQ rollout',
  relationshipId: '00000000-0000-4000-8000-0000000000a1',
  relationshipStatus: 'proposal_submitted',
  proposalStatus: 'submitted',
  submittedAt: new Date(ANCHOR_ISO),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockListRows.mockResolvedValue([]);
  mockListReviewCandidates.mockResolvedValue([CANDIDATE]);
  mockFindById.mockResolvedValue({ firstName: 'Dana', timezone: 'Australia/Melbourne' });
  mockListRequestRelationshipIds.mockResolvedValue([]);
  mockListDeliveryReviewStates.mockResolvedValue([]);
  mockListInvitationCandidates.mockResolvedValue([]);
  mockRelationshipsWithExpertMessage.mockResolvedValue(new Set());
  mockListDeliveryOutcomes.mockResolvedValue([]);
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
    expect(mockListRequestRelationshipIds).not.toHaveBeenCalled();
    expect(mockListDeliveryReviewStates).not.toHaveBeenCalled();
    expect(mockListInvitationCandidates).not.toHaveBeenCalled();
    expect(mockListDeliveryOutcomes).not.toHaveBeenCalled();
  });
});

describe('loadLookupFollowUps — a user (person lens)', () => {
  it('reads every sequence prefix for that recipient, 90 days plus the span back', async () => {
    mockListRows.mockResolvedValue([dbRow('day_2')]);
    const result = await loadLookupFollowUps(viewer(), { type: 'user', id: USER_ID }, NOW);
    const input = mockListRows.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      keyPrefixes: ['seq:proposal_review:', 'seq:delivery_review:', 'seq:invitation:'],
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
    const other = '00000000-0000-4000-8000-000000000002';
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

  it('gives each sequence only its own ids, and an empty list makes no call', async () => {
    const relationshipId = '00000000-0000-4000-8000-0000000000a7';
    mockListRows.mockResolvedValue([keyedRow('invitation', relationshipId, ANCHOR_ISO)]);
    mockListInvitationCandidates.mockResolvedValue([]);
    await loadLookupFollowUps(viewer(), { type: 'expert', id: 'profile-1' }, NOW);
    expect(mockListInvitationCandidates).not.toHaveBeenCalled();
    expect(mockListReviewCandidates).not.toHaveBeenCalled();

    mockFindUserIdByProfileId.mockResolvedValue({ user: { id: USER_ID } });
    await loadLookupFollowUps(viewer(), { type: 'expert', id: 'profile-1' }, NOW);
    expect(mockListInvitationCandidates).toHaveBeenCalledWith({
      relationshipIds: [relationshipId],
    });
    expect(mockRelationshipsWithExpertMessage).toHaveBeenCalledWith([relationshipId]);
    expect(mockListReviewCandidates).not.toHaveBeenCalled();
    expect(mockListDeliveryReviewStates).not.toHaveBeenCalled();
  });

  it('sends a mixed person only their own sequence ids to each loader', async () => {
    mockListRows.mockResolvedValue([
      dbRow('day_2'),
      keyedRow('invitation', '00000000-0000-4000-8000-0000000000a7', ANCHOR_ISO),
      keyedRow('delivery_review', '00000000-0000-4000-8000-0000000000e3', ANCHOR_ISO),
    ]);
    await loadLookupFollowUps(viewer(), { type: 'user', id: USER_ID }, NOW);
    expect(mockListReviewCandidates).toHaveBeenCalledWith({ projectRequestIds: [REQUEST_ID] });
    expect(mockListInvitationCandidates).toHaveBeenCalledWith({
      relationshipIds: ['00000000-0000-4000-8000-0000000000a7'],
    });
    expect(mockListDeliveryReviewStates).toHaveBeenCalledWith([
      '00000000-0000-4000-8000-0000000000e3',
    ]);
  });

  it('still loads when a key names a non-uuid entity, and no liveness read receives that id', async () => {
    const goodRel = '00000000-0000-4000-8000-0000000000a7';
    mockListRows.mockResolvedValue([
      dbRow('day_2'),
      keyedRow('invitation', goodRel, ANCHOR_ISO),
      keyedRow('invitation', 'not-a-uuid', ANCHOR_ISO),
      keyedRow('delivery_review', 'also-not-a-uuid', ANCHOR_ISO),
    ]);
    const result = await loadLookupFollowUps(viewer(), { type: 'user', id: USER_ID }, NOW);

    expect(result.ok).toBe(true);
    expect(mockListInvitationCandidates).toHaveBeenCalledWith({ relationshipIds: [goodRel] });
    expect(mockRelationshipsWithExpertMessage).toHaveBeenCalledWith([goodRel]);
    expect(mockListDeliveryReviewStates).not.toHaveBeenCalled();
    const received = [
      ...mockListReviewCandidates.mock.calls.flatMap(([arg]) => arg.projectRequestIds),
      ...mockListInvitationCandidates.mock.calls.flatMap(([arg]) => arg.relationshipIds),
      ...mockRelationshipsWithExpertMessage.mock.calls.flatMap(([ids]) => [...ids]),
      ...mockListDeliveryReviewStates.mock.calls.flatMap(([ids]) => ids),
    ];
    expect(received).not.toContain('not-a-uuid');
    expect(received).not.toContain('also-not-a-uuid');
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
  it('reads the request’s proposal prefix and one invitation prefix per relationship', async () => {
    mockListRequestRelationshipIds.mockResolvedValue([
      '00000000-0000-4000-8000-0000000000a1',
      '00000000-0000-4000-8000-0000000000a2',
    ]);
    mockListRows.mockResolvedValue([dbRow('day_2')]);
    const result = await loadLookupFollowUps(
      viewer(),
      { type: 'project_request', id: REQUEST_ID },
      NOW
    );
    const input = mockListRows.mock.calls[0]?.[0];
    expect(mockListRequestRelationshipIds).toHaveBeenCalledWith(REQUEST_ID);
    expect(input.keyPrefixes).toEqual([
      `seq:proposal_review:${REQUEST_ID}:`,
      'seq:invitation:00000000-0000-4000-8000-0000000000a1:',
      'seq:invitation:00000000-0000-4000-8000-0000000000a2:',
    ]);
    expect(input.keyPrefixes.some((p: string) => p.startsWith('seq:delivery_review:'))).toBe(false);
    expect(input.recipientUserId).toBeUndefined();
    expect(mockFindById).not.toHaveBeenCalled();
    expect(result.ok && result.view.lens).toBe('entity');
    expect(result.ok && result.view.origin).toBeNull();
    expect(result.ok && result.view.limit).toBeNull();
  });

  it('asks the invitation source about the relationships, and the delivery source about nothing', async () => {
    mockListRequestRelationshipIds.mockResolvedValue(['00000000-0000-4000-8000-0000000000a1']);
    await loadLookupFollowUps(viewer(), { type: 'project_request', id: REQUEST_ID }, NOW);
    expect(mockListReviewCandidates).toHaveBeenCalledWith({ projectRequestIds: [REQUEST_ID] });
    expect(mockListInvitationCandidates).toHaveBeenCalledWith({
      relationshipIds: ['00000000-0000-4000-8000-0000000000a1'],
    });
    expect(mockListDeliveryReviewStates).not.toHaveBeenCalled();
  });

  it('warns when the relationship id list reaches its limit, and not below it', async () => {
    mockListRequestRelationshipIds.mockResolvedValue(['a', 'b']);
    await loadLookupFollowUps(viewer(), { type: 'project_request', id: REQUEST_ID }, NOW);
    expect(log.warn).not.toHaveBeenCalledWith(
      'Admin lookup follow-ups hit the relationship limit',
      expect.anything()
    );

    mockListRequestRelationshipIds.mockResolvedValue(['a', 'b', 'c']);
    await loadLookupFollowUps(viewer(), { type: 'project_request', id: REQUEST_ID }, NOW);
    expect(log.warn).toHaveBeenCalledWith(
      'Admin lookup follow-ups hit the relationship limit',
      expect.objectContaining({ entityId: REQUEST_ID, limit: 3 })
    );
  });

  it('a request with no relationships reads only its proposal prefix and makes no invitation call', async () => {
    await loadLookupFollowUps(viewer(), { type: 'project_request', id: REQUEST_ID }, NOW);
    expect(mockListRows.mock.calls[0]?.[0].keyPrefixes).toEqual([
      `seq:proposal_review:${REQUEST_ID}:`,
    ]);
    expect(mockListInvitationCandidates).not.toHaveBeenCalled();
    expect(mockRelationshipsWithExpertMessage).not.toHaveBeenCalled();
  });

  it('shows an invitation as waiting while the expert still owes an answer', async () => {
    mockListRequestRelationshipIds.mockResolvedValue(['00000000-0000-4000-8000-0000000000a1']);
    mockListRows.mockResolvedValue([
      keyedRow('invitation', '00000000-0000-4000-8000-0000000000a1', ANCHOR_ISO),
    ]);
    mockListInvitationCandidates.mockResolvedValue([
      {
        relationshipId: '00000000-0000-4000-8000-0000000000a1',
        title: 'Salesforce CPQ rollout',
        requestStatus: 'open',
        relationshipStatus: 'invited',
        onDirectLeg: false,
        availabilitySharedAt: null,
        invitedAt: new Date(ANCHOR_ISO),
      },
    ]);
    const result = await loadLookupFollowUps(
      viewer(),
      { type: 'project_request', id: REQUEST_ID },
      NOW
    );
    expect(result.ok && result.view.now).toHaveLength(1);
  });

  it('shows an invitation as stopped once the expert has written in the thread', async () => {
    mockListRequestRelationshipIds.mockResolvedValue(['00000000-0000-4000-8000-0000000000a1']);
    mockListRows.mockResolvedValue([
      keyedRow('invitation', '00000000-0000-4000-8000-0000000000a1', ANCHOR_ISO),
    ]);
    mockListInvitationCandidates.mockResolvedValue([
      {
        relationshipId: '00000000-0000-4000-8000-0000000000a1',
        title: 'Salesforce CPQ rollout',
        requestStatus: 'open',
        relationshipStatus: 'eoi_submitted',
        onDirectLeg: true,
        availabilitySharedAt: null,
        invitedAt: new Date(ANCHOR_ISO),
      },
    ]);
    mockRelationshipsWithExpertMessage.mockResolvedValue(
      new Set(['00000000-0000-4000-8000-0000000000a1'])
    );
    const result = await loadLookupFollowUps(
      viewer(),
      { type: 'project_request', id: REQUEST_ID },
      NOW
    );
    expect(result.ok && result.view.now).toHaveLength(0);
    expect(result.ok && result.view.earlier).toHaveLength(1);
  });
});

describe('loadLookupFollowUps — an engagement (decision 1)', () => {
  it('reads its own delivery prefix and the originating request’s proposal prefix', async () => {
    mockFindEngagementRequestId.mockResolvedValue({
      projectRequestId: REQUEST_ID,
      requestTitle: 'Salesforce CPQ rollout',
    });
    mockListRows.mockResolvedValue([dbRow('day_2')]);
    const result = await loadLookupFollowUps(
      viewer(),
      { type: 'engagement', id: '00000000-0000-4000-8000-0000000000e1' },
      NOW
    );
    expect(mockListRows.mock.calls[0]?.[0].keyPrefixes).toEqual([
      'seq:delivery_review:00000000-0000-4000-8000-0000000000e1:',
      `seq:proposal_review:${REQUEST_ID}:`,
    ]);
    expect(mockListDeliveryReviewStates).toHaveBeenCalledWith([
      '00000000-0000-4000-8000-0000000000e1',
    ]);
    expect(mockListReviewCandidates).toHaveBeenCalledWith({ projectRequestIds: [REQUEST_ID] });
    expect(result.ok && result.view.origin).toEqual({ requestTitle: 'Salesforce CPQ rollout' });
  });

  it('takes the origin title from the engagement read, not from live proposals', async () => {
    mockFindEngagementRequestId.mockResolvedValue({
      projectRequestId: REQUEST_ID,
      requestTitle: 'Salesforce CPQ rollout',
    });
    mockListRows.mockResolvedValue([dbRow('day_2')]);
    mockListReviewCandidates.mockResolvedValue([]);
    const result = await loadLookupFollowUps(
      viewer(),
      { type: 'engagement', id: '00000000-0000-4000-8000-0000000000e1' },
      NOW
    );
    expect(result.ok && result.view.origin).toEqual({ requestTitle: 'Salesforce CPQ rollout' });
  });

  it('an engagement with no originating request reads only its delivery prefix', async () => {
    mockFindEngagementRequestId.mockResolvedValue({ projectRequestId: null, requestTitle: null });
    const result = await loadLookupFollowUps(
      viewer(),
      { type: 'engagement', id: '00000000-0000-4000-8000-0000000000e1' },
      NOW
    );
    expect(mockListRows.mock.calls[0]?.[0].keyPrefixes).toEqual([
      'seq:delivery_review:00000000-0000-4000-8000-0000000000e1:',
    ]);
    expect(mockListReviewCandidates).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      view: { lens: 'entity', now: [], earlier: [], origin: null },
    });
  });

  it('shows a delivery wait as waiting while the project awaits acceptance', async () => {
    mockFindEngagementRequestId.mockResolvedValue({ projectRequestId: null, requestTitle: null });
    mockListRows.mockResolvedValue([
      keyedRow('delivery_review', '00000000-0000-4000-8000-0000000000e1', ANCHOR_ISO),
    ]);
    mockListDeliveryReviewStates.mockResolvedValue([
      {
        engagementId: '00000000-0000-4000-8000-0000000000e1',
        status: 'pending_acceptance',
        completionRequestedAt: new Date(ANCHOR_ISO),
      },
    ]);
    const result = await loadLookupFollowUps(
      viewer(),
      { type: 'engagement', id: '00000000-0000-4000-8000-0000000000e1' },
      NOW
    );
    expect(result.ok && result.view.now).toHaveLength(1);
  });

  it('shows a delivery wait as stopped once the work is accepted', async () => {
    mockFindEngagementRequestId.mockResolvedValue({ projectRequestId: null, requestTitle: null });
    mockListRows.mockResolvedValue([
      keyedRow('delivery_review', '00000000-0000-4000-8000-0000000000e1', ANCHOR_ISO),
    ]);
    mockListDeliveryReviewStates.mockResolvedValue([
      {
        engagementId: '00000000-0000-4000-8000-0000000000e1',
        status: 'completed',
        completionRequestedAt: new Date(ANCHOR_ISO),
      },
    ]);
    const result = await loadLookupFollowUps(
      viewer(),
      { type: 'engagement', id: '00000000-0000-4000-8000-0000000000e1' },
      NOW
    );
    expect(result.ok && result.view.now).toHaveLength(0);
    expect(result.ok && result.view.earlier).toHaveLength(1);
  });

  it('an unknown engagement is not_found', async () => {
    mockFindEngagementRequestId.mockResolvedValue(undefined);
    const result = await loadLookupFollowUps(viewer(), { type: 'engagement', id: 'nope' }, NOW);
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(mockListRows).not.toHaveBeenCalled();
  });
});

describe('loadLookupFollowUps — delivery outcomes and truncation (BAL-666)', () => {
  it('reads the delivery outcomes in ONE batched call, for published rows with a correlation id only', async () => {
    mockListRows.mockResolvedValue([
      dbRow('day_2'),
      dbRow('day_5', 'pending'),
      { ...dbRow('day_9'), correlationId: null },
    ]);
    await loadLookupFollowUps(viewer(), { type: 'user', id: USER_ID }, NOW);
    expect(mockListDeliveryOutcomes).toHaveBeenCalledTimes(1);
    expect(mockListDeliveryOutcomes).toHaveBeenCalledWith({ correlationIds: ['corr-day_2'] });
  });

  it('carries a logged outcome onto the step as a delivery line', async () => {
    mockListRows.mockResolvedValue([dbRow('day_2')]);
    mockListDeliveryOutcomes.mockResolvedValue([
      { correlationId: 'corr-day_2', channel: 'email', status: 'sent', error: null },
    ]);
    const result = await loadLookupFollowUps(viewer(), { type: 'user', id: USER_ID }, NOW);
    const step = result.ok ? result.view.now[0]?.steps[0] : undefined;
    expect(step?.delivery.map((line) => line.text)).toEqual(['Email sent']);
  });

  it('flags the row cap in the view when it is hit, and not below it', async () => {
    mockListRows.mockResolvedValue(
      Array.from({ length: LOOKUP_FOLLOW_UPS_ROW_LIMIT }, () => dbRow('day_2'))
    );
    const hit = await loadLookupFollowUps(viewer(), { type: 'user', id: USER_ID }, NOW);
    expect(hit.ok && hit.view.truncated).toEqual({
      rows: LOOKUP_FOLLOW_UPS_ROW_LIMIT,
      relationships: null,
    });

    mockListRows.mockResolvedValue([dbRow('day_2')]);
    const below = await loadLookupFollowUps(viewer(), { type: 'user', id: USER_ID }, NOW);
    expect(below.ok && below.view.truncated).toEqual({ rows: null, relationships: null });
  });

  it('flags the relationship cap on a request lens when it is hit, and not below it', async () => {
    mockListRequestRelationshipIds.mockResolvedValue(['a', 'b', 'c']);
    const hit = await loadLookupFollowUps(
      viewer(),
      { type: 'project_request', id: REQUEST_ID },
      NOW
    );
    expect(hit.ok && hit.view.truncated).toEqual({ rows: null, relationships: 3 });

    mockListRequestRelationshipIds.mockResolvedValue(['a', 'b']);
    const below = await loadLookupFollowUps(
      viewer(),
      { type: 'project_request', id: REQUEST_ID },
      NOW
    );
    expect(below.ok && below.view.truncated).toEqual({ rows: null, relationships: null });
  });
});
