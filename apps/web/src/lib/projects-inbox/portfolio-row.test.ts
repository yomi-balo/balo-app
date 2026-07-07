import { describe, it, expect } from 'vitest';
import type { PortfolioRequestRow, PortfolioInvitationRow } from '@balo/db';
import type { ProjectRequestStatus } from '@/lib/project-request/resolve-request-lens';
import type { RelationshipStatus } from '@/lib/project-request/conversation-view-types';
import {
  requestRecencyAt,
  stageChipFor,
  stageChipForRelationship,
  stageDistribution,
  needsYouFor,
  needsYouForExpert,
  deriveEngagementRow,
  adminStallDays,
  rowMatchesFilter,
  tilesFromRows,
  type EngagementRowInput,
  type PortfolioRowView,
  type RequestThreadSignal,
} from './portfolio-row';

const NOW = new Date('2026-06-16T12:00:00.000Z');
const day = (n: number): Date => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

type RelationshipRow = PortfolioRequestRow['relationships'][number];

function makeRelationship(overrides: Partial<RelationshipRow> = {}): RelationshipRow {
  return {
    id: 'rel-1',
    expertProfileId: 'expert-1',
    status: 'invited',
    invitedAt: day(10),
    updatedAt: day(10),
    proposalRequestedAt: null,
    expressionsOfInterest: [],
    conversationMessages: [],
    ...overrides,
  };
}

function makeRequest(overrides: Partial<PortfolioRequestRow> = {}): PortfolioRequestRow {
  return {
    id: 'req-1',
    companyId: 'company-1',
    expertProfileId: null,
    status: 'requested',
    title: 'CPQ implementation',
    clientBillingConfirmedAt: null,
    expertTermsConfirmedAt: null,
    createdAt: day(20),
    updatedAt: day(20),
    company: { id: 'company-1', name: 'Northwind Industrial' },
    relationships: [],
    ...overrides,
  };
}

function makeInvitation(overrides: Partial<PortfolioInvitationRow> = {}): PortfolioInvitationRow {
  return {
    relationshipId: 'rel-1',
    relationshipStatus: 'invited',
    invitedAt: day(2),
    relationshipUpdatedAt: day(2),
    proposalRequestedAt: null,
    projectRequestId: 'req-1',
    requestStatus: 'experts_invited',
    title: 'Experience Cloud portal',
    companyId: 'company-1',
    companyName: 'Harbour Health',
    newestEoiAt: null,
    ...overrides,
  };
}

function makeEngagementInput(overrides: Partial<EngagementRowInput> = {}): EngagementRowInput {
  return {
    engagementId: 'eng-1',
    status: 'active',
    lens: 'client',
    hasChangeRequest: false,
    counterpartName: 'Northwind',
    totalMilestones: 0,
    completedMilestones: 0,
    autoAcceptLabel: null,
    ...overrides,
  };
}

const SIGNAL_UNREAD: RequestThreadSignal = {
  anyUnread: true,
  awaitingViewerReply: true,
  freshestSignal: { from: 'Priya', messagePreview: 'Proposal submitted' },
};
const SIGNAL_QUIET: RequestThreadSignal = {
  anyUnread: false,
  awaitingViewerReply: false,
  freshestSignal: null,
};

describe('stageChipFor', () => {
  const cases: Array<[ProjectRequestStatus, string]> = [
    ['draft', 'Requested'],
    ['requested', 'Requested'],
    ['experts_invited', 'Experts invited'],
    ['exploratory_meeting_requested', 'Experts invited'],
    ['eoi_submitted', 'In conversation'],
    ['proposal_requested', 'Proposal req.'],
    ['proposal_submitted', 'Proposals in'],
    ['accepted', 'Accepted'],
    ['kickoff_approved', 'Kicked off'],
  ];
  it.each(cases)('maps %s → %s', (status, label) => {
    expect(stageChipFor(status).label).toBe(label);
  });
});

