import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ProjectEngagementRow, ProjectEngagementWithMilestones } from '@balo/db';
import {
  REMINDER_ARMABLE_AFTER_DUE_MS,
  REMINDER_SEQUENCE_STEPS,
  reminderSequenceKey,
} from '@balo/shared/notifications';

const { mockList, mockFind, mockOwner, mockTrack, mockLogger } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockFind: vi.fn(),
  mockOwner: vi.fn(),
  mockTrack: vi.fn(),
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@balo/db', () => ({
  projectEngagementsRepository: {
    listPendingAutoAccept: mockList,
    findWithMilestones: mockFind,
  },
  companiesRepository: { findOwnerUserIdByCompanyId: mockOwner },
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrack,
  ENGAGEMENT_SERVER_EVENTS: { REVIEW_REMINDER_SENT: 'engagement_review_reminder_sent' },
}));
vi.mock('@balo/shared/logging', () => ({ createLogger: () => mockLogger }));

import {
  deliveryReviewDaysLeft,
  deliveryReviewEntity,
  deliveryReviewSequence,
} from './delivery-review.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const NOW = new Date('2026-07-08T12:00:00.000Z');
// Five days before NOW: exactly the step's due instant.
const ANCHOR = new Date('2026-07-03T12:00:00.000Z');

function engagement(
  over: Partial<ProjectEngagementWithMilestones> = {}
): ProjectEngagementWithMilestones {
  return {
    id: 'eng-1',
    status: 'pending_acceptance',
    completionRequestedAt: ANCHOR,
    company: { id: 'co-1', name: 'Northwind Industrial' },
    expertProfile: {
      type: 'agency',
      user: { firstName: 'Priya', lastName: 'Sharma' },
    },
    deliveringAgency: { id: 'ag-1', name: 'CloudPeak Consulting', logoUrl: null },
    projectRequest: { title: 'CPQ implementation' },
    milestones: [{ id: 'm-1' }, { id: 'm-2' }],
    ...over,
  } as unknown as ProjectEngagementWithMilestones;
}

