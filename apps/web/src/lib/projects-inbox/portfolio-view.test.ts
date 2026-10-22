import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const {
  mockListByCompany,
  mockListAll,
  mockListInvitationsByExpert,
  mockListPortfolioEngagements,
  mockListThreadSummaries,
  mockConversationIdsForContexts,
  mockFindNamesByIds,
} = vi.hoisted(() => ({
  mockListByCompany: vi.fn(),
  mockListAll: vi.fn(),
  mockListInvitationsByExpert: vi.fn(),
  mockListPortfolioEngagements: vi.fn(),
  mockListThreadSummaries: vi.fn(),
  mockConversationIdsForContexts: vi.fn(),
  // BAL-541 — the admin loader's Balo-owner name hydration. Every existing admin test throws
  // without this: `loadAdminPortfolio` now calls `usersRepository.findNamesByIds` unconditionally.
  mockFindNamesByIds: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  projectsInboxRepository: {
    listByCompany: (...args: unknown[]) => mockListByCompany(...args),
    listAll: (...args: unknown[]) => mockListAll(...args),
    listInvitationsByExpert: (...args: unknown[]) => mockListInvitationsByExpert(...args),
  },
  projectEngagementsRepository: {
    listPortfolio: (...args: unknown[]) => mockListPortfolioEngagements(...args),
  },
  conversationContextKey: (ref: { contextType: string; contextId: string }) =>
    `${ref.contextType}:${ref.contextId}`,
  conversationsRepository: {
    listThreadSummaries: (...args: unknown[]) => mockListThreadSummaries(...args),
    conversationIdsForContexts: (...args: unknown[]) => mockConversationIdsForContexts(...args),
  },
  usersRepository: {
    findNamesByIds: (...args: unknown[]) => mockFindNamesByIds(...args),
  },
  // Server-only window const; the real `@balo/shared/parties` helper runs unmocked.
  AUTO_ACCEPT_DAYS: 7,
}));

import {
  loadClientPortfolio,
  loadExpertPortfolio,
  loadAdminPortfolio,
  summaryIsUnread,
} from './portfolio-view';
import type { SessionUser } from '@/lib/auth/session';

const NOW = new Date('2026-06-16T12:00:00.000Z');
const day = (n: number): Date => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const USER: SessionUser = {
  id: 'user-1',
  email: 'dana@x.test',
  firstName: 'Dana',
  lastName: null,
  avatarUrl: null,
  activeMode: 'client',
  onboardingCompleted: true,
  platformRole: 'user',
  companyId: 'company-1',
  companyName: 'Northwind',
  companyRole: 'owner',
};

function requestRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'req-1',
    companyId: 'company-1',
    expertProfileId: null,
    status: 'experts_invited',
    title: 'CPQ implementation',
    clientBillingConfirmedAt: null,
    upfrontInvoiceRaisedAt: null,
    createdAt: day(10),
    updatedAt: day(10),
    // BAL-541 — the SHARED portfolio query now selects the Balo owner id on every lens'
    // request row. Unassigned by default; the D9 leak-invariant tests below override it with
    // a sentinel to prove `loadClientPortfolio`/`loadExpertPortfolio` never carry it forward.
    baloOwnerUserId: null,
    company: { id: 'company-1', name: 'Northwind' },
    relationships: [],
    ...overrides,
  };
}

function invitationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    relationshipId: 'rel-1',
    relationshipStatus: 'invited',
    invitedAt: day(2),
    relationshipUpdatedAt: day(2),
    proposalRequestedAt: null,
    availabilitySharedAt: null,
    projectRequestId: 'req-9',
    requestStatus: 'experts_invited',
    onDirectLeg: false,
    title: 'Experience Cloud portal',
    companyId: 'company-9',
    companyName: 'Harbour Health',
    currentProposalStatus: null,
    newestEoiAt: null,
    ...overrides,
  };
}

/** A hydrated `PortfolioProjectEngagementView` mock (the shape the loaders consume). */
function engagementView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'eng-1',
    companyId: 'company-1',
    expertProfileId: 'expert-1',
    projectRequestId: null,
    status: 'active',
    changeRequestNote: null,
    changeRequestedAt: null,
    completionRequestedAt: null,
    acceptedAt: null,
    acceptanceMethod: null,
    activatedAt: day(5),
    createdAt: day(6),
    updatedAt: day(5),
    company: { id: 'company-1', name: 'Northwind' },
    projectRequest: null,
    expertProfile: {
      id: 'expert-1',
      agencyId: null,
      type: 'freelancer',
      user: { id: 'u-e', firstName: 'Priya', lastName: 'N', avatarUrl: null },
      agency: null,
    },
    totalMilestones: 0,
    completedMilestones: 0,
    inProgressMilestones: 0,
    lastActivityAt: day(5),
    ...overrides,
  };
}

/** BAL-424: every relationship in these fixtures anchors a conversation named `conv-{relId}`. */
function convIdFor(relationshipId: string): string {
  return `conv-${relationshipId}`;
}

beforeEach(() => {
  mockListByCompany.mockReset();
  mockListAll.mockReset();
  mockListInvitationsByExpert.mockReset();
  mockListPortfolioEngagements.mockReset();
  mockListThreadSummaries.mockReset();
  mockConversationIdsForContexts.mockReset();
  mockFindNamesByIds.mockReset();
  mockListPortfolioEngagements.mockResolvedValue([]);
  mockListThreadSummaries.mockResolvedValue([]);
  // BAL-541 — `loadAdminPortfolio` calls `usersRepository.findNamesByIds` unconditionally (even
  // with an empty owner-id list, matching the real repository's empty-input short-circuit).
  // Individual tests override this when they need named owners.
  mockFindNamesByIds.mockResolvedValue([]);
  // The read-only relationship→conversation resolution the portfolio loaders use.
  mockConversationIdsForContexts.mockImplementation(
    (refs: { contextType: string; contextId: string }[]) =>
      Promise.resolve(
        new Map(refs.map((r) => [`${r.contextType}:${r.contextId}`, convIdFor(r.contextId)]))
      )
  );
});