describe('stageChipForRelationship', () => {
  const cases: Array<[RelationshipStatus, string]> = [
    ['invited', 'Experts invited'],
    ['eoi_submitted', 'In conversation'],
    ['proposal_requested', 'Proposal req.'],
    ['proposal_submitted', 'Proposals in'],
    ['accepted', 'Accepted'],
  ];
  it.each(cases)('maps %s → %s', (status, label) => {
    expect(stageChipForRelationship(status).label).toBe(label);
  });
});

describe('stageDistribution', () => {
  it('counts rows per stage key with a complete record', () => {
    const dist = stageDistribution([{ stage: 'eoi' }, { stage: 'eoi' }, { stage: 'kicked' }]);
    expect(dist.eoi).toBe(2);
    expect(dist.kicked).toBe(1);
    expect(dist.requested).toBe(0);
  });
});

describe('requestRecencyAt', () => {
  it('falls back to updatedAt when there are no relationships', () => {
    const row = makeRequest({ updatedAt: day(3), createdAt: day(20) });
    expect(requestRecencyAt(row).getTime()).toBe(day(3).getTime());
  });

  it('takes the newest relationship activity over the request updatedAt', () => {
    const row = makeRequest({
      updatedAt: day(15),
      relationships: [
        makeRelationship({
          invitedAt: day(10),
          updatedAt: day(8),
          conversationMessages: [{ id: 'm1', createdAt: day(1) }],
        }),
      ],
    });
    expect(requestRecencyAt(row).getTime()).toBe(day(1).getTime());
  });

  it('folds the newest EOI submittedAt into the recency', () => {
    const row = makeRequest({
      updatedAt: day(15),
      relationships: [
        makeRelationship({
          invitedAt: day(10),
          updatedAt: day(9),
          expressionsOfInterest: [{ id: 'e1', submittedAt: day(2) }],
        }),
      ],
    });
    expect(requestRecencyAt(row).getTime()).toBe(day(2).getTime());
  });
});

describe('needsYouFor — client lens', () => {
  it('requested → not needs-you, waiting on Balo', () => {
    const res = needsYouFor('client', makeRequest({ status: 'requested' }), SIGNAL_QUIET, NOW);
    expect(res).toEqual({ needsYou: false, nudgeLabel: 'Waiting on Balo' });
  });

  it('experts_invited → waiting on experts', () => {
    const res = needsYouFor(
      'client',
      makeRequest({ status: 'experts_invited' }),
      SIGNAL_QUIET,
      NOW
    );
    expect(res.needsYou).toBe(false);
    expect(res.nudgeLabel).toBe('Waiting on experts');
  });

  it('eoi_submitted with unread → needs-you, reply to the expert', () => {
    const res = needsYouFor('client', makeRequest({ status: 'eoi_submitted' }), SIGNAL_UNREAD, NOW);
    expect(res.needsYou).toBe(true);
    expect(res.nudgeLabel).toBe('Reply to Priya');
  });

  it('eoi_submitted quiet → not needs-you', () => {
    const res = needsYouFor('client', makeRequest({ status: 'eoi_submitted' }), SIGNAL_QUIET, NOW);
    expect(res.needsYou).toBe(false);
  });

  it('proposal_submitted → needs-you, counts proposals', () => {
    const row = makeRequest({
      status: 'proposal_submitted',
      relationships: [
        makeRelationship({ id: 'r1', status: 'proposal_submitted' }),
        makeRelationship({ id: 'r2', status: 'proposal_submitted' }),
      ],
    });
    const res = needsYouFor('client', row, SIGNAL_QUIET, NOW);
    expect(res).toEqual({ needsYou: true, nudgeLabel: 'Review 2 proposals' });
  });

  it('accepted with billing unconfirmed → needs-you, confirm billing', () => {
    const res = needsYouFor(
      'client',
      makeRequest({ status: 'accepted', clientBillingConfirmedAt: null }),
      SIGNAL_QUIET,
      NOW
    );
    expect(res).toEqual({ needsYou: true, nudgeLabel: 'Confirm billing' });
  });

  it('accepted with billing confirmed → not needs-you', () => {
    const res = needsYouFor(
      'client',
      makeRequest({ status: 'accepted', clientBillingConfirmedAt: day(1) }),
      SIGNAL_QUIET,
      NOW
    );
    expect(res.needsYou).toBe(false);
  });

  it('kickoff_approved → not needs-you, live project', () => {
    const res = needsYouFor(
      'client',
      makeRequest({ status: 'kickoff_approved' }),
      SIGNAL_QUIET,
      NOW
    );
    expect(res).toEqual({ needsYou: false, nudgeLabel: 'Live project' });
  });
});