function pendingRow(id: string, requestedAt: Date | null): ProjectEngagementRow {
  return { id, completionRequestedAt: requestedAt } as unknown as ProjectEngagementRow;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockOwner.mockResolvedValue('owner-1');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('deliveryReviewDaysLeft', () => {
  const autoAt = new Date(ANCHOR.getTime() + 7 * DAY_MS);

  it('is 2 at anchor + 5 days', () => {
    expect(deliveryReviewDaysLeft(autoAt, new Date(ANCHOR.getTime() + 5 * DAY_MS))).toBe(2);
  });

  it('is 1 at anchor + 6 days 1 hour', () => {
    expect(deliveryReviewDaysLeft(autoAt, new Date(ANCHOR.getTime() + 6 * DAY_MS + HOUR_MS))).toBe(
      1
    );
  });

  it('never drops below 1 once auto-accept has passed', () => {
    expect(deliveryReviewDaysLeft(autoAt, new Date(ANCHOR.getTime() + 9 * DAY_MS))).toBe(1);
  });
});

describe('deliveryReviewEntity', () => {
  it('anchors on the completion request and carries the live display fields', () => {
    const entity = deliveryReviewEntity(engagement(), 'owner-1', NOW);
    expect(entity).toEqual({
      entityId: 'eng-1',
      anchor: ANCHOR,
      companyId: 'co-1',
      candidateUserIds: ['owner-1'],
      fresh: {
        clientCompanyName: 'Northwind Industrial',
        expertPartyLabel: 'CloudPeak Consulting',
        projectTitle: 'CPQ implementation',
        milestonesTotal: 2,
        requestedDate: '3 Jul',
        autoDate: '10 Jul',
        daysLeft: 2,
      },
    });
  });

  it('has no candidate when the company has no live owner', () => {
    expect(deliveryReviewEntity(engagement(), undefined, NOW)?.candidateUserIds).toEqual([]);
  });

  it.each(['active', 'completed'] as const)('is null for a %s project', (status) => {
    expect(deliveryReviewEntity(engagement({ status }), 'owner-1', NOW)).toBeNull();
  });

  it('is null when there is no completion request', () => {
    expect(
      deliveryReviewEntity(engagement({ completionRequestedAt: null }), 'owner-1', NOW)
    ).toBeNull();
  });

  it('a later completion request is a new anchor and so a new registry key', () => {
    const keyFor = (requestedAt: Date): string => {
      const entity = deliveryReviewEntity(
        engagement({ completionRequestedAt: requestedAt }),
        'owner-1',
        NOW
      );
      if (entity === null) throw new Error('expected an entity');
      return reminderSequenceKey({
        sequenceId: 'delivery_review',
        entityId: entity.entityId,
        stepKey: 'pre_auto_accept',
        userId: 'owner-1',
        anchorIso: entity.anchor.toISOString(),
      });
    };
    expect(keyFor(new Date('2026-07-10T12:00:00.000Z'))).not.toBe(keyFor(ANCHOR));
  });
});

describe('deliveryReviewSequence.evaluate', () => {
  it('returns the entity for a pending project', async () => {
    mockFind.mockResolvedValue(engagement());
    const entity = await deliveryReviewSequence.evaluate('eng-1');
    expect(entity?.entityId).toBe('eng-1');
    expect(mockOwner).toHaveBeenCalledWith('co-1');
  });

  it.each([
    ['completed', engagement({ status: 'completed' })],
    ['active (sent back or withdrawn)', engagement({ status: 'active' })],
    ['gone', undefined],
  ])('returns null for a %s project without reading the owner', async (_label, found) => {
    mockFind.mockResolvedValue(found);
    expect(await deliveryReviewSequence.evaluate('eng-1')).toBeNull();
    expect(mockOwner).not.toHaveBeenCalled();
  });
});

describe('deliveryReviewSequence.resolveRecipients', () => {
  it('is the live owner', async () => {
    const entity = deliveryReviewEntity(engagement(), 'owner-1', NOW);
    if (entity === null) throw new Error('expected an entity');
    expect(await deliveryReviewSequence.resolveRecipients(entity)).toEqual(['owner-1']);
  });

  it('is empty when there is no live owner', async () => {
    const entity = deliveryReviewEntity(engagement(), undefined, NOW);
    if (entity === null) throw new Error('expected an entity');
    expect(await deliveryReviewSequence.resolveRecipients(entity)).toEqual([]);
  });
});

describe('deliveryReviewSequence.find', () => {
  const [step] = REMINDER_SEQUENCE_STEPS.delivery_review;
  const offsetMs = (step?.offsetMinutes ?? 0) * 60_000;

  it('asks for rows no newer than the arming edge of the step window', async () => {
    mockList.mockResolvedValue([]);
    await deliveryReviewSequence.find(NOW);
    expect(mockList).toHaveBeenCalledWith(new Date(NOW.getTime() - offsetMs + HOUR_MS));
  });

  it('hydrates a row inside the window and returns its entity', async () => {
    mockList.mockResolvedValue([pendingRow('eng-1', ANCHOR)]);
    mockFind.mockResolvedValue(engagement());
    const entities = await deliveryReviewSequence.find(NOW);
    expect(entities.map((entity) => entity.entityId)).toEqual(['eng-1']);
  });

  it('never hydrates a row whose request is older than the armable window', async () => {
    const tooOld = new Date(NOW.getTime() - offsetMs - REMINDER_ARMABLE_AFTER_DUE_MS - 2 * HOUR_MS);
    mockList.mockResolvedValue([pendingRow('old', tooOld), pendingRow('none', null)]);
    expect(await deliveryReviewSequence.find(NOW)).toEqual([]);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('drops a row that is no longer pending once hydrated', async () => {
    mockList.mockResolvedValue([pendingRow('eng-1', ANCHOR)]);
    mockFind.mockResolvedValue(engagement({ status: 'completed' }));
    expect(await deliveryReviewSequence.find(NOW)).toEqual([]);
  });

  it('logs a row that throws with its entity id and still returns the others', async () => {
    mockList.mockResolvedValue([pendingRow('bad', ANCHOR), pendingRow('good', ANCHOR)]);
    mockFind.mockImplementation((id: string) =>
      id === 'bad'
        ? Promise.reject(new Error('balo_fee_bps missing'))
        : Promise.resolve(engagement({ id: 'good' }))
    );
    const entities = await deliveryReviewSequence.find(NOW);
    expect(entities.map((entity) => entity.entityId)).toEqual(['good']);
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        sequence: 'delivery_review',
        entityId: 'bad',
        error: 'balo_fee_bps missing',
      }),
      expect.any(String)
    );
  });
});