describe('loadClientPortfolio', () => {
  it('labels request rows with the shared client vocabulary', async () => {
    mockListByCompany.mockResolvedValue([
      requestRow({ id: 'a', status: 'experts_invited' }),
      requestRow({ id: 'b', status: 'eoi_submitted' }),
      requestRow({ id: 'c', status: 'proposal_submitted' }),
    ]);
    mockListThreadSummaries.mockResolvedValue([]);

    const dto = await loadClientPortfolio(USER, ['client'], NOW);

    const labelOf = (id: string): string | undefined =>
      dto.rows.find((r) => r.id === id)?.stageLabel;
    expect(labelOf('a')).toBe('Matching');
    expect(labelOf('b')).toBe('Interest');
    expect(labelOf('c')).toBe('Proposals');
  });

  it('returns an empty DTO with isEmpty when the company has no requests or engagements', async () => {
    mockListByCompany.mockResolvedValue([]);
    const dto = await loadClientPortfolio(USER, ['client'], NOW);
    expect(dto.lens).toBe('client');
    expect(dto.isEmpty).toBe(true);
    expect(dto.rows).toEqual([]);
    expect(mockListByCompany).toHaveBeenCalledWith('company-1');
    expect(mockListPortfolioEngagements).toHaveBeenCalledWith({ companyId: 'company-1' });
    // No open relationships → summaries called with an empty id list.
    // BAL-424: with no open relationships there is nothing to map, so the summary batch is
    // called with an empty CONVERSATION id list.
    expect(mockListThreadSummaries).toHaveBeenCalledWith({
      conversationIds: [],
      viewerUserId: 'user-1',
    });
  });

  it('ranks needs-you rows first, then recency desc; folds the unread signal', async () => {
    const quiet = requestRow({ id: 'quiet', status: 'experts_invited', updatedAt: day(1) });
    const needs = requestRow({
      id: 'needs',
      status: 'eoi_submitted',
      updatedAt: day(5),
      relationships: [
        {
          id: 'rel-needs',
          expertProfileId: 'e1',
          status: 'eoi_submitted',
          invitedAt: day(5),
          updatedAt: day(5),
          proposalRequestedAt: null,
          expressionsOfInterest: [],
          conversationMessages: [{ id: 'm1', createdAt: day(1) }],
        },
      ],
    });
    mockListByCompany.mockResolvedValue([quiet, needs]);
    mockListThreadSummaries.mockResolvedValue([
      {
        conversationId: convIdFor('rel-needs'),
        latestMessage: {
          id: 'm1',
          body: '<p>Are you keeping Zendesk?</p>',
          createdAt: day(1),
          senderUserId: 'other-user',
          senderFirstName: 'Priya',
        },
        latestInboundActivityAt: day(1),
        latestOutboundMessageAt: null,
        fileCount: 0,
        lastReadAt: null,
      },
    ]);

    const dto = await loadClientPortfolio(USER, ['client', 'admin'], NOW);

    expect(dto.rows[0]?.id).toBe('needs');
    expect(dto.rows[0]?.needsYou).toBe(true);
    expect(dto.rows[0]?.unread).toBe(true);
    expect(dto.rows[0]?.signal?.messagePreview).toContain('Zendesk');
    expect(dto.rows[0]?.signal?.from).toBe('Priya');
    expect(dto.rows[1]?.id).toBe('quiet');
    expect(dto.tiles.needs).toBe(1);
    expect(dto.allowedLenses).toEqual(['client', 'admin']);
    // ⚠ BAL-424: a portfolio list is a READ — it resolves relationship→conversation with
    // `conversationIdsForContexts` and must never `ensure` (which writes).
    expect(mockConversationIdsForContexts).toHaveBeenCalledWith([
      { contextType: 'relationship', contextId: 'rel-needs' },
    ]);
    expect(mockListThreadSummaries).toHaveBeenCalledWith({
      conversationIds: [convIdFor('rel-needs')],
      viewerUserId: 'user-1',
    });
  });

  it('falls back to the counterpart label when the sender first name is null', async () => {
    const needs = requestRow({
      id: 'needs',
      status: 'eoi_submitted',
      updatedAt: day(5),
      relationships: [
        {
          id: 'rel-needs',
          expertProfileId: 'e1',
          status: 'eoi_submitted',
          invitedAt: day(5),
          updatedAt: day(5),
          proposalRequestedAt: null,
          expressionsOfInterest: [],
          conversationMessages: [{ id: 'm1', createdAt: day(1) }],
        },
      ],
    });
    mockListByCompany.mockResolvedValue([needs]);
    mockListThreadSummaries.mockResolvedValue([
      {
        conversationId: convIdFor('rel-needs'),
        latestMessage: {
          id: 'm1',
          body: '<p>Are you keeping Zendesk?</p>',
          createdAt: day(1),
          senderUserId: 'other-user',
          senderFirstName: null,
        },
        latestInboundActivityAt: day(1),
        latestOutboundMessageAt: null,
        fileCount: 0,
        lastReadAt: null,
      },
    ]);

    const dto = await loadClientPortfolio(USER, ['client'], NOW);
    expect(dto.rows[0]?.signal?.from).toBe('Expert');
  });

  it('dedups: a kickoff_approved request with an engagement renders ONE engagement row', async () => {
    mockListByCompany.mockResolvedValue([
      requestRow({ id: 'req-K', status: 'kickoff_approved', title: 'Live CPQ build' }),
    ]);
    mockListPortfolioEngagements.mockResolvedValue([
      engagementView({ id: 'eng-K', projectRequestId: 'req-K' }),
    ]);

    const dto = await loadClientPortfolio(USER, ['client'], NOW);

    expect(dto.rows).toHaveLength(1);
    expect(dto.rows[0]?.kind).toBe('engagement');
    expect(dto.rows[0]?.id).toBe('eng-K');
    expect(dto.rows[0]?.stageLabel).toBe('Delivery');
    // The superseded request row is gone.
    expect(dto.rows.some((r) => r.kind === 'request' && r.id === 'req-K')).toBe(false);
  });

  it('keeps a kickoff_approved request row when it has no engagement yet', async () => {
    mockListByCompany.mockResolvedValue([
      requestRow({ id: 'req-K', status: 'kickoff_approved', title: 'Pending kickoff' }),
    ]);
    mockListPortfolioEngagements.mockResolvedValue([]);

    const dto = await loadClientPortfolio(USER, ['client'], NOW);
    expect(dto.rows).toHaveLength(1);
    expect(dto.rows[0]?.kind).toBe('request');
    expect(dto.rows[0]?.deliveryState).toBeUndefined();
    expect(dto.rows[0]?.id).toBe('req-K');
  });

  it('resolves the counterpart party name (agency name / freelancer person name)', async () => {
    mockListByCompany.mockResolvedValue([]);
    mockListPortfolioEngagements.mockResolvedValue([
      engagementView({
        id: 'eng-agency',
        expertProfile: {
          id: 'x-a',
          agencyId: 'ag-1',
          type: 'agency',
          user: { id: 'u-a', firstName: 'Sam', lastName: 'Okafor', avatarUrl: null },
          agency: { id: 'ag-1', name: 'Cloudreach', logoUrl: null },
        },
      }),
      engagementView({
        id: 'eng-free',
        expertProfile: {
          id: 'x-f',
          agencyId: null,
          type: 'freelancer',
          user: { id: 'u-f', firstName: 'Priya', lastName: 'N', avatarUrl: null },
          agency: null,
        },
      }),
    ]);

    const dto = await loadClientPortfolio(USER, ['client'], NOW);
    expect(dto.rows.find((r) => r.id === 'eng-agency')?.companyName).toBe('Cloudreach');
    expect(dto.rows.find((r) => r.id === 'eng-free')?.companyName).toBe('Priya N');
  });

  it('client pending_acceptance engagement is needs-you with the auto-accept nudge', async () => {
    mockListByCompany.mockResolvedValue([]);
    mockListPortfolioEngagements.mockResolvedValue([
      engagementView({
        id: 'eng-pa',
        status: 'pending_acceptance',
        completionRequestedAt: day(1),
      }),
    ]);

    const dto = await loadClientPortfolio(USER, ['client'], NOW);
    const row = dto.rows.find((r) => r.id === 'eng-pa');
    expect(row?.needsYou).toBe(true);
    expect(row?.deliveryState).toBe('pending_acceptance');
    // completionRequestedAt = day(1) (2026-06-15) + AUTO_ACCEPT_DAYS(7) = 2026-06-22,
    // UTC-formatted "22 Jun" — locks the 7-day window + UTC "D MMM" format.
    expect(row?.nudgeLabel).toBe('Review project completion — auto-accepts 22 Jun');
    expect(dto.tiles.needs).toBe(1);
  });

  it('threads loader milestone counts into the deriver progress label', async () => {
    mockListByCompany.mockResolvedValue([]);
    mockListPortfolioEngagements.mockResolvedValue([
      engagementView({
        id: 'eng-prog',
        status: 'active',
        totalMilestones: 4,
        completedMilestones: 2,
      }),
    ]);

    const dto = await loadClientPortfolio(USER, ['client'], NOW);
    const row = dto.rows.find((r) => r.id === 'eng-prog');
    expect(row?.progressLabel).toBe('2 of 4 milestones');
  });

  it('BAL-540: partitions a closed request into closedRows, never rows, and excludes it from tiles', async () => {
    mockListByCompany.mockResolvedValue([
      requestRow({ id: 'req-live', status: 'experts_invited' }),
      requestRow({ id: 'req-closed', status: 'closed' }),
    ]);

    const dto = await loadClientPortfolio(USER, ['client'], NOW);

    expect(dto.rows.map((r) => r.id)).toEqual(['req-live']);
    expect(dto.closedRows.map((r) => r.id)).toEqual(['req-closed']);
    expect(dto.closedRows[0]?.stage).toBe('closed');
    expect(dto.tiles.total).toBe(1); // the closed row is not counted
    expect(dto.isEmpty).toBe(false);
  });

  it('BAL-540: closedRows is empty when there are no closed requests', async () => {
    mockListByCompany.mockResolvedValue([requestRow({ id: 'req-live' })]);
    const dto = await loadClientPortfolio(USER, ['client'], NOW);
    expect(dto.closedRows).toEqual([]);
  });
});

