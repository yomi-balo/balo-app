import type { ChangeOrderWithLines, ProjectEngagementWithMilestones } from '@balo/db';

/**
 * Builders for the change-order view-model, settlement and action tests. A change order is
 * the repository's `ChangeOrderWithLines` (lines and actor names hydrated); a fixture is
 * cast once here so each test names only the fields it cares about.
 */

export type OrderLine = ChangeOrderWithLines['lines'][number];
export type MilestoneNode = ProjectEngagementWithMilestones['milestones'][number];

const AT = new Date('2026-10-01T00:00:00.000Z');

export const FIXTURE_ENGAGEMENT_ID = 'a0000000-0000-4000-8000-000000000001';
export const FIXTURE_COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';

export const DANA = { id: 'user-dana', firstName: 'Dana', lastName: 'Lee' };
export const CHARLES = { id: 'user-charles', firstName: 'Charles', lastName: 'Ng' };

export function makeLine(over: Partial<OrderLine> = {}): OrderLine {
  return {
    id: 'line-1',
    changeOrderId: 'co-1',
    op: 'add',
    engagementMilestoneId: null,
    title: 'Reporting dashboard',
    descriptionHtml: null,
    acceptanceCriteria: null,
    valueCents: null,
    estimatedMinutes: null,
    beforeTitle: null,
    beforeDescriptionHtml: null,
    beforeEstimatedMinutes: null,
    sortOrder: 0,
    createdAt: AT,
    updatedAt: AT,
    deletedAt: null,
    ...over,
  };
}

export function makeOrder(over: Partial<ChangeOrderWithLines> = {}): ChangeOrderWithLines {
  return {
    id: 'co-1',
    engagementId: FIXTURE_ENGAGEMENT_ID,
    status: 'draft',
    requestNote: null,
    note: null,
    priceDeltaCents: null,
    requestedByUserId: null,
    requestedAt: null,
    createdByUserId: CHARLES.id,
    sentByUserId: null,
    sentAt: null,
    decidedByUserId: null,
    decidedAt: null,
    withdrawnByUserId: null,
    withdrawnAt: null,
    declineReason: null,
    createdAt: AT,
    updatedAt: AT,
    deletedAt: null,
    lines: [],
    requestedBy: null,
    sentBy: null,
    decidedBy: null,
    withdrawnBy: null,
    ...over,
  } as ChangeOrderWithLines;
}

export function makeMilestone(over: Partial<MilestoneNode> = {}): MilestoneNode {
  return {
    id: 'ms-1',
    engagementId: FIXTURE_ENGAGEMENT_ID,
    sourceProposalMilestoneId: null,
    sortOrder: 0,
    title: 'Discovery',
    descriptionHtml: null,
    acceptanceCriteria: null,
    valueCents: null,
    estimatedMinutes: null,
    status: 'pending',
    startedByUserId: null,
    startedAt: null,
    completedByUserId: null,
    completedAt: null,
    completionNote: null,
    createdByUserId: null,
    createdAt: AT,
    updatedAt: AT,
    deletedAt: null,
    ...over,
  } as MilestoneNode;
}

/** A fixed-price project at A$10,000 (expert side) and a 25% fee, with one independent expert. */
export function makeProject(
  over: Partial<ProjectEngagementWithMilestones> = {}
): ProjectEngagementWithMilestones {
  return {
    id: FIXTURE_ENGAGEMENT_ID,
    companyId: FIXTURE_COMPANY_ID,
    expertProfileId: 'expert-1',
    sourceProposalId: 'prop-1',
    projectRequestId: 'req-1',
    pricingMethod: 'fixed',
    priceCents: 1_000_000,
    baloFeeBps: 2500,
    currency: 'aud',
    depositCents: null,
    status: 'active',
    activatedAt: AT,
    createdAt: AT,
    milestones: [makeMilestone()],
    expertProfile: {
      id: 'expert-1',
      agencyId: null,
      type: 'freelancer',
      headline: null,
      timezone: 'UTC',
      user: { id: CHARLES.id, firstName: 'Charles', lastName: 'Ng', avatarUrl: null },
      agency: null,
    },
    company: { id: FIXTURE_COMPANY_ID, name: 'Northwind' },
    projectRequest: { id: 'req-1', title: 'CPQ rollout' },
    ...over,
  } as unknown as ProjectEngagementWithMilestones;
}