describe('deliveryReviewSequence.payloadMatchesEntity', () => {
  it('matches the engagement id with recipientId equal to recipientUserId', () => {
    expect(
      deliveryReviewSequence.payloadMatchesEntity(
        { engagementId: 'eng-1', recipientId: 'owner-1', recipientUserId: 'owner-1' },
        'eng-1'
      )
    ).toBe(true);
  });

  it('rejects a different engagement id', () => {
    expect(
      deliveryReviewSequence.payloadMatchesEntity(
        { engagementId: 'eng-2', recipientId: 'owner-1', recipientUserId: 'owner-1' },
        'eng-1'
      )
    ).toBe(false);
  });

  it('rejects a recipientId that is not the recipientUserId, or is missing', () => {
    expect(
      deliveryReviewSequence.payloadMatchesEntity(
        { engagementId: 'eng-1', recipientId: 'other', recipientUserId: 'owner-1' },
        'eng-1'
      )
    ).toBe(false);
    expect(
      deliveryReviewSequence.payloadMatchesEntity(
        { engagementId: 'eng-1', recipientUserId: 'owner-1' },
        'eng-1'
      )
    ).toBe(false);
  });
});

describe('deliveryReviewSequence.buildPayload', () => {
  it('carries every review-reminder field, with recipientId = recipientUserId = the owner', () => {
    const entity = deliveryReviewEntity(engagement(), 'owner-1', NOW);
    if (entity === null) throw new Error('expected an entity');
    expect(
      deliveryReviewSequence.buildPayload(entity, 'pre_auto_accept', 'owner-1', 'c-1')
    ).toEqual({
      correlationId: 'c-1',
      sequenceId: 'delivery_review',
      step: 'pre_auto_accept',
      entityId: 'eng-1',
      anchorIso: ANCHOR.toISOString(),
      recipientUserId: 'owner-1',
      recipientId: 'owner-1',
      engagementId: 'eng-1',
      clientCompanyName: 'Northwind Industrial',
      expertPartyLabel: 'CloudPeak Consulting',
      projectTitle: 'CPQ implementation',
      milestonesTotal: 2,
      requestedDate: '3 Jul',
      autoDate: '10 Jul',
      daysLeft: 2,
    });
  });

  it('falls back to blank text and a one-day window when fresh fields are missing', () => {
    const payload = deliveryReviewSequence.buildPayload(
      {
        entityId: 'eng-1',
        anchor: ANCHOR,
        companyId: 'co-1',
        candidateUserIds: ['owner-1'],
        fresh: {},
      },
      'pre_auto_accept',
      'owner-1',
      'c-1'
    );
    expect(payload).toMatchObject({
      clientCompanyName: '',
      projectTitle: '',
      milestonesTotal: 0,
      daysLeft: 1,
    });
  });
});

describe('deliveryReviewSequence.trackPublished', () => {
  it('tracks the legacy review-reminder event against the owner', () => {
    deliveryReviewSequence.trackPublished?.({ engagementId: 'eng-1', recipientUserId: 'owner-1' });
    expect(mockTrack).toHaveBeenCalledWith('engagement_review_reminder_sent', {
      engagement_id: 'eng-1',
      distinct_id: 'owner-1',
    });
  });

  it.each([
    { recipientUserId: 'owner-1' },
    { engagementId: 'eng-1' },
    { engagementId: '', recipientUserId: 'owner-1' },
  ])('tracks nothing for a payload missing an id: %j', (payload) => {
    deliveryReviewSequence.trackPublished?.(payload);
    expect(mockTrack).not.toHaveBeenCalled();
  });
});