describe('needsYouForExpert', () => {
  it('invited → needs-you, submit EOI', () => {
    expect(needsYouForExpert(makeInvitation({ relationshipStatus: 'invited' }))).toEqual({
      needsYou: true,
      nudgeLabel: 'Submit your EOI',
    });
  });

  it('eoi_submitted unread → reply to client', () => {
    const res = needsYouForExpert(
      makeInvitation({ relationshipStatus: 'eoi_submitted', requestStatus: 'eoi_submitted' }),
      SIGNAL_UNREAD
    );
    expect(res).toEqual({ needsYou: true, nudgeLabel: 'Reply to client' });
  });

  it('eoi_submitted quiet → propose times', () => {
    const res = needsYouForExpert(
      makeInvitation({ relationshipStatus: 'eoi_submitted', requestStatus: 'eoi_submitted' }),
      SIGNAL_QUIET
    );
    expect(res).toEqual({ needsYou: true, nudgeLabel: 'Propose times' });
  });

  it('proposal_requested → build your proposal', () => {
    const res = needsYouForExpert(
      makeInvitation({
        relationshipStatus: 'proposal_requested',
        requestStatus: 'proposal_requested',
      })
    );
    expect(res).toEqual({ needsYou: true, nudgeLabel: 'Build your proposal' });
  });

  it('proposal_submitted → waiting on client', () => {
    const res = needsYouForExpert(
      makeInvitation({
        relationshipStatus: 'proposal_submitted',
        requestStatus: 'proposal_submitted',
      })
    );
    expect(res.needsYou).toBe(false);
    expect(res.nudgeLabel).toBe('Waiting on client');
  });

  it('won (relationship accepted, request accepted) → confirm terms', () => {
    const res = needsYouForExpert(
      makeInvitation({ relationshipStatus: 'accepted', requestStatus: 'accepted' })
    );
    expect(res).toEqual({ needsYou: true, nudgeLabel: 'Confirm terms' });
  });

  it('lost (relationship not accepted, request accepted) → not selected, not needs-you', () => {
    const res = needsYouForExpert(
      makeInvitation({ relationshipStatus: 'proposal_submitted', requestStatus: 'accepted' })
    );
    expect(res).toEqual({ needsYou: false, nudgeLabel: 'Not selected' });
  });

  it('won + kickoff_approved → live project, not needs-you', () => {
    const res = needsYouForExpert(
      makeInvitation({ relationshipStatus: 'accepted', requestStatus: 'kickoff_approved' })
    );
    expect(res).toEqual({ needsYou: false, nudgeLabel: 'Live project' });
  });
});