describe('loadExpertPortfolio', () => {
  const expertUser = { ...USER, expertProfileId: 'expert-1' };

  it('labels rows with the shared participant vocabulary', async () => {
    mockListInvitationsByExpert.mockResolvedValue([
      invitationRow({ projectRequestId: 'req-inv', relationshipStatus: 'invited' }),
      invitationRow({ projectRequestId: 'req-eoi', relationshipStatus: 'eoi_submitted' }),
    ]);
    mockListPortfolioEngagements.mockResolvedValue([
      engagementView({ id: 'eng-live', projectRequestId: 'req-live' }),
    ]);

    const dto = await loadExpertPortfolio(expertUser, ['expert'], NOW);

    const labelOf = (id: string): string | undefined =>
      dto.rows.find((r) => r.id === id)?.stageLabel;
    expect(labelOf('req-inv')).toBe('Invited');
    expect(labelOf('req-eoi')).toBe('Interest sent');
    expect(dto.rows.find((r) => r.kind === 'engagement')?.stageLabel).toBe('Delivery');
  });

  it('combines invitations + delivery engagements (no collision → both render)', async () => {
    mockListInvitationsByExpert.mockResolvedValue([invitationRow()]);
    mockListPortfolioEngagements.mockResolvedValue([
      engagementView({ id: 'eng-live', projectRequestId: 'req-live' }),
    ]);

    const dto = await loadExpertPortfolio(expertUser, ['client', 'expert'], NOW);

    expect(mockListInvitationsByExpert).toHaveBeenCalledWith('expert-1');
    expect(mockListPortfolioEngagements).toHaveBeenCalledWith({ expertProfileId: 'expert-1' });

    const invitation = dto.rows.find((r) => r.kind === 'request');
    expect(invitation?.needsYou).toBe(true);
    expect(invitation?.nudgeLabel).toBe('Submit your EOI');
    expect(invitation?.href).toBe('/projects/req-9');
    expect(invitation?.moveKind).toBe('invitation');
    expect(invitation?.relationshipId).toBe('rel-1');
    expect(invitation?.delivery).toBeUndefined();

    const engagement = dto.rows.find((r) => r.kind === 'engagement');
    expect(engagement?.href).toBe('/engagements/eng-live?from=inbox');
    expect(engagement?.stage).toBe('kicked');
    expect(engagement?.moveKind).toBeNull();
    expect(engagement?.delivery).toBeNull();
  });

  it('dedups: a kicked-off invitation superseded by its engagement renders ONE engagement row', async () => {
    mockListInvitationsByExpert.mockResolvedValue([
      invitationRow({
        relationshipStatus: 'accepted',
        requestStatus: 'kickoff_approved',
        projectRequestId: 'req-K',
      }),
    ]);
    mockListPortfolioEngagements.mockResolvedValue([
      engagementView({ id: 'eng-K', projectRequestId: 'req-K' }),
    ]);

    const dto = await loadExpertPortfolio(expertUser, ['expert'], NOW);
    expect(dto.rows).toHaveLength(1);
    expect(dto.rows[0]?.kind).toBe('engagement');
    expect(dto.rows.some((r) => r.kind === 'request')).toBe(false);
  });

  it('keeps a kicked-off invitation with no matching engagement', async () => {
    mockListInvitationsByExpert.mockResolvedValue([
      invitationRow({
        relationshipStatus: 'accepted',
        requestStatus: 'kickoff_approved',
        projectRequestId: 'req-K',
      }),
    ]);
    mockListPortfolioEngagements.mockResolvedValue([]);

    const dto = await loadExpertPortfolio(expertUser, ['expert'], NOW);
    expect(dto.rows).toHaveLength(1);
    expect(dto.rows[0]?.kind).toBe('request');
  });

  it('uses the client company as the counterpart for change-request + review nudges', async () => {
    mockListInvitationsByExpert.mockResolvedValue([]);
    mockListPortfolioEngagements.mockResolvedValue([
      engagementView({
        id: 'eng-note',
        status: 'active',
        changeRequestNote: 'Please revise the data model.',
        company: { id: 'company-1', name: 'Northwind' },
      }),
      engagementView({
        id: 'eng-pa',
        status: 'pending_acceptance',
        completionRequestedAt: day(1),
        company: { id: 'company-1', name: 'Northwind' },
      }),
    ]);

    const dto = await loadExpertPortfolio(expertUser, ['expert'], NOW);
    const note = dto.rows.find((r) => r.id === 'eng-note');
    expect(note?.needsYou).toBe(true);
    expect(note?.nudgeLabel).toBe('Northwind requested changes');
    expect(note?.moveKind).toBe('delivery_changes');
    expect(note?.delivery).toEqual({
      changeRequestNote: 'Please revise the data model.',
      milestonesDone: 0,
      milestonesTotal: 0,
    });
    const pending = dto.rows.find((r) => r.id === 'eng-pa');
    expect(pending?.needsYou).toBe(false);
    expect(pending?.nudgeLabel).toBe('Awaiting Northwind review');
    expect(pending?.moveKind).toBeNull();
    expect(pending?.delivery).toBeNull();
    // Expert-lens counterpart slot shows the client company.
    expect(note?.companyName).toBe('Northwind');
  });

  it('renders a retainer engagement (null projectRequestId) as a navigable inbox row', async () => {
    mockListInvitationsByExpert.mockResolvedValue([]);
    mockListPortfolioEngagements.mockResolvedValue([
      engagementView({ id: 'eng-retainer', projectRequestId: null, projectRequest: null }),
    ]);

    const dto = await loadExpertPortfolio(expertUser, ['expert'], NOW);
    expect(dto.rows).toHaveLength(1);
    expect(dto.rows[0]?.href).toBe('/engagements/eng-retainer?from=inbox');
    expect(dto.rows[0]?.title).toBe('Ongoing engagement');
  });

  it('completed / cancelled engagements are not needs-you and fold into the kicked tile', async () => {
    mockListInvitationsByExpert.mockResolvedValue([]);
    mockListPortfolioEngagements.mockResolvedValue([
      engagementView({ id: 'eng-done', status: 'completed' }),
      engagementView({ id: 'eng-dead', status: 'cancelled' }),
    ]);

    const dto = await loadExpertPortfolio(expertUser, ['expert'], NOW);
    expect(dto.rows.every((r) => r.needsYou === false)).toBe(true);
    expect(dto.tiles.kicked).toBe(2);
    expect(dto.tiles.needs).toBe(0);
  });

  it('BAL-540: a closed request partitions into closedRows with the closed chip, even though the relationship is declined', async () => {
    mockListInvitationsByExpert.mockResolvedValue([
      invitationRow({ relationshipStatus: 'declined', requestStatus: 'closed' }),
    ]);

    const dto = await loadExpertPortfolio(expertUser, ['expert'], NOW);

    expect(dto.rows).toEqual([]);
    expect(dto.closedRows).toHaveLength(1);
    expect(dto.closedRows[0]?.stage).toBe('closed');
    expect(dto.closedRows[0]?.stageLabel).toBe('Closed');
  });
});

