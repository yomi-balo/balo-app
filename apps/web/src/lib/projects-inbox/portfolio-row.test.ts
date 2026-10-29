import { describe, it, expect } from 'vitest';
import type { PortfolioRequestRow, PortfolioInvitationRow } from '@balo/db';
import type { ProjectRequestStatus } from '@/lib/project-request/resolve-request-lens';
import type { RelationshipStatus } from '@/lib/project-request/conversation-view-types';
import {
  requestRecencyAt,
  clientRequestRecencyAt,
  stageChipFor,
  stageChipForRelationship,
  stageDistribution,
  needsYouFor,
  needsYouForExpert,
  deriveEngagementRow,
  proposalAwaitsClientReview,
  adminStallDays,
  rowMatchesFilter,
  tilesFromRows,
  agencyRowMatches,
  rankAgencyRows,
  type AgencyRowView,
  type EngagementRowInput,
  type PortfolioRowView,
  type RequestThreadSignal,
} from './portfolio-row';

const NOW = new Date('2026-06-16T12:00:00.000Z');
const day = (n: number): Date => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

type RelationshipRow = PortfolioRequestRow['relationships'][number];

function makeRelationship(overrides: Partial<RelationshipRow> = {}): RelationshipRow {
  const status = overrides.status ?? 'invited';
  return {
    id: 'rel-1',
    expertProfileId: 'expert-1',
    status: 'invited',
    invitedAt: day(10),
    updatedAt: day(10),
    proposalRequestedAt: null,
    // An engaged track has opened, as production's advance stamps it.
    openedAt: status === 'invited' || status === 'declined' ? null : day(10),
    expressionsOfInterest: [],
    conversationMessages: [],
    proposals: [],
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
    upfrontInvoiceRaisedAt: null,
    createdAt: day(20),
    updatedAt: day(20),
    // BAL-541 — the SHARED portfolio query now selects the Balo owner id, so the repository
    // ROW carries it on every lens. Unassigned by default here; `PortfolioRowView` still
    // carries neither it nor anything derived from it, which is what the leak invariant pins.
    baloOwnerUserId: null,
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
    availabilitySharedAt: null,
    projectRequestId: 'req-1',
    requestStatus: 'experts_invited',
    onDirectLeg: false,
    title: 'Experience Cloud portal',
    companyId: 'company-1',
    companyName: 'Harbour Health',
    currentProposalStatus: null,
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
  viewerHasSentMessage: false,
};
const SIGNAL_QUIET: RequestThreadSignal = {
  anyUnread: false,
  awaitingViewerReply: false,
  freshestSignal: null,
  viewerHasSentMessage: false,
};

describe('stageChipFor', () => {
  const cases: Array<[ProjectRequestStatus, string]> = [
    ['draft', 'Requested'],
    ['requested', 'Requested'],
    ['experts_invited', 'Experts invited'],
    ['exploratory_meeting_requested', 'Exploratory call'],
    ['eoi_submitted', 'In conversation'],
    ['proposal_requested', 'Proposal req.'],
    ['proposal_submitted', 'Proposals in'],
    ['accepted', 'Accepted'],
    ['kickoff_approved', 'Kicked off'],
    ['closed', 'Closed'],
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

  it('includes closed in the complete record (BAL-540)', () => {
    const dist = stageDistribution([{ stage: 'closed' }, { stage: 'closed' }]);
    expect(dist.closed).toBe(2);
    expect(dist.kicked).toBe(0);
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

describe('clientRequestRecencyAt', () => {
  /**
   * An unopened expert's own row must not move the client's "updated" time. The first invite
   * still moves the request's `updatedAt` through the status rollup — the request stage, which
   * the client does see — so this fixture holds `updatedAt` fixed and varies only the tracks.
   */
  it('ignores a track that has not opened, unlike the staff fold', () => {
    const row = makeRequest({
      updatedAt: day(5),
      relationships: [
        makeRelationship({ id: 'rel-opened', status: 'eoi_submitted', updatedAt: day(4) }),
        makeRelationship({ id: 'rel-invited', invitedAt: day(1), updatedAt: day(1) }),
      ],
    });
    expect(clientRequestRecencyAt(row).getTime()).toBe(day(4).getTime());
    expect(requestRecencyAt(row).getTime()).toBe(day(1).getTime());
  });
});

describe('needsYouFor — client lens', () => {
  it('requested → not needs-you, waiting on Balo', () => {
    const res = needsYouFor('client', makeRequest({ status: 'requested' }), SIGNAL_QUIET, NOW);
    expect(res).toEqual({ needsYou: false, nudgeLabel: 'Waiting on Balo', clientMoveKind: null });
  });

  it('exploratory_meeting_requested → needs-you, book the call (no expert is invited yet)', () => {
    const res = needsYouFor(
      'client',
      makeRequest({ status: 'exploratory_meeting_requested' }),
      SIGNAL_QUIET,
      NOW
    );
    expect(res).toEqual({
      needsYou: true,
      nudgeLabel: 'Book exploratory call',
      clientMoveKind: 'exploratory_call',
    });
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
    expect(res).toEqual({
      needsYou: true,
      nudgeLabel: 'Review 2 proposals',
      clientMoveKind: 'proposal_review',
    });
  });

  it('proposal_submitted with every proposal at changes_requested → waiting on expert, not needs-you', () => {
    const row = makeRequest({
      status: 'proposal_submitted',
      relationships: [
        makeRelationship({
          id: 'r1',
          status: 'proposal_submitted',
          proposals: [{ status: 'changes_requested' }],
        }),
        makeRelationship({
          id: 'r2',
          status: 'proposal_submitted',
          proposals: [{ status: 'changes_requested' }],
        }),
      ],
    });
    expect(needsYouFor('client', row, SIGNAL_QUIET, NOW)).toEqual({
      needsYou: false,
      nudgeLabel: 'Waiting on expert',
      clientMoveKind: null,
    });
  });

  it('proposal_submitted with a mixed set counts only the proposals still awaiting review', () => {
    const row = makeRequest({
      status: 'proposal_submitted',
      relationships: [
        makeRelationship({
          id: 'r1',
          status: 'proposal_submitted',
          proposals: [{ status: 'changes_requested' }],
        }),
        makeRelationship({
          id: 'r2',
          status: 'proposal_submitted',
          proposals: [{ status: 'submitted' }],
        }),
      ],
    });
    expect(needsYouFor('client', row, SIGNAL_QUIET, NOW)).toEqual({
      needsYou: true,
      nudgeLabel: 'Review proposal',
      clientMoveKind: 'proposal_review',
    });
  });

  it('needsYou holds exactly when clientMoveKind is set, over every request status × signal', () => {
    const statuses: ProjectRequestStatus[] = [
      'draft',
      'requested',
      'exploratory_meeting_requested',
      'experts_invited',
      'eoi_submitted',
      'proposal_requested',
      'proposal_submitted',
      'accepted',
      'kickoff_approved',
      'closed',
    ];
    for (const status of statuses) {
      for (const signal of [SIGNAL_UNREAD, SIGNAL_QUIET]) {
        for (const clientBillingConfirmedAt of [null, day(1)]) {
          for (const upfrontInvoiceRaisedAt of [null, day(1)]) {
            const res = needsYouFor(
              'client',
              makeRequest({
                status,
                clientBillingConfirmedAt,
                upfrontInvoiceRaisedAt,
                relationships: [makeRelationship({ status: 'proposal_submitted' })],
              }),
              signal,
              NOW
            );
            expect(res.needsYou).toBe(res.clientMoveKind !== null);
          }
        }
      }
    }
  });

  it.each([
    ['exploratory_meeting_requested', 'exploratory_call'],
    ['eoi_submitted', 'eoi_reply'],
    ['accepted', 'kickoff_billing'],
  ] as const)('%s needs-you → clientMoveKind %s', (status, kind) => {
    const res = needsYouFor('client', makeRequest({ status }), SIGNAL_UNREAD, NOW);
    expect(res.clientMoveKind).toBe(kind);
  });

  it('the admin lens never carries a client move kind', () => {
    expect(
      needsYouFor('admin', makeRequest({ status: 'requested' }), SIGNAL_QUIET, NOW)
    ).toMatchObject({
      needsYou: true,
      clientMoveKind: null,
    });
  });

  it('accepted with billing unconfirmed → needs-you, confirm billing', () => {
    const res = needsYouFor(
      'client',
      makeRequest({ status: 'accepted', clientBillingConfirmedAt: null }),
      SIGNAL_QUIET,
      NOW
    );
    expect(res).toEqual({
      needsYou: true,
      nudgeLabel: 'Confirm billing',
      clientMoveKind: 'kickoff_billing',
    });
  });

  it('accepted with billing confirmed, invoice not yet raised → not needs-you, awaiting kickoff', () => {
    const res = needsYouFor(
      'client',
      makeRequest({ status: 'accepted', clientBillingConfirmedAt: day(1) }),
      SIGNAL_QUIET,
      NOW
    );
    expect(res).toEqual({ needsYou: false, nudgeLabel: 'Awaiting kickoff', clientMoveKind: null });
  });

  it('accepted with the upfront invoice raised → needs-you, pay invoice', () => {
    const res = needsYouFor(
      'client',
      makeRequest({
        status: 'accepted',
        clientBillingConfirmedAt: day(2),
        upfrontInvoiceRaisedAt: day(1),
      }),
      SIGNAL_QUIET,
      NOW
    );
    expect(res).toEqual({
      needsYou: true,
      nudgeLabel: 'Pay invoice',
      clientMoveKind: 'kickoff_payment',
    });
  });

  it('kickoff_approved → not needs-you, live project', () => {
    const res = needsYouFor(
      'client',
      makeRequest({ status: 'kickoff_approved' }),
      SIGNAL_QUIET,
      NOW
    );
    expect(res).toEqual({ needsYou: false, nudgeLabel: 'Live project', clientMoveKind: null });
  });

  it('closed → not needs-you, closed (BAL-540 — the largest silent surface, now a compile error)', () => {
    const res = needsYouFor('client', makeRequest({ status: 'closed' }), SIGNAL_UNREAD, NOW);
    expect(res).toEqual({ needsYou: false, nudgeLabel: 'Closed', clientMoveKind: null });
  });
});

describe('proposalAwaitsClientReview', () => {
  it.each([
    ['proposal_submitted', null, true],
    ['proposal_submitted', 'submitted', true],
    ['proposal_submitted', 'changes_requested', false],
    ['accepted', 'submitted', false],
    ['eoi_submitted', null, false],
  ] as const)('%s with current proposal %s → %s', (relationship, proposal, expected) => {
    expect(proposalAwaitsClientReview(relationship, proposal)).toBe(expected);
  });
});

describe('needsYouForExpert', () => {
  it('invited → needs-you, submit EOI', () => {
    expect(needsYouForExpert(makeInvitation({ relationshipStatus: 'invited' }))).toEqual({
      needsYou: true,
      nudgeLabel: 'Submit your EOI',
      moveKind: 'invitation',
    });
  });

  it('eoi_submitted unread → reply to client', () => {
    const res = needsYouForExpert(
      makeInvitation({ relationshipStatus: 'eoi_submitted', requestStatus: 'eoi_submitted' }),
      SIGNAL_UNREAD
    );
    expect(res).toEqual({
      needsYou: true,
      nudgeLabel: 'Reply to client',
      moveKind: 'eoi_reply_owed',
    });
  });

  it('eoi_submitted quiet → propose times', () => {
    const res = needsYouForExpert(
      makeInvitation({ relationshipStatus: 'eoi_submitted', requestStatus: 'eoi_submitted' }),
      SIGNAL_QUIET
    );
    expect(res).toEqual({
      needsYou: true,
      nudgeLabel: 'Propose times',
      moveKind: 'eoi_propose_times',
    });
  });

  describe('direct request — take it on, or pass (BAL-604)', () => {
    const DIRECT_EOI = {
      relationshipStatus: 'eoi_submitted',
      requestStatus: 'eoi_submitted',
      onDirectLeg: true,
    } as const;
    const CHOICE = {
      needsYou: true,
      nudgeLabel: 'Take it on, or pass?',
      moveKind: 'direct_request',
    };

    it('the chosen expert who has not acted owes the choice — even with a client message waiting', () => {
      expect(needsYouForExpert(makeInvitation(DIRECT_EOI), SIGNAL_QUIET)).toEqual(CHOICE);
      expect(needsYouForExpert(makeInvitation(DIRECT_EOI), SIGNAL_UNREAD)).toEqual(CHOICE);
    });

    it('after sharing availability the normal eoi_submitted move applies', () => {
      const res = needsYouForExpert(
        makeInvitation({ ...DIRECT_EOI, availabilitySharedAt: day(1) }),
        SIGNAL_QUIET
      );
      expect(res.moveKind).toBe('eoi_propose_times');
    });

    it('after sending a message the normal eoi_submitted move applies', () => {
      const res = needsYouForExpert(makeInvitation(DIRECT_EOI), {
        ...SIGNAL_UNREAD,
        viewerHasSentMessage: true,
      });
      expect(res).toEqual({
        needsYou: true,
        nudgeLabel: 'Reply to client',
        moveKind: 'eoi_reply_owed',
      });
    });

    it('a non-direct track is unchanged', () => {
      const res = needsYouForExpert(
        makeInvitation({ ...DIRECT_EOI, onDirectLeg: false }),
        SIGNAL_QUIET
      );
      expect(res.moveKind).toBe('eoi_propose_times');
    });
  });

  it('proposal_requested → build your proposal', () => {
    const res = needsYouForExpert(
      makeInvitation({
        relationshipStatus: 'proposal_requested',
        requestStatus: 'proposal_requested',
      })
    );
    expect(res).toEqual({
      needsYou: true,
      nudgeLabel: 'Build your proposal',
      moveKind: 'proposal_requested',
    });
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

  it('won (relationship accepted, request accepted) → awaiting kickoff, nothing owed', () => {
    const res = needsYouForExpert(
      makeInvitation({ relationshipStatus: 'accepted', requestStatus: 'accepted' })
    );
    expect(res).toEqual({ needsYou: false, nudgeLabel: 'Awaiting kickoff', moveKind: null });
  });

  it('accepted relationship on a not-yet-accepted request → awaiting kickoff', () => {
    const res = needsYouForExpert(
      makeInvitation({ relationshipStatus: 'accepted', requestStatus: 'proposal_submitted' })
    );
    expect(res).toEqual({ needsYou: false, nudgeLabel: 'Awaiting kickoff', moveKind: null });
  });

  it('proposal_submitted with a changes_requested current proposal → revise your proposal', () => {
    const res = needsYouForExpert(
      makeInvitation({
        relationshipStatus: 'proposal_submitted',
        requestStatus: 'proposal_submitted',
        currentProposalStatus: 'changes_requested',
      })
    );
    expect(res).toEqual({
      needsYou: true,
      nudgeLabel: 'Revise your proposal',
      moveKind: 'changes_requested',
    });
  });

  it('proposal_submitted with a submitted current proposal → not needs-you', () => {
    const res = needsYouForExpert(
      makeInvitation({
        relationshipStatus: 'proposal_submitted',
        requestStatus: 'proposal_submitted',
        currentProposalStatus: 'submitted',
      })
    );
    expect(res).toEqual({ needsYou: false, nudgeLabel: 'Waiting on client', moveKind: null });
  });

  it('needsYou holds exactly when moveKind is set, over every relationship × request arm', () => {
    const relationshipStatuses = [
      'invited',
      'eoi_submitted',
      'proposal_requested',
      'proposal_submitted',
      'accepted',
      'declined',
    ] as const;
    const requestStatuses = [
      'experts_invited',
      'eoi_submitted',
      'proposal_submitted',
      'accepted',
      'kickoff_approved',
      'closed',
    ] as const;
    for (const relationshipStatus of relationshipStatuses) {
      for (const requestStatus of requestStatuses) {
        for (const currentProposalStatus of [null, 'changes_requested', 'submitted'] as const) {
          for (const signal of [SIGNAL_UNREAD, SIGNAL_QUIET]) {
            const res = needsYouForExpert(
              makeInvitation({ relationshipStatus, requestStatus, currentProposalStatus }),
              signal
            );
            expect(res.needsYou).toBe(res.moveKind !== null);
          }
        }
      }
    }
  });

  it('lost (relationship not accepted, request accepted) → not selected, not needs-you', () => {
    const res = needsYouForExpert(
      makeInvitation({ relationshipStatus: 'proposal_submitted', requestStatus: 'accepted' })
    );
    expect(res).toEqual({ needsYou: false, nudgeLabel: 'Not selected', moveKind: null });
  });

  it('won + kickoff_approved → live project, not needs-you', () => {
    const res = needsYouForExpert(
      makeInvitation({ relationshipStatus: 'accepted', requestStatus: 'kickoff_approved' })
    );
    expect(res).toEqual({ needsYou: false, nudgeLabel: 'Live project', moveKind: null });
  });

  it('closed request, even an ACCEPTED relationship → closed, not "Awaiting kickoff" (BAL-540)', () => {
    const res = needsYouForExpert(
      makeInvitation({ relationshipStatus: 'accepted', requestStatus: 'closed' })
    );
    expect(res).toEqual({ needsYou: false, nudgeLabel: 'Closed', moveKind: null });
  });

  it('closed request, an invited relationship → closed, not "Submit your EOI" (BAL-540)', () => {
    const res = needsYouForExpert(
      makeInvitation({ relationshipStatus: 'invited', requestStatus: 'closed' })
    );
    expect(res).toEqual({ needsYou: false, nudgeLabel: 'Closed', moveKind: null });
  });
});

describe('deriveEngagementRow deliveryState', () => {
  it.each([
    ['client', 'active', true, 'changes_requested'],
    ['expert', 'active', true, 'changes_requested'],
    ['client', 'active', false, 'in_delivery'],
    ['expert', 'active', false, 'in_delivery'],
    ['client', 'pending_acceptance', false, 'pending_acceptance'],
    ['expert', 'pending_acceptance', false, 'pending_acceptance'],
    ['client', 'completed', false, 'completed'],
    ['expert', 'cancelled', false, 'cancelled'],
  ] as const)('%s lens, %s, change note %s -> %s', (lens, status, hasChangeRequest, expected) => {
    expect(
      deriveEngagementRow(makeEngagementInput({ lens, status, hasChangeRequest })).deliveryState
    ).toBe(expected);
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
      moveKind: null,
      clientMoveKind: null,
      deliveryState: 'in_delivery',
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
    expect(res).toMatchObject({
      needsYou: true,
      nudgeLabel: 'Northwind requested changes',
      moveKind: 'delivery_changes',
    });
  });

  it('expert lens: needsYou holds exactly when moveKind is set, over every status × change-note arm', () => {
    for (const status of ['active', 'pending_acceptance', 'completed', 'cancelled'] as const) {
      for (const hasChangeRequest of [false, true]) {
        const res = deriveEngagementRow(
          makeEngagementInput({ lens: 'expert', status, hasChangeRequest })
        );
        expect(res.needsYou).toBe(res.moveKind !== null);
      }
    }
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

  it('client lens: needsYou holds exactly when clientMoveKind is set, and only pending_acceptance is completion', () => {
    for (const status of ['active', 'pending_acceptance', 'completed', 'cancelled'] as const) {
      for (const hasChangeRequest of [false, true]) {
        const res = deriveEngagementRow(
          makeEngagementInput({ lens: 'client', status, hasChangeRequest })
        );
        expect(res.needsYou).toBe(res.clientMoveKind !== null);
        expect(res.clientMoveKind).toBe(status === 'pending_acceptance' ? 'completion' : null);
      }
    }
  });

  it('expert lens never carries a client move kind', () => {
    for (const status of ['active', 'pending_acceptance', 'completed', 'cancelled'] as const) {
      expect(
        deriveEngagementRow(makeEngagementInput({ lens: 'expert', status, hasChangeRequest: true }))
          .clientMoveKind
      ).toBeNull();
    }
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
    expect(res).toEqual({ needsYou: true, nudgeLabel: 'Triage', clientMoveKind: null });
  });

  it('experts_invited quiet beyond threshold → stalled needs-you with day count', () => {
    const row = makeRequest({ status: 'experts_invited', updatedAt: day(5) });
    const res = needsYouFor('admin', row, SIGNAL_QUIET, NOW);
    expect(res.needsYou).toBe(true);
    expect(res.nudgeLabel).toBe('No EOIs · 5d');
  });

  it('exploratory_meeting_requested quiet beyond threshold → awaiting booking, never an EOI stall', () => {
    const row = makeRequest({ status: 'exploratory_meeting_requested', updatedAt: day(5) });
    const res = needsYouFor('admin', row, SIGNAL_QUIET, NOW);
    expect(res).toEqual({
      needsYou: false,
      nudgeLabel: 'Awaiting client booking',
      clientMoveKind: null,
    });
  });

  it('experts_invited recent → not stalled', () => {
    const row = makeRequest({ status: 'experts_invited', updatedAt: day(1) });
    const res = needsYouFor('admin', row, SIGNAL_QUIET, NOW);
    expect(res.needsYou).toBe(false);
  });

  it.each([
    [
      'billing owed',
      { clientBillingConfirmedAt: null, upfrontInvoiceRaisedAt: null },
      'Kickoff gate',
    ],
    [
      'billing in, invoice not raised',
      { clientBillingConfirmedAt: day(2), upfrontInvoiceRaisedAt: null },
      'Raise invoice',
    ],
    [
      'invoice raised',
      { clientBillingConfirmedAt: day(2), upfrontInvoiceRaisedAt: day(1) },
      'Awaiting payment',
    ],
  ] as const)('accepted, %s → needs-you', (_case, gates, nudgeLabel) => {
    const res = needsYouFor(
      'admin',
      makeRequest({ status: 'accepted', ...gates }),
      SIGNAL_QUIET,
      NOW
    );
    expect(res).toEqual({ needsYou: true, nudgeLabel, clientMoveKind: null });
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

describe('deriveEngagementRow: agency lens', () => {
  it('changes requested never asks anything of the agency and links with ?from=agency', () => {
    const res = deriveEngagementRow(
      makeEngagementInput({ lens: 'agency', status: 'active', hasChangeRequest: true })
    );
    expect(res).toMatchObject({
      needsYou: false,
      moveKind: null,
      clientMoveKind: null,
      deliveryState: 'changes_requested',
    });
    expect(res.href).toMatch(/\?from=agency$/);
  });

  it('pending acceptance reads as awaiting the client with no completion move', () => {
    const res = deriveEngagementRow(
      makeEngagementInput({ lens: 'agency', status: 'pending_acceptance' })
    );
    expect(res).toMatchObject({
      needsYou: false,
      nudgeLabel: 'Awaiting client review',
      clientMoveKind: null,
      progressLabel: null,
    });
  });

  it.each(['active', 'completed', 'cancelled'] as const)('%s never sets needsYou', (status) => {
    expect(deriveEngagementRow(makeEngagementInput({ lens: 'agency', status })).needsYou).toBe(
      false
    );
  });
});

function agencyRow(
  id: string,
  state: AgencyRowView['deliveryState'],
  atIso: string
): AgencyRowView {
  return {
    id,
    href: `/engagements/${id}?from=agency`,
    title: id,
    companyName: 'Northwind',
    deliveryState: state,
    detailLabel: null,
    changeRequestNote: null,
    deliverer: {
      expertProfileId: 'p1',
      name: 'Priya Shah',
      avatarUrl: null,
      isViewer: false,
      isFormerMember: false,
    },
    updatedRelative: 'today',
    recencyAtIso: atIso,
  };
}

describe('agency row helpers', () => {
  it('ranks changes requested, then awaiting review, then in delivery, newest first within each', () => {
    const ranked = rankAgencyRows([
      agencyRow('d-old', 'in_delivery', '2026-06-01T00:00:00.000Z'),
      agencyRow('p', 'pending_acceptance', '2026-06-02T00:00:00.000Z'),
      agencyRow('c', 'changes_requested', '2026-05-01T00:00:00.000Z'),
      agencyRow('d-new', 'in_delivery', '2026-06-10T00:00:00.000Z'),
    ]);
    expect(ranked.map((r) => r.id)).toEqual(['c', 'p', 'd-new', 'd-old']);
  });

  it('matches by deliveryState, with all matching everything', () => {
    const row = agencyRow('a', 'pending_acceptance', '2026-06-01T00:00:00.000Z');
    expect(agencyRowMatches(row, 'all')).toBe(true);
    expect(agencyRowMatches(row, 'pending_acceptance')).toBe(true);
    expect(agencyRowMatches(row, 'in_delivery')).toBe(false);
  });
});
