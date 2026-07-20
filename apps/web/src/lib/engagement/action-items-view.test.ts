import { describe, it, expect } from 'vitest';
import type { ActionItem, EngagementWithMilestones } from '@balo/db';
import type { EngagementLens, EngagementViewerContext } from './resolve-engagement-lens';
import { mapActionItemsToView } from './action-items-view';

// Deterministic "now" — all date math runs under TZ=UTC (see vitest env).
const NOW = new Date('2026-07-07T00:00:00.000Z');
const CREATED = new Date('2026-06-12T00:00:00.000Z');

function makeEngagement(over: Partial<EngagementWithMilestones> = {}): EngagementWithMilestones {
  return {
    id: 'eng-1',
    companyId: 'company-northwind',
    expertProfileId: 'expert-priya',
    status: 'active',
    milestones: [],
    expertProfile: {
      id: 'expert-priya',
      agencyId: null,
      type: 'freelancer',
      headline: 'CPQ Specialist',
      user: { id: 'user-priya', firstName: 'Priya', lastName: 'Sharma', avatarUrl: null },
      agency: null,
    },
    company: { id: 'company-northwind', name: 'Northwind Industrial' },
    ...over,
  } as EngagementWithMilestones;
}

function makeActionItem(over: Partial<ActionItem> = {}): ActionItem {
  return {
    id: 'ai-1',
    engagementId: 'eng-1',
    meetingId: null,
    body: 'Send the migration plan',
    status: 'open',
    source: 'manual',
    assigneeParty: null,
    dueAt: null,
    createdByUserId: 'user-priya',
    assignedByUserId: null,
    assignedAt: null,
    completedByUserId: null,
    completedAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    deletedAt: null,
    ...over,
  } as ActionItem;
}

function ctxFor(lens: EngagementLens): EngagementViewerContext {
  return {
    lens,
    archetype: lens === 'admin' ? 'observer' : 'participant',
    isClientOwner: lens === 'client',
    isDeliveringExpert: lens === 'expert',
  };
}

describe('mapActionItemsToView', () => {
  it('carries engagement id, viewer party and the assign-control party labels', () => {
    const view = mapActionItemsToView(makeEngagement(), [], ctxFor('expert'), NOW);
    expect(view.engagementId).toBe('eng-1');
    expect(view.viewerParty).toBe('expert');
    expect(view.clientCompanyName).toBe('Northwind Industrial');
    expect(view.expertPartyShort).toBe('Priya');
    expect(view.items).toEqual([]);
  });

  it('canWrite is true only on an active engagement', () => {
    expect(mapActionItemsToView(makeEngagement(), [], ctxFor('client'), NOW).canWrite).toBe(true);
    expect(
      mapActionItemsToView(makeEngagement({ status: 'completed' }), [], ctxFor('client'), NOW)
        .canWrite
    ).toBe(false);
    expect(
      mapActionItemsToView(
        makeEngagement({ status: 'pending_acceptance' }),
        [],
        ctxFor('client'),
        NOW
      ).canWrite
    ).toBe(false);
  });

  it('maps an unassigned item to a null party label', () => {
    const [node] = mapActionItemsToView(
      makeEngagement(),
      [makeActionItem()],
      ctxFor('expert'),
      NOW
    ).items;
    expect(node?.assigneeParty).toBeNull();
    expect(node?.assigneeLabel).toBeNull();
    expect(node?.dueLabel).toBeNull();
    expect(node?.dueAtValue).toBeNull();
    expect(node?.isOverdue).toBe(false);
  });

  it('labels a client-assigned item with the client company (prospective party)', () => {
    const [node] = mapActionItemsToView(
      makeEngagement(),
      [makeActionItem({ assigneeParty: 'client' })],
      ctxFor('client'),
      NOW
    ).items;
    expect(node?.assigneeLabel).toBe('Northwind Industrial');
  });

  it('labels an expert-assigned item with the expert party short label', () => {
    const [node] = mapActionItemsToView(
      makeEngagement(),
      [makeActionItem({ assigneeParty: 'expert' })],
      ctxFor('expert'),
      NOW
    ).items;
    expect(node?.assigneeLabel).toBe('Priya');
  });

  it('formats a due date to a UTC long label plus a YYYY-MM-DD edit value', () => {
    const [node] = mapActionItemsToView(
      makeEngagement(),
      [makeActionItem({ dueAt: new Date('2026-07-09T00:00:00.000Z') })],
      ctxFor('expert'),
      NOW
    ).items;
    expect(node?.dueLabel).toBe('9 Jul 2026');
    expect(node?.dueAtValue).toBe('2026-07-09');
  });

  it('marks a past-due open item overdue, but never a completed one', () => {
    const pastDue = new Date('2026-06-01T00:00:00.000Z');
    const [openNode] = mapActionItemsToView(
      makeEngagement(),
      [makeActionItem({ dueAt: pastDue, status: 'open' })],
      ctxFor('expert'),
      NOW
    ).items;
    expect(openNode?.isOverdue).toBe(true);

    const [doneNode] = mapActionItemsToView(
      makeEngagement(),
      [makeActionItem({ dueAt: pastDue, status: 'done' })],
      ctxFor('expert'),
      NOW
    ).items;
    expect(doneNode?.isOverdue).toBe(false);
  });

  it('a future due date is not overdue', () => {
    const [node] = mapActionItemsToView(
      makeEngagement(),
      [makeActionItem({ dueAt: new Date('2026-08-01T00:00:00.000Z') })],
      ctxFor('expert'),
      NOW
    ).items;
    expect(node?.isOverdue).toBe(false);
  });

  it('preserves list order and the plain-text body', () => {
    const view = mapActionItemsToView(
      makeEngagement(),
      [makeActionItem({ id: 'a', body: 'First' }), makeActionItem({ id: 'b', body: 'Second' })],
      ctxFor('admin'),
      NOW
    );
    expect(view.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(view.items.map((item) => item.body)).toEqual(['First', 'Second']);
    expect(view.viewerParty).toBe('admin');
  });
});