describe('loadAdminPortfolio', () => {
  it('builds the triage hero, kanban columns, and tiles', async () => {
    const triageRequest = requestRow({ id: 'triage-1', status: 'requested', createdAt: day(2) });
    const stalled = requestRow({ id: 'stalled-1', status: 'experts_invited', updatedAt: day(5) });
    // Quiet just as long, but no expert has been invited yet — never an EOI stall.
    const exploratory = requestRow({
      id: 'exploratory-1',
      status: 'exploratory_meeting_requested',
      updatedAt: day(5),
    });
    const gateRequest = requestRow({
      id: 'gate-1',
      status: 'accepted',
      clientBillingConfirmedAt: null,
    });
    const liveRequest = requestRow({ id: 'live-1', status: 'kickoff_approved' });
    mockListAll.mockResolvedValue([triageRequest, stalled, exploratory, gateRequest, liveRequest]);

    const dto = await loadAdminPortfolio(['client', 'admin'], NOW);

    // BAL-540 — closed requests are excluded IN SQL now, not filtered in JS.
    expect(mockListAll).toHaveBeenCalledWith({ excludeStatuses: ['closed'] });
    expect(mockListPortfolioEngagements).toHaveBeenCalledWith({ platform: true });
    expect(dto.triage.map((t) => t.id)).toEqual(['triage-1']);
    expect(dto.triage[0]?.overdue).toBe(true);

    const exploratoryColumn = dto.kanban.find((c) => c.stage === 'exploratory');
    expect(exploratoryColumn?.items.map((i) => i.id)).toEqual(['exploratory-1']);
    expect(exploratoryColumn?.items[0]?.stalledLabel).toBeNull();

    const invitedColumn = dto.kanban.find((c) => c.stage === 'invited');
    expect(invitedColumn?.items.map((i) => i.id)).toEqual(['stalled-1']);
    expect(invitedColumn?.items[0]?.stalledLabel).toBe('No EOIs · 5d');

    const acceptedColumn = dto.kanban.find((c) => c.stage === 'accepted');
    expect(acceptedColumn?.items.map((i) => i.id)).toEqual(['gate-1']);
    expect(acceptedColumn?.items[0]?.stalledLabel).toBe('Kickoff gate');

    // Pipeline tile spans origination columns only (kickoff_approved excluded).
    expect(dto.tiles).toEqual({ untriaged: 1, stalled: 2, pipeline: 3, gate: 1 });
    expect(dto.isEmpty).toBe(false);
  });

  it('holds an accepted request on the client for billing or payment, never while Balo invoices', async () => {
    mockListAll.mockResolvedValue([
      requestRow({ id: 'billing-owed', status: 'accepted', clientBillingConfirmedAt: null }),
      requestRow({
        id: 'balo-to-invoice',
        status: 'accepted',
        clientBillingConfirmedAt: day(2),
        upfrontInvoiceRaisedAt: null,
      }),
      requestRow({
        id: 'payment-owed',
        status: 'accepted',
        clientBillingConfirmedAt: day(3),
        upfrontInvoiceRaisedAt: day(1),
      }),
    ]);

    const dto = await loadAdminPortfolio(['admin'], NOW);

    const accepted = dto.kanban.find((c) => c.stage === 'accepted');
    const labelOf = (id: string): string | null | undefined =>
      accepted?.items.find((i) => i.id === id)?.stalledLabel;
    expect(labelOf('billing-owed')).toBe('Kickoff gate');
    expect(labelOf('balo-to-invoice')).toBeNull();
    expect(labelOf('payment-owed')).toBe('Awaiting payment');
    expect(dto.tiles.gate).toBe(2);
  });

  it('appends an "In delivery" kanban column of in-flight engagements', async () => {
    mockListAll.mockResolvedValue([]);
    mockListPortfolioEngagements.mockResolvedValue([
      engagementView({
        id: 'eng-active',
        status: 'active',
        projectRequest: { id: 'req-a', title: 'Data cloud rollout' },
      }),
      engagementView({
        id: 'eng-pa',
        status: 'pending_acceptance',
        completionRequestedAt: day(1),
        projectRequest: { id: 'req-b', title: 'Portal build' },
      }),
      // Terminal engagements are excluded from the delivery column.
      engagementView({ id: 'eng-done', status: 'completed' }),
      engagementView({ id: 'eng-dead', status: 'cancelled' }),
    ]);

    const dto = await loadAdminPortfolio(['admin'], NOW);

    const delivery = dto.kanban.find((c) => c.stage === 'kicked');
    expect(delivery?.label).toBe('In delivery');
    expect(dto.kanban.map((c) => c.label)).toEqual([
      'Exploratory call',
      'Inviting',
      'Conversations',
      'Proposal requested',
      'Proposals',
      'Kickoff gate',
      'In delivery',
    ]);
    expect(delivery?.items.map((i) => i.id)).toEqual(['eng-active', 'eng-pa']);
    expect(delivery?.items.find((i) => i.id === 'eng-active')?.href).toBe(
      '/engagements/eng-active?from=inbox'
    );
    expect(delivery?.items.find((i) => i.id === 'eng-pa')?.stalledLabel).toBe('Awaiting client');
    // Origination-only pipeline tile is unaffected by the delivery column.
    expect(dto.tiles.pipeline).toBe(0);
    // Delivery rows keep the board non-empty even with no origination pipeline.
    expect(dto.isEmpty).toBe(false);
  });

  it('is empty when there are no triage cards, no pipeline items, and no delivery', async () => {
    mockListAll.mockResolvedValue([requestRow({ status: 'kickoff_approved' })]);
    mockListPortfolioEngagements.mockResolvedValue([]);
    const dto = await loadAdminPortfolio(['client', 'admin'], NOW);
    expect(dto.isEmpty).toBe(true);
  });
});

