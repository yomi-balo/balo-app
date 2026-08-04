import type { EngagementMilestone } from '@balo/db';

/**
 * A COMPLETE `engagement_milestones` row for web unit tests.
 *
 * BAL-417 typed the `_actions/*.test.ts` engagement fixtures as
 * `Partial<ProjectEngagementWithMilestones>`, which types `milestones` as a full
 * `EngagementMilestone[]`. The six action suites that override `milestones` used to
 * hand-roll a 7-field literal each; every one of those was silently a DIFFERENT shape
 * from what `findWithMilestones` actually returns. Building them from ONE complete
 * fixture keeps them honest and keeps the same 19-column literal from being copied
 * six times (the Sonar new-code duplication gate).
 *
 * Type-only import from `@balo/db` — erased at compile, so it is inert under the
 * `vi.mock('@balo/db')` every one of those suites installs.
 */
export function engagementMilestoneFixture(
  overrides: Partial<EngagementMilestone> = {}
): EngagementMilestone {
  return {
    id: 'm0000000-0000-4000-8000-000000000001',
    engagementId: 'a0000000-0000-4000-8000-000000000001',
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
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  };
}
