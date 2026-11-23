import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ProposalReviewCandidateRow } from '@balo/db';

const { mockList, mockParticipates } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockParticipates: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  proposalsRepository: { listReviewCandidates: mockList },
  clientPartyRecipientsRepository: { bookerStillParticipatesInCompany: mockParticipates },
}));

import { proposalReviewEntities, proposalReviewSequence } from './proposal-review.js';

function candidate(
  overrides: Partial<ProposalReviewCandidateRow> = {}
): ProposalReviewCandidateRow {
  return {
    projectRequestId: 'req-1',
    companyId: 'co-1',
    createdByUserId: 'user-1',
    title: 'CRM rollout',
    relationshipId: 'rel-1',
    relationshipStatus: 'proposal_submitted',
    proposalStatus: 'submitted',
    submittedAt: new Date('2026-11-02T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('proposalReviewEntities', () => {
  it('counts every awaiting relationship and anchors on the oldest submit time', () => {
    const entities = proposalReviewEntities([
      candidate({ relationshipId: 'a', submittedAt: new Date('2026-11-04T00:00:00.000Z') }),
      candidate({ relationshipId: 'b', submittedAt: new Date('2026-11-02T00:00:00.000Z') }),
      candidate({ relationshipId: 'c', submittedAt: new Date('2026-11-03T00:00:00.000Z') }),
    ]);
    expect(entities).toHaveLength(1);
    expect(entities[0]?.anchor).toEqual(new Date('2026-11-02T00:00:00.000Z'));
    expect(entities[0]?.fresh).toEqual({ awaitingCount: 3, title: 'CRM rollout' });
    expect(entities[0]?.candidateUserIds).toEqual(['user-1']);
  });

  it('returns no entity when every proposal has had changes requested', () => {
    expect(
      proposalReviewEntities([
        candidate({ proposalStatus: 'changes_requested' }),
        candidate({ relationshipId: 'b', proposalStatus: 'changes_requested' }),
      ])
    ).toEqual([]);
  });

  it('counts an awaiting relationship with no proposal row but never anchors on it', () => {
    const [entity] = proposalReviewEntities([
      candidate({ proposalStatus: null, submittedAt: null }),
      candidate({ relationshipId: 'b' }),
    ]);
    expect(entity?.fresh.awaitingCount).toBe(2);
    expect(entity?.anchor).toEqual(new Date('2026-11-02T00:00:00.000Z'));
  });

  it('returns no entity when no awaiting row has a submit time', () => {
    expect(
      proposalReviewEntities([candidate({ proposalStatus: null, submittedAt: null })])
    ).toEqual([]);
  });

  it('keeps separate requests apart', () => {
    const entities = proposalReviewEntities([
      candidate(),
      candidate({ projectRequestId: 'req-2', relationshipId: 'z' }),
    ]);
    expect(entities.map((entity) => entity.entityId)).toEqual(['req-1', 'req-2']);
  });
});

describe('proposalReviewSequence', () => {
  it('find reads every candidate', async () => {
    mockList.mockResolvedValue([candidate()]);
    const entities = await proposalReviewSequence.find(new Date());
    expect(mockList).toHaveBeenCalledWith();
    expect(entities).toHaveLength(1);
  });

  it('evaluate reads one request and returns null when nothing waits', async () => {
    mockList.mockResolvedValue([candidate({ proposalStatus: 'changes_requested' })]);
    expect(await proposalReviewSequence.evaluate('req-1')).toBeNull();
    expect(mockList).toHaveBeenCalledWith({ projectRequestId: 'req-1' });
  });

  it('resolves the request creator while they still participate', async () => {
    mockParticipates.mockResolvedValue(true);
    const [entity] = proposalReviewEntities([candidate()]);
    if (entity === undefined) throw new Error('expected an entity');
    expect(await proposalReviewSequence.resolveRecipients(entity)).toEqual(['user-1']);
    expect(mockParticipates).toHaveBeenCalledWith('co-1', 'user-1');
  });

  it('resolves no recipient once the creator has left the company', async () => {
    mockParticipates.mockResolvedValue(false);
    const [entity] = proposalReviewEntities([candidate()]);
    if (entity === undefined) throw new Error('expected an entity');
    expect(await proposalReviewSequence.resolveRecipients(entity)).toEqual([]);
  });

  it('matches a stored payload only when its projectRequestId is the entity', () => {
    expect(
      proposalReviewSequence.payloadMatchesEntity({ projectRequestId: 'req-1' }, 'req-1')
    ).toBe(true);
    expect(
      proposalReviewSequence.payloadMatchesEntity({ projectRequestId: 'req-2' }, 'req-1')
    ).toBe(false);
    expect(proposalReviewSequence.payloadMatchesEntity({}, 'req-1')).toBe(false);
  });

  it('reports on email only and has no extra publish tracking', () => {
    expect(proposalReviewSequence.channels).toEqual(['email']);
    expect(proposalReviewSequence.trackPublished).toBeUndefined();
  });

  it('builds a payload with no price, budget or email address', () => {
    const [entity] = proposalReviewEntities([candidate()]);
    if (entity === undefined) throw new Error('expected an entity');
    expect(proposalReviewSequence.buildPayload(entity, 'day_2', 'user-1', 'c-1')).toEqual({
      correlationId: 'c-1',
      sequenceId: 'proposal_review',
      step: 'day_2',
      entityId: 'req-1',
      anchorIso: '2026-11-02T00:00:00.000Z',
      recipientUserId: 'user-1',
      projectRequestId: 'req-1',
      title: 'CRM rollout',
      awaitingCount: 1,
    });
  });
});