describe('deriveEngagementRow', () => {
  it('client active no-note, 3/5 → In delivery with progress + inbox href', () => {
    const res = deriveEngagementRow(
      makeEngagementInput({
        lens: 'client',
        status: 'active',
        totalMilestones: 5,
        completedMilestones: 3,
      })
    );
    expect(res).toEqual({
      needsYou: false,
      nudgeLabel: 'In delivery',
      progressLabel: '3 of 5 milestones',
      href: '/engagements/eng-1?from=inbox',
    });
  });

  it('client active no-note with zero milestones → null progressLabel', () => {
    const res = deriveEngagementRow(
      makeEngagementInput({ lens: 'client', status: 'active', totalMilestones: 0 })
    );
    expect(res.progressLabel).toBeNull();
    expect(res.nudgeLabel).toBe('In delivery');
  });

  it('expert active no-note → In delivery, progress present', () => {
    const res = deriveEngagementRow(
      makeEngagementInput({
        lens: 'expert',
        status: 'active',
        totalMilestones: 4,
        completedMilestones: 1,
      })
    );
    expect(res.needsYou).toBe(false);
    expect(res.nudgeLabel).toBe('In delivery');
    expect(res.progressLabel).toBe('1 of 4 milestones');
  });

  it('expert active + change request → needs-you, "{counterpart} requested changes"', () => {
    const res = deriveEngagementRow(
      makeEngagementInput({
        lens: 'expert',
        status: 'active',
        hasChangeRequest: true,
        counterpartName: 'Northwind',
      })
    );
    expect(res).toMatchObject({ needsYou: true, nudgeLabel: 'Northwind requested changes' });
  });

  it('client active + change request → not needs-you, "Changes requested"', () => {
    const res = deriveEngagementRow(
      makeEngagementInput({ lens: 'client', status: 'active', hasChangeRequest: true })
    );
    expect(res).toMatchObject({ needsYou: false, nudgeLabel: 'Changes requested' });
  });

  it('client pending_acceptance → needs-you, review + auto-accept date, null progress', () => {
    const res = deriveEngagementRow(
      makeEngagementInput({
        lens: 'client',
        status: 'pending_acceptance',
        autoAcceptLabel: 'Jul 14',
      })
    );
    expect(res).toMatchObject({
      needsYou: true,
      nudgeLabel: 'Review project completion — auto-accepts Jul 14',
      progressLabel: null,
    });
  });

  it('client pending_acceptance with null autoAcceptLabel → fallback copy', () => {
    const res = deriveEngagementRow(
      makeEngagementInput({ lens: 'client', status: 'pending_acceptance', autoAcceptLabel: null })
    );
    expect(res.nudgeLabel).toBe('Review project completion');
  });

  it('expert pending_acceptance → not needs-you, "Awaiting {counterpart} review"', () => {
    const res = deriveEngagementRow(
      makeEngagementInput({
        lens: 'expert',
        status: 'pending_acceptance',
        counterpartName: 'Northwind',
      })
    );
    expect(res).toMatchObject({ needsYou: false, nudgeLabel: 'Awaiting Northwind review' });
  });

  it('completed / cancelled → not needs-you, terminal copy, null progress (both lenses)', () => {
    for (const lens of ['client', 'expert'] as const) {
      const completed = deriveEngagementRow(
        makeEngagementInput({
          lens,
          status: 'completed',
          totalMilestones: 3,
          completedMilestones: 3,
        })
      );
      expect(completed).toMatchObject({
        needsYou: false,
        nudgeLabel: 'Completed',
        progressLabel: null,
      });
      const cancelled = deriveEngagementRow(makeEngagementInput({ lens, status: 'cancelled' }));
      expect(cancelled).toMatchObject({
        needsYou: false,
        nudgeLabel: 'Cancelled',
        progressLabel: null,
      });
    }
  });

  it('href is ALWAYS present, keyed on the engagement id (retainer-safe)', () => {
    const res = deriveEngagementRow(makeEngagementInput({ engagementId: 'eng-retainer' }));
    expect(res.href).toBe('/engagements/eng-retainer?from=inbox');
  });
});