/**
 * BAL-541 (D9) — the dual-DTO leak invariant, Portfolio-DTO half. `PortfolioRowView` (client +
 * expert lens) must structurally lack `baloOwner` and never carry the owner id in ANY form;
 * `AdminKanbanCard` (admin lens ONLY) is the one place it may surface. A uuid sentinel that
 * cannot collide with any other id in either fixture payload proves absence via serialisation,
 * not just via the key check (the `request-detail-view.test.ts` fee-concealment shape, D9).
 *
 * ⚠ Positive control lives in the same file as the negative controls, deliberately — so a
 * reviewer sees both halves of the D9 statement side by side ("never here, always there").
 */
describe('BAL-541 (D9) — Balo owner never leaks into a client/expert portfolio row', () => {
  const OWNER_SENTINEL = '00000000-beef-4bad-9541-000000000541';

  it('loadClientPortfolio: PortfolioRowView carries neither baloOwner nor the owner id', async () => {
    mockListByCompany.mockResolvedValue([
      requestRow({ id: 'req-owned', baloOwnerUserId: OWNER_SENTINEL }),
    ]);
    const dto = await loadClientPortfolio(USER, ['client'], NOW);
    expect(dto.rows).toHaveLength(1);
    expect('baloOwner' in dto.rows[0]!).toBe(false);
    expect(JSON.stringify(dto.rows)).not.toContain(OWNER_SENTINEL);
  });

  it('loadExpertPortfolio: PortfolioRowView carries neither baloOwner nor the owner id', async () => {
    const expertUser = { ...USER, expertProfileId: 'expert-1' };
    // `PortfolioInvitationRow` has no `baloOwnerUserId` column at all (§6.5 — the scalar lives
    // only on the SHARED `queryPortfolioRequests` row). The extra field is passed anyway as a
    // defensive belt-and-braces check: even if a future row shape carried it, `toExpertRowView`
    // builds its return via an explicit object literal, so nothing would spread it through.
    mockListInvitationsByExpert.mockResolvedValue([
      invitationRow({ projectRequestId: 'req-9', baloOwnerUserId: OWNER_SENTINEL }),
    ]);
    const dto = await loadExpertPortfolio(expertUser, ['expert'], NOW);
    expect(dto.rows).toHaveLength(1);
    expect('baloOwner' in dto.rows[0]!).toBe(false);
    expect(JSON.stringify(dto.rows)).not.toContain(OWNER_SENTINEL);
  });

  it('loadAdminPortfolio (positive control): the matching kanban card DOES carry baloOwner', async () => {
    mockListAll.mockResolvedValue([
      requestRow({ id: 'req-owned', status: 'experts_invited', baloOwnerUserId: OWNER_SENTINEL }),
    ]);
    mockFindNamesByIds.mockResolvedValue([
      { id: OWNER_SENTINEL, firstName: 'Adeeb', lastName: 'Khan' },
    ]);
    const dto = await loadAdminPortfolio(['admin'], NOW);
    const invitedColumn = dto.kanban.find((c) => c.stage === 'invited');
    const card = invitedColumn?.items.find((i) => i.id === 'req-owned');
    expect(card?.baloOwner).toEqual({ userId: OWNER_SENTINEL, name: 'Adeeb Khan' });
    expect(mockFindNamesByIds).toHaveBeenCalledWith([OWNER_SENTINEL]);
  });
});

