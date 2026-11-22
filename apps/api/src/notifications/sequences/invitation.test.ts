import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { InvitationReminderCandidateRow } from '@balo/db';

const { mockList, mockWrote } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockWrote: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  requestExpertRelationshipsRepository: { listInvitationReminderCandidates: mockList },
  conversationsRepository: { relationshipsWithExpertMessage: mockWrote },
}));

import { INVITATION_FIND_WINDOW_MS, invitationEntities, invitationSequence } from './invitation.js';

const INVITED_AT = new Date('2026-11-02T00:00:00.000Z');

function candidate(
  overrides: Partial<InvitationReminderCandidateRow> = {}
): InvitationReminderCandidateRow {
  return {
    relationshipId: 'rel-1',
    projectRequestId: 'req-1',
    companyId: 'co-1',
    companyName: 'Northwind',
    title: 'CRM rollout',
    expertUserId: 'expert-1',
    requestStatus: 'experts_invited',
    relationshipStatus: 'invited',
    onDirectLeg: false,
    availabilitySharedAt: null,
    invitedAt: INVITED_AT,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue([candidate()]);
  mockWrote.mockResolvedValue(new Set<string>());
});

describe('invitationEntities', () => {
  it('maps an invited expert to an entity anchored on invited_at, for that expert only', () => {
    const [entity, ...rest] = invitationEntities([candidate()], new Set());
    expect(rest).toEqual([]);
    expect(entity).toEqual({
      entityId: 'rel-1',
      anchor: INVITED_AT,
      companyId: 'co-1',
      candidateUserIds: ['expert-1'],
      fresh: { title: 'CRM rollout', projectRequestId: 'req-1', companyName: 'Northwind' },
    });
  });

  it.each(['closed', 'accepted', 'kickoff_approved'])(
    'drops a row whose request is %s',
    (requestStatus) => {
      expect(invitationEntities([candidate({ requestStatus })], new Set())).toEqual([]);
    }
  );

  it('drops an expression of interest that is off the direct leg', () => {
    expect(
      invitationEntities([candidate({ relationshipStatus: 'eoi_submitted' })], new Set())
    ).toEqual([]);
  });

  it('keeps a direct-leg row until availability is shared', () => {
    const direct = { relationshipStatus: 'eoi_submitted', onDirectLeg: true };
    expect(invitationEntities([candidate(direct)], new Set())).toHaveLength(1);
    expect(
      invitationEntities(
        [candidate({ ...direct, availabilitySharedAt: new Date('2026-11-03T00:00:00.000Z') })],
        new Set()
      )
    ).toEqual([]);
  });

  it('drops a direct-leg row once the expert has written a message', () => {
    const direct = candidate({ relationshipStatus: 'eoi_submitted', onDirectLeg: true });
    expect(invitationEntities([direct], new Set(['rel-1']))).toEqual([]);
  });

  it('keeps an invited row whatever the message set says', () => {
    expect(invitationEntities([candidate()], new Set(['rel-1']))).toHaveLength(1);
  });
});

describe('invitationSequence', () => {
  it('declares an expert email sequence that counts toward the daily limit', () => {
    expect(invitationSequence).toMatchObject({
      id: 'invitation',
      event: 'project.invitation_reminder',
      entityIdField: 'relationshipId',
      channel: 'email',
      audience: 'expert',
      cadence: 'hourly',
      exemptFromDailyLimit: false,
    });
  });

  it('finds from exactly 14 days before now and asks about those relationships only', async () => {
    const now = new Date('2026-11-20T00:00:00.000Z');
    expect(INVITATION_FIND_WINDOW_MS).toBe(14 * 24 * 60 * 60 * 1000);
    const entities = await invitationSequence.find(now);
    expect(mockList).toHaveBeenCalledWith({
      invitedSince: new Date(now.getTime() - INVITATION_FIND_WINDOW_MS),
    });
    expect(mockWrote).toHaveBeenCalledWith(['rel-1']);
    expect(entities).toHaveLength(1);
  });

  it('evaluates one relationship with no window, or null when it no longer waits', async () => {
    expect((await invitationSequence.evaluate('rel-1'))?.entityId).toBe('rel-1');
    expect(mockList).toHaveBeenCalledWith({ relationshipId: 'rel-1' });
    mockList.mockResolvedValue([candidate({ requestStatus: 'closed' })]);
    expect(await invitationSequence.evaluate('rel-1')).toBeNull();
  });

  it('resolves only the invited expert', async () => {
    const [entity] = invitationEntities([candidate()], new Set());
    if (entity === undefined) {
      throw new Error('expected an entity');
    }
    expect(await invitationSequence.resolveRecipients(entity)).toEqual(['expert-1']);
  });

  it('builds a payload with exactly the agreed fields and no money', () => {
    const [entity] = invitationEntities([candidate()], new Set());
    if (entity === undefined) {
      throw new Error('expected an entity');
    }
    const payload = invitationSequence.buildPayload(entity, 'day_1', 'expert-1', 'c-1');
    expect(payload).toEqual({
      correlationId: 'c-1',
      sequenceId: 'invitation',
      step: 'day_1',
      entityId: 'rel-1',
      anchorIso: INVITED_AT.toISOString(),
      recipientUserId: 'expert-1',
      relationshipId: 'rel-1',
      projectRequestId: 'req-1',
      title: 'CRM rollout',
      companyName: 'Northwind',
    });
    expect(Object.keys(payload).sort((a, b) => a.localeCompare(b))).toEqual([
      'anchorIso',
      'companyName',
      'correlationId',
      'entityId',
      'projectRequestId',
      'recipientUserId',
      'relationshipId',
      'sequenceId',
      'step',
      'title',
    ]);
  });
});
