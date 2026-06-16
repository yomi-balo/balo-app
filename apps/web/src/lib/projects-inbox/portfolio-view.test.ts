import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const {
  mockListByCompany,
  mockListAll,
  mockListInvitationsByExpert,
  mockListEngagementsByExpert,
  mockListThreadSummaries,
} = vi.hoisted(() => ({
  mockListByCompany: vi.fn(),
  mockListAll: vi.fn(),
  mockListInvitationsByExpert: vi.fn(),
  mockListEngagementsByExpert: vi.fn(),
  mockListThreadSummaries: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  projectsInboxRepository: {
    listByCompany: (...args: unknown[]) => mockListByCompany(...args),
    listAll: (...args: unknown[]) => mockListAll(...args),
    listInvitationsByExpert: (...args: unknown[]) => mockListInvitationsByExpert(...args),
    listEngagementsByExpert: (...args: unknown[]) => mockListEngagementsByExpert(...args),
  },
  conversationsRepository: {
    listThreadSummaries: (...args: unknown[]) => mockListThreadSummaries(...args),
  },
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

beforeEach(() => {
  mockListByCompany.mockReset();
  mockListAll.mockReset();
  mockListInvitationsByExpert.mockReset();
  mockListEngagementsByExpert.mockReset();
  mockListThreadSummaries.mockReset();
  mockListThreadSummaries.mockResolvedValue([]);
});

describe('loadClientPortfolio', () => {
  it('returns an empty DTO with isEmpty when the company has no requests', async () => {
    mockListByCompany.mockResolvedValue([]);
    const dto = await loadClientPortfolio(USER, ['client'], NOW);
    expect(dto.lens).toBe('client');
    expect(dto.isEmpty).toBe(true);
    expect(dto.rows).toEqual([]);
    expect(mockListByCompany).toHaveBeenCalledWith('company-1');
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
    // The signal carries the sender's real first name, not the generic label.
    expect(dto.rows[0]?.signal?.from).toBe('Priya');
    expect(dto.rows[1]?.id).toBe('quiet');
    expect(dto.tiles.needs).toBe(1);
    expect(dto.allowedLenses).toEqual(['client', 'admin']);
    // Open thread ids are batched in one call.
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
});

describe('loadExpertPortfolio', () => {
  it('combines invitations + engagements; an invited relationship needs-you', async () => {
    mockListInvitationsByExpert.mockResolvedValue([
      {
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
      },
    ]);
    mockListEngagementsByExpert.mockResolvedValue([
      { id: 'eng-1', projectRequestId: 'req-live', activatedAt: day(20), createdAt: day(21) },
    ]);

    const expertUser = { ...USER, expertProfileId: 'expert-1' };
    const dto = await loadExpertPortfolio(expertUser, ['client', 'expert'], NOW);

    expect(mockListInvitationsByExpert).toHaveBeenCalledWith('expert-1');
    expect(mockListEngagementsByExpert).toHaveBeenCalledWith('expert-1');

    const invitationRow = dto.rows.find((r) => r.kind === 'request');
    expect(invitationRow?.needsYou).toBe(true);
    expect(invitationRow?.nudgeLabel).toBe('Submit your EOI');
    expect(invitationRow?.href).toBe('/projects/req-9');

    const engagementRow = dto.rows.find((r) => r.kind === 'engagement');
    expect(engagementRow?.href).toBe('/projects/req-live');
    expect(engagementRow?.stage).toBe('kicked');
  });

  it('renders an engagement with a null projectRequestId as a non-navigable row', async () => {
    mockListInvitationsByExpert.mockResolvedValue([]);
    mockListEngagementsByExpert.mockResolvedValue([
      { id: 'eng-2', projectRequestId: null, activatedAt: day(3), createdAt: day(3) },
    ]);
    const dto = await loadExpertPortfolio(
      { ...USER, expertProfileId: 'expert-1' },
      ['expert'],
      NOW
    );
    expect(dto.rows[0]?.href).toBeNull();
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
    // Triage hero = requested; raised > 24h ago → overdue.
    expect(dto.triage.map((t) => t.id)).toEqual(['triage-1']);
    expect(dto.triage[0]?.overdue).toBe(true);

    // Kanban excludes requested + kickoff_approved; stalled invited flagged.
    const invitedColumn = dto.kanban.find((c) => c.stage === 'invited');
    expect(invitedColumn?.items.map((i) => i.id)).toEqual(['stalled-1']);
    expect(invitedColumn?.items[0]?.stalledLabel).toBe('No EOIs · 5d');

    const acceptedColumn = dto.kanban.find((c) => c.stage === 'accepted');
    expect(acceptedColumn?.items.map((i) => i.id)).toEqual(['gate-1']);
    expect(acceptedColumn?.items[0]?.stalledLabel).toBe('Kickoff gate');

    expect(dto.tiles).toEqual({ untriaged: 1, stalled: 2, pipeline: 2, gate: 1 });
    expect(dto.isEmpty).toBe(false);
  });

  it('is empty when there are no triage cards and no pipeline items', async () => {
    mockListAll.mockResolvedValue([requestRow({ status: 'kickoff_approved' })]);
    const dto = await loadAdminPortfolio(['client', 'admin'], NOW);
    expect(dto.isEmpty).toBe(true);
  });
});