describe('portfolio rows — kickoff and proposal-changes rules', () => {
  const expertUser = { ...USER, expertProfileId: 'expert-1' };

  it('an accepted expert is awaiting kickoff, not needs-you', async () => {
    mockListInvitationsByExpert.mockResolvedValue([
      invitationRow({ relationshipStatus: 'accepted', requestStatus: 'accepted' }),
    ]);
    mockListPortfolioEngagements.mockResolvedValue([]);

    const dto = await loadExpertPortfolio(expertUser, ['expert'], NOW);
    expect(dto.rows[0]).toMatchObject({
      needsYou: false,
      nudgeLabel: 'Awaiting kickoff',
      moveKind: null,
    });
    expect(dto.tiles.needs).toBe(0);
  });

  it('a changes_requested current proposal surfaces as a needs-you changes_requested row', async () => {
    mockListInvitationsByExpert.mockResolvedValue([
      invitationRow({
        relationshipStatus: 'proposal_submitted',
        requestStatus: 'proposal_submitted',
        currentProposalStatus: 'changes_requested',
      }),
    ]);
    mockListPortfolioEngagements.mockResolvedValue([]);

    const dto = await loadExpertPortfolio(expertUser, ['expert'], NOW);
    expect(dto.rows[0]).toMatchObject({
      needsYou: true,
      nudgeLabel: 'Revise your proposal',
      moveKind: 'changes_requested',
      relationshipId: 'rel-1',
    });
    expect(dto.tiles.needs).toBe(1);
  });
});