describe('adminNeedsYou + adminStallDays', () => {
  it('requested → triage, needs-you', () => {
    const res = needsYouFor('admin', makeRequest({ status: 'requested' }), SIGNAL_QUIET, NOW);
    expect(res).toEqual({ needsYou: true, nudgeLabel: 'Triage' });
  });

  it('experts_invited quiet beyond threshold → stalled needs-you with day count', () => {
    const row = makeRequest({ status: 'experts_invited', updatedAt: day(5) });
    const res = needsYouFor('admin', row, SIGNAL_QUIET, NOW);
    expect(res.needsYou).toBe(true);
    expect(res.nudgeLabel).toBe('No EOIs · 5d');
  });

  it('experts_invited recent → not stalled', () => {
    const row = makeRequest({ status: 'experts_invited', updatedAt: day(1) });
    const res = needsYouFor('admin', row, SIGNAL_QUIET, NOW);
    expect(res.needsYou).toBe(false);
  });

  it('accepted with a gate owed → kickoff gate needs-you', () => {
    const row = makeRequest({
      status: 'accepted',
      clientBillingConfirmedAt: day(1),
      expertTermsConfirmedAt: null,
    });
    const res = needsYouFor('admin', row, SIGNAL_QUIET, NOW);
    expect(res).toEqual({ needsYou: true, nudgeLabel: 'Kickoff gate' });
  });

  it('adminStallDays returns null below the threshold', () => {
    expect(adminStallDays(makeRequest({ updatedAt: day(1) }), NOW)).toBeNull();
  });

  it('adminStallDays returns the day count at/above the threshold', () => {
    expect(adminStallDays(makeRequest({ updatedAt: day(4) }), NOW)).toBe(4);
  });
});

describe('tilesFromRows + rowMatchesFilter', () => {
  const rows: PortfolioRowView[] = [
    {
      id: 'a',
      href: '/projects/a',
      title: 'A',
      companyName: null,
      stage: 'prop_in',
      stageLabel: 'Proposals in',
      needsYou: true,
      nudgeLabel: 'Review proposal',
      unread: true,
      updatedRelative: 'today',
      recencyAtIso: NOW.toISOString(),
      kind: 'request',
    },
    {
      id: 'b',
      href: '/projects/b',
      title: 'B',
      companyName: null,
      stage: 'invited',
      stageLabel: 'Experts invited',
      needsYou: false,
      nudgeLabel: 'Waiting on experts',
      unread: false,
      updatedRelative: '3 days ago',
      recencyAtIso: NOW.toISOString(),
      kind: 'request',
    },
    {
      id: 'c',
      href: '/projects/c',
      title: 'C',
      companyName: null,
      stage: 'kicked',
      stageLabel: 'Kicked off',
      needsYou: false,
      nudgeLabel: 'Live project',
      unread: false,
      updatedRelative: '2 weeks ago',
      recencyAtIso: NOW.toISOString(),
      kind: 'request',
    },
    {
      id: 'd',
      href: '/engagements/d?from=inbox',
      title: 'D',
      companyName: 'Northwind',
      stage: 'kicked',
      stageLabel: 'Kicked off',
      needsYou: false,
      nudgeLabel: 'In delivery',
      progressLabel: '2 of 4 milestones',
      unread: false,
      updatedRelative: 'today',
      recencyAtIso: NOW.toISOString(),
      kind: 'engagement',
    },
  ];

  it('computes tile counts (an engagement row folds into the kicked tile)', () => {
    expect(tilesFromRows(rows)).toEqual({ needs: 1, inProgress: 1, kicked: 2, total: 4 });
  });

  it('filters needs / in_progress / kicked / all', () => {
    expect(rows.filter((r) => rowMatchesFilter(r, 'needs')).map((r) => r.id)).toEqual(['a']);
    expect(rows.filter((r) => rowMatchesFilter(r, 'in_progress')).map((r) => r.id)).toEqual(['b']);
    expect(rows.filter((r) => rowMatchesFilter(r, 'kicked')).map((r) => r.id)).toEqual(['c', 'd']);
    expect(rows.filter((r) => rowMatchesFilter(r, 'all'))).toHaveLength(4);
  });
});
