import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const {
  mockListByCompany,
  mockListAll,
  mockListInvitationsByExpert,
  mockListPortfolioEngagements,
  mockListThreadSummaries,
} = vi.hoisted(() => ({
  mockListByCompany: vi.fn(),
  mockListAll: vi.fn(),
  mockListInvitationsByExpert: vi.fn(),
  mockListPortfolioEngagements: vi.fn(),
  mockListThreadSummaries: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  projectsInboxRepository: {
    listByCompany: (...args: unknown[]) => mockListByCompany(...args),
    listAll: (...args: unknown[]) => mockListAll(...args),
    listInvitationsByExpert: (...args: unknown[]) => mockListInvitationsByExpert(...args),
  },
  engagementsRepository: {
    listPortfolioEngagements: (...args: unknown[]) => mockListPortfolioEngagements(...args),
  },
  conversationsRepository: {
    listThreadSummaries: (...args: unknown[]) => mockListThreadSummaries(...args),
  },
  // Server-only window const; the real `@balo/shared/parties` helper runs unmocked.
  AUTO_ACCEPT_DAYS: 7,
}));

import { loadClientPortfolio, loadExpertPortfolio, loadAdminPortfolio } from './portfolio-view';
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
    expertTermsConfirmedAt: null,
    createdAt: day(10),
    updatedAt: day(10),
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
    projectRequestId: 'req-9',
    requestStatus: 'experts_invited',
    title: 'Experience Cloud portal',
    companyId: 'company-9',
    companyName: 'Harbour Health',
    newestEoiAt: null,
    ...overrides,
  };
}

/** A hydrated `PortfolioEngagementView` mock (the shape the loaders consume). */
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

beforeEach(() => {
  mockListByCompany.mockReset();
  mockListAll.mockReset();
  mockListInvitationsByExpert.mockReset();
  mockListPortfolioEngagements.mockReset();
  mockListThreadSummaries.mockReset();
  mockListPortfolioEngagements.mockResolvedValue([]);
  mockListThreadSummaries.mockResolvedValue([]);
});

describe('loadClientPortfolio', () => {
  it('returns an empty DTO with isEmpty when the company has no requests or engagements', async () => {
    mockListByCompany.mockResolvedValue([]);
    const dto = await loadClientPortfolio(USER, ['client'], NOW);
    expect(dto.lens).toBe('client');
    expect(dto.isEmpty).toBe(true);
    expect(dto.rows).toEqual([]);
    expect(mockListByCompany).toHaveBeenCalledWith('company-1');
    expect(mockListPortfolioEngagements).toHaveBeenCalledWith({ companyId: 'company-1' });
    // No open relationships → summaries called with an empty id list.
    expect(mockListThreadSummaries).toHaveBeenCalledWith({
      relationshipIds: [],
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
        relationshipId: 'rel-needs',
        latestMessage: {
          id: 'm1',
          body: '<p>Are you keeping Zendesk?</p>',
          createdAt: day(1),
          senderUserId: 'other-user',
          senderFirstName: 'Priya',
        },
        latestInboundActivityAt: day(1),
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
    expect(mockListThreadSummaries).toHaveBeenCalledWith({
      relationshipIds: ['rel-needs'],
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
        relationshipId: 'rel-needs',
        latestMessage: {
          id: 'm1',
          body: '<p>Are you keeping Zendesk?</p>',
          createdAt: day(1),
          senderUserId: 'other-user',
          senderFirstName: null,
        },
        latestInboundActivityAt: day(1),
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
    // completionRequestedAt = day(1) (2026-06-15) + AUTO_ACCEPT_DAYS(7) = 2026-06-22,
    // UTC-formatted "Jun 22" — locks the 7-day window + UTC "MMM D" format.
    expect(row?.nudgeLabel).toBe('Review project completion — auto-accepts Jun 22');
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
});

describe('loadExpertPortfolio', () => {
  const expertUser = { ...USER, expertProfileId: 'expert-1' };

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

    const engagement = dto.rows.find((r) => r.kind === 'engagement');
    expect(engagement?.href).toBe('/engagements/eng-live?entry=inbox');
    expect(engagement?.stage).toBe('kicked');
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
    const pending = dto.rows.find((r) => r.id === 'eng-pa');
    expect(pending?.needsYou).toBe(false);
    expect(pending?.nudgeLabel).toBe('Awaiting Northwind review');
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
    expect(dto.rows[0]?.href).toBe('/engagements/eng-retainer?entry=inbox');
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
});

describe('loadAdminPortfolio', () => {
  it('builds the triage hero, kanban columns, and tiles', async () => {
    const triageRequest = requestRow({ id: 'triage-1', status: 'requested', createdAt: day(2) });
    const stalled = requestRow({ id: 'stalled-1', status: 'experts_invited', updatedAt: day(5) });
    const gateRequest = requestRow({
      id: 'gate-1',
      status: 'accepted',
      clientBillingConfirmedAt: day(1),
      expertTermsConfirmedAt: null,
    });
    const liveRequest = requestRow({ id: 'live-1', status: 'kickoff_approved' });
    mockListAll.mockResolvedValue([triageRequest, stalled, gateRequest, liveRequest]);

    const dto = await loadAdminPortfolio(['client', 'admin'], NOW);

    expect(mockListAll).toHaveBeenCalledWith();
    expect(mockListPortfolioEngagements).toHaveBeenCalledWith({ platform: true });
    expect(dto.triage.map((t) => t.id)).toEqual(['triage-1']);
    expect(dto.triage[0]?.overdue).toBe(true);

    const invitedColumn = dto.kanban.find((c) => c.stage === 'invited');
    expect(invitedColumn?.items.map((i) => i.id)).toEqual(['stalled-1']);
    expect(invitedColumn?.items[0]?.stalledLabel).toBe('No EOIs · 5d');

    const acceptedColumn = dto.kanban.find((c) => c.stage === 'accepted');
    expect(acceptedColumn?.items.map((i) => i.id)).toEqual(['gate-1']);
    expect(acceptedColumn?.items[0]?.stalledLabel).toBe('Kickoff gate');

    // Pipeline tile spans origination columns only (kickoff_approved excluded).
    expect(dto.tiles).toEqual({ untriaged: 1, stalled: 2, pipeline: 2, gate: 1 });
    expect(dto.isEmpty).toBe(false);
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
    expect(delivery?.items.map((i) => i.id)).toEqual(['eng-active', 'eng-pa']);
    expect(delivery?.items.find((i) => i.id === 'eng-active')?.href).toBe(
      '/engagements/eng-active?entry=inbox'
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