/** A hydrated relationship row as `PortfolioRequestRow` carries it. */
function relationshipRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'rel-1',
    expertProfileId: 'expert-1',
    status: 'eoi_submitted',
    invitedAt: day(5),
    updatedAt: day(5),
    proposalRequestedAt: null,
    expressionsOfInterest: [],
    conversationMessages: [],
    proposals: [],
    ...overrides,
  };
}

function summaryFor(
  relationshipId: string,
  sender: string,
  inboundDaysAgo: number
): Record<string, unknown> {
  return {
    conversationId: convIdFor(relationshipId),
    latestMessage: {
      id: `m-${relationshipId}`,
      body: `<p>Note from ${relationshipId}</p>`,
      createdAt: day(inboundDaysAgo),
      senderUserId: sender,
      senderFirstName: 'Priya',
    },
    latestInboundActivityAt: day(inboundDaysAgo),
    latestOutboundMessageAt: sender === 'user-1' ? day(inboundDaysAgo) : null,
    fileCount: 0,
    lastReadAt: null,
  };
}

describe('freshest inbound signal (shared fold)', () => {
  it('client lens skips a thread whose latest message is the viewer, and falls through to the next inbound thread', async () => {
    mockListByCompany.mockResolvedValue([
      requestRow({
        id: 'req-s',
        status: 'eoi_submitted',
        relationships: [relationshipRow({ id: 'rel-own' }), relationshipRow({ id: 'rel-in' })],
      }),
    ]);
    mockListThreadSummaries.mockResolvedValue([
      summaryFor('rel-own', 'user-1', 1),
      summaryFor('rel-in', 'other-user', 3),
    ]);
    const dto = await loadClientPortfolio(USER, ['client'], NOW);
    expect(dto.rows[0]?.signal).toMatchObject({
      messagePreview: 'Note from rel-in',
      relationshipId: 'rel-in',
    });
  });

  it('client lens returns a null signal when the viewer sent the only latest message', async () => {
    mockListByCompany.mockResolvedValue([
      requestRow({
        id: 'req-s',
        status: 'eoi_submitted',
        relationships: [relationshipRow({ id: 'rel-own' })],
      }),
    ]);
    mockListThreadSummaries.mockResolvedValue([summaryFor('rel-own', 'user-1', 1)]);
    const dto = await loadClientPortfolio(USER, ['client'], NOW);
    expect(dto.rows[0]?.signal).toBeNull();
  });

  it('expert lens skips a thread whose latest message is the viewer', async () => {
    mockListInvitationsByExpert.mockResolvedValue([invitationRow({ relationshipId: 'rel-x' })]);
    mockListThreadSummaries.mockResolvedValue([summaryFor('rel-x', 'user-1', 1)]);
    const dto = await loadExpertPortfolio(
      { ...USER, expertProfileId: 'expert-1' },
      ['expert'],
      NOW
    );
    expect(dto.rows[0]?.signal).toBeNull();
  });

  it('expert lens previews an inbound message and names its relationship', async () => {
    mockListInvitationsByExpert.mockResolvedValue([invitationRow({ relationshipId: 'rel-x' })]);
    mockListThreadSummaries.mockResolvedValue([summaryFor('rel-x', 'client-user', 1)]);
    const dto = await loadExpertPortfolio(
      { ...USER, expertProfileId: 'expert-1' },
      ['expert'],
      NOW
    );
    expect(dto.rows[0]?.signal).toMatchObject({ relationshipId: 'rel-x' });
  });
});

describe('direct request choice on the expert row (BAL-604)', () => {
  const DIRECT_EOI = {
    relationshipId: 'rel-d',
    relationshipStatus: 'eoi_submitted',
    requestStatus: 'eoi_submitted',
    onDirectLeg: true,
  };
  const expertViewer = { ...USER, expertProfileId: 'expert-1' };

  it('asks the chosen expert to take it on or pass until they write in the thread', async () => {
    mockListInvitationsByExpert.mockResolvedValue([invitationRow(DIRECT_EOI)]);
    mockListThreadSummaries.mockResolvedValue([summaryFor('rel-d', 'client-user', 1)]);
    const dto = await loadExpertPortfolio(expertViewer, ['expert'], NOW);
    expect(dto.rows[0]).toMatchObject({
      needsYou: true,
      nudgeLabel: 'Take it on, or pass?',
      moveKind: 'direct_request',
      stage: 'eoi',
    });
  });

  it('folds the viewer’s own message as having acted', async () => {
    mockListInvitationsByExpert.mockResolvedValue([invitationRow(DIRECT_EOI)]);
    mockListThreadSummaries.mockResolvedValue([summaryFor('rel-d', 'user-1', 1)]);
    const dto = await loadExpertPortfolio(expertViewer, ['expert'], NOW);
    expect(dto.rows[0]?.moveKind).not.toBe('direct_request');
    expect(dto.rows[0]?.nudgeLabel).not.toBe('Take it on, or pass?');
  });
});

describe('client row move kind, thread refs and engagement facts', () => {
  it('sets clientMoveKind and lists only open relationships as thread refs with their expert', async () => {
    mockListByCompany.mockResolvedValue([
      requestRow({
        id: 'req-t',
        status: 'proposal_submitted',
        relationships: [
          relationshipRow({ id: 'rel-a', expertProfileId: 'ex-a', status: 'proposal_submitted' }),
          relationshipRow({ id: 'rel-b', expertProfileId: 'ex-b', status: 'declined' }),
        ],
      }),
    ]);
    const dto = await loadClientPortfolio(USER, ['client'], NOW);
    expect(dto.rows[0]).toMatchObject({
      needsYou: true,
      clientMoveKind: 'proposal_review',
      threadRefs: [{ contextType: 'relationship', contextId: 'rel-a', expertProfileId: 'ex-a' }],
    });
  });

  it('a changes_requested proposal reads "Waiting on expert" and is not needs-you', async () => {
    mockListByCompany.mockResolvedValue([
      requestRow({
        id: 'req-c',
        status: 'proposal_submitted',
        relationships: [
          relationshipRow({
            id: 'rel-a',
            status: 'proposal_submitted',
            proposals: [{ status: 'changes_requested' }],
          }),
        ],
      }),
    ]);
    const dto = await loadClientPortfolio(USER, ['client'], NOW);
    expect(dto.rows[0]).toMatchObject({
      needsYou: false,
      nudgeLabel: 'Waiting on expert',
      clientMoveKind: null,
    });
  });

  it('a declined relationship yields no thread refs', async () => {
    mockListByCompany.mockResolvedValue([
      requestRow({
        id: 'req-closed',
        status: 'closed',
        relationships: [relationshipRow({ id: 'rel-a', status: 'declined' })],
      }),
    ]);
    const dto = await loadClientPortfolio(USER, ['client'], NOW);
    expect(dto.closedRows[0]?.threadRefs).toEqual([]);
  });

  it('client pending_acceptance engagement carries completion, expert profile and a thread ref', async () => {
    mockListPortfolioEngagements.mockResolvedValue([
      engagementView({
        id: 'eng-pa',
        status: 'pending_acceptance',
        completionRequestedAt: day(1),
        totalMilestones: 4,
        completedMilestones: 4,
      }),
    ]);
    mockListByCompany.mockResolvedValue([]);
    const dto = await loadClientPortfolio(USER, ['client'], NOW);
    expect(dto.rows[0]).toMatchObject({
      clientMoveKind: 'completion',
      expertProfileId: 'expert-1',
      completion: {
        milestonesDone: 4,
        milestonesTotal: 4,
        completionRequestedAtIso: day(1).toISOString(),
        autoAcceptAtIso: new Date(day(1).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
      threadRefs: [{ contextType: 'engagement', contextId: 'eng-pa', expertProfileId: 'expert-1' }],
    });
  });

  it('client pending_acceptance without a completion request has null completion', async () => {
    mockListPortfolioEngagements.mockResolvedValue([
      engagementView({ id: 'eng-pa', status: 'pending_acceptance', completionRequestedAt: null }),
    ]);
    mockListByCompany.mockResolvedValue([]);
    const dto = await loadClientPortfolio(USER, ['client'], NOW);
    expect(dto.rows[0]?.completion).toBeNull();
  });

  it('completed and cancelled engagements have no thread refs; active ones have one', async () => {
    mockListByCompany.mockResolvedValue([]);
    mockListPortfolioEngagements.mockResolvedValue([
      engagementView({ id: 'eng-done', status: 'completed' }),
      engagementView({ id: 'eng-off', status: 'cancelled' }),
      engagementView({ id: 'eng-live', status: 'active' }),
    ]);
    const dto = await loadClientPortfolio(USER, ['client'], NOW);
    const refs = Object.fromEntries(dto.rows.map((r) => [r.id, r.threadRefs]));
    expect(refs['eng-done']).toEqual([]);
    expect(refs['eng-off']).toEqual([]);
    expect(refs['eng-live']).toHaveLength(1);
  });

  it('expert rows carry no client move kind or client-only engagement fields', async () => {
    mockListInvitationsByExpert.mockResolvedValue([]);
    mockListPortfolioEngagements.mockResolvedValue([
      engagementView({ id: 'eng-pa', status: 'pending_acceptance', completionRequestedAt: day(1) }),
    ]);
    const dto = await loadExpertPortfolio(
      { ...USER, expertProfileId: 'expert-1' },
      ['expert'],
      NOW
    );
    expect(dto.rows[0]?.clientMoveKind).toBeNull();
    expect(dto.rows[0]?.completion).toBeUndefined();
    expect(dto.rows[0]?.expertProfileId).toBeUndefined();
  });
});

describe('expert thread refs', () => {
  const expertUser = { ...USER, expertProfileId: 'expert-1' };
  const refsFor = async (overrides: Record<string, unknown>): Promise<unknown> => {
    mockListInvitationsByExpert.mockResolvedValue([invitationRow(overrides)]);
    const dto = await loadExpertPortfolio(expertUser, ['expert'], NOW);
    return [...dto.rows, ...dto.closedRows][0]?.threadRefs;
  };

  it('an undecided request with an open relationship has one ref', async () => {
    expect(await refsFor({ relationshipStatus: 'eoi_submitted' })).toEqual([
      { contextType: 'relationship', contextId: 'rel-1', expertProfileId: null },
    ]);
  });

  it('the accepted relationship on a decided request keeps its ref', async () => {
    expect(
      await refsFor({ relationshipStatus: 'accepted', requestStatus: 'accepted' })
    ).toHaveLength(1);
  });

  it.each([
    ['not selected', { relationshipStatus: 'proposal_submitted', requestStatus: 'accepted' }],
    ['declined', { relationshipStatus: 'declined' }],
    ['closed request', { relationshipStatus: 'accepted', requestStatus: 'closed' }],
  ])('%s has no refs', async (_name, overrides) => {
    expect(await refsFor(overrides)).toEqual([]);
  });
});

describe('summaryIsUnread', () => {
  const summary = (inbound: Date | null, readAt: Date | null) =>
    ({ latestInboundActivityAt: inbound, lastReadAt: readAt }) as Parameters<
      typeof summaryIsUnread
    >[0];

  it('is unread only when inbound activity is newer than the read mark', () => {
    expect(summaryIsUnread(summary(null, null))).toBe(false);
    expect(summaryIsUnread(summary(day(1), null))).toBe(true);
    expect(summaryIsUnread(summary(day(2), day(1)))).toBe(false);
    expect(summaryIsUnread(summary(day(1), day(2)))).toBe(true);
  });
});
