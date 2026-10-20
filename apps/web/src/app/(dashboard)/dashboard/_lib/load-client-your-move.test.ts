import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const m = vi.hoisted(() => ({
  hasCapability: vi.fn(),
  loadClientPortfolio: vi.fn(),
  listOpenAssignedToClient: vi.fn(),
  listOpenCases: vi.fn(),
  listCaseTrailMeetings: vi.fn(),
  listPendingByParty: vi.fn(),
  findByCompanyId: vi.fn(),
  readHoldStatus: vi.fn(),
  findOpenByCompany: vi.fn(),
  listClientMoveDetails: vi.fn(),
  findExpertPartyNames: vi.fn(),
  findLivePendingByMeetingIds: vi.fn(),
  listLiveOptionStartsByProposalIds: vi.fn(),
  conversationIdsForContexts: vi.fn(),
  listThreadSummaries: vi.fn(),
  countUnreadForViewer: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({ log: { error: vi.fn(), info: vi.fn(), warn: m.warn } }));
vi.mock('@/lib/authz', () => ({
  CAPABILITIES: {
    MANAGE_BILLING: 'manage_billing',
    PARTICIPATE: 'participate',
    MANAGE_MEMBERS: 'manage_members',
  },
  hasCapability: m.hasCapability,
}));
vi.mock('@balo/db', () => ({
  MAX_CASES_INDEX_PAGE_SIZE: 50,
  conversationContextKey: (ref: { contextType: string; contextId: string }) =>
    `${ref.contextType}:${ref.contextId}`,
  actionItemsRepository: { listOpenAssignedToClient: m.listOpenAssignedToClient },
  casesIndexRepository: {
    listOpenCases: m.listOpenCases,
    listCaseTrailMeetings: m.listCaseTrailMeetings,
  },
  partyJoinRequestsRepository: { listPendingByParty: m.listPendingByParty },
  creditWalletsRepository: { findByCompanyId: m.findByCompanyId },
  creditReceivablesRepository: {
    readHoldStatus: m.readHoldStatus,
    findOpenByCompany: m.findOpenByCompany,
  },
  projectsInboxRepository: { listClientMoveDetails: m.listClientMoveDetails },
  upcomingMeetingsRepository: { findExpertPartyNames: m.findExpertPartyNames },
  rescheduleProposalsRepository: {
    findLivePendingByMeetingIds: m.findLivePendingByMeetingIds,
    listLiveOptionStartsByProposalIds: m.listLiveOptionStartsByProposalIds,
  },
  conversationsRepository: {
    conversationIdsForContexts: m.conversationIdsForContexts,
    listThreadSummaries: m.listThreadSummaries,
    countUnreadForViewer: m.countUnreadForViewer,
  },
}));
vi.mock('@/lib/projects-inbox/portfolio-view', () => ({
  loadClientPortfolio: m.loadClientPortfolio,
  summaryIsUnread: (s: { unread: boolean }) => s.unread,
}));
vi.mock('../../cases/_lib/build-cases-index-cards', () => ({
  indexLiveProposals: (
    proposals: { meetingId: string; expiresAt: Date }[],
    now: Date
  ): Map<string, unknown> =>
    new Map(proposals.filter((p) => p.expiresAt > now).map((p) => [p.meetingId, p])),
}));

import { loadClientYourMove } from './load-client-your-move';
import type { SessionUser } from '@/lib/auth/session';

const NOW = new Date('2026-10-20T10:00:00.000Z');
const USER = { id: 'user-1', companyId: 'co-1' } as SessionUser;
const INPUT = { user: USER, companyId: 'co-1', companyName: 'Northwind', now: NOW };

const caseRow = {
  engagementId: 'case-1',
  title: 'Flow error triage',
  expertProfileId: 'ep-1',
};

function portfolioRow(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    href: `/projects/${id}`,
    title: id,
    companyName: null,
    needsYou: false,
    clientMoveKind: null,
    moveKind: null,
    kind: 'request',
    updatedRelative: 'today',
    recencyAtIso: NOW.toISOString(),
    signal: null,
    threadRefs: [{ contextType: 'relationship', contextId: `rel-${id}`, expertProfileId: 'ep-1' }],
    ...over,
  };
}

function allow(...granted: string[]): void {
  m.hasCapability.mockImplementation((_user: unknown, capability: string) =>
    Promise.resolve(granted.includes(capability))
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  allow('manage_billing', 'participate', 'manage_members');
  m.loadClientPortfolio.mockResolvedValue({ rows: [], closedRows: [] });
  m.listOpenAssignedToClient.mockResolvedValue([]);
  m.listOpenCases.mockResolvedValue({ rows: [], hasMore: false });
  m.listCaseTrailMeetings.mockResolvedValue(new Map());
  m.listPendingByParty.mockResolvedValue([]);
  m.findByCompanyId.mockResolvedValue(undefined);
  m.readHoldStatus.mockResolvedValue({ onHold: false, amountToClearMinor: 0 });
  m.findOpenByCompany.mockResolvedValue([]);
  m.listClientMoveDetails.mockResolvedValue(new Map());
  m.findExpertPartyNames.mockResolvedValue([]);
  m.findLivePendingByMeetingIds.mockResolvedValue([]);
  m.listLiveOptionStartsByProposalIds.mockResolvedValue(new Map());
  m.conversationIdsForContexts.mockResolvedValue(new Map());
  m.listThreadSummaries.mockResolvedValue([]);
  m.countUnreadForViewer.mockResolvedValue(new Map());
});

describe('capability gates', () => {
  it('without billing, never reads the wallet or receivables and builds no billing card', async () => {
    allow('participate', 'manage_members');
    m.findByCompanyId.mockResolvedValue({ id: 'w-1' });
    m.readHoldStatus.mockResolvedValue({ onHold: true, amountToClearMinor: 100 });
    m.findOpenByCompany.mockResolvedValue([{ openedAt: NOW }]);
    const cards = await loadClientYourMove(INPUT);
    expect(m.findByCompanyId).not.toHaveBeenCalled();
    expect(m.readHoldStatus).not.toHaveBeenCalled();
    expect(m.findOpenByCompany).not.toHaveBeenCalled();
    expect(cards.find((c) => c.kind === 'receivable')).toBeUndefined();
  });

  it('without participate, never reads action items, cases, reschedules or message threads', async () => {
    allow('manage_billing', 'manage_members');
    m.loadClientPortfolio.mockResolvedValue({ rows: [portfolioRow('quiet')], closedRows: [] });
    m.listOpenAssignedToClient.mockResolvedValue([
      { engagementId: 'e', engagementType: 'case', expertProfileId: 'ep-1' },
    ]);
    const cards = await loadClientYourMove(INPUT);
    expect(m.listOpenAssignedToClient).not.toHaveBeenCalled();
    expect(m.listOpenCases).not.toHaveBeenCalled();
    expect(m.listCaseTrailMeetings).not.toHaveBeenCalled();
    expect(m.findLivePendingByMeetingIds).not.toHaveBeenCalled();
    expect(m.conversationIdsForContexts).not.toHaveBeenCalled();
    expect(m.listThreadSummaries).not.toHaveBeenCalled();
    expect(
      cards.filter((c) => ['action_items', 'messages', 'reschedule'].includes(c.kind))
    ).toEqual([]);
  });

  it('without manage_members, never reads join requests', async () => {
    allow('manage_billing', 'participate');
    m.listPendingByParty.mockResolvedValue([
      { createdAt: NOW, requester: { firstName: 'R', lastName: null, email: 'r@x.example' } },
    ]);
    const cards = await loadClientYourMove(INPUT);
    expect(m.listPendingByParty).not.toHaveBeenCalled();
    expect(cards.find((c) => c.kind === 'join_requests')).toBeUndefined();
  });

  it('resolves each gate on the company scope', async () => {
    await loadClientYourMove(INPUT);
    expect(m.hasCapability).toHaveBeenCalledTimes(3);
    for (const call of m.hasCapability.mock.calls) {
      expect(call[0]).toBe(USER);
      expect(call[2]).toEqual({ companyId: 'co-1' });
    }
  });

  it('project cards stay ungated: with every gate false they still render', async () => {
    allow();
    m.loadClientPortfolio.mockResolvedValue({
      rows: [portfolioRow('need-1', { needsYou: true, clientMoveKind: 'exploratory_call' })],
      closedRows: [],
    });
    const cards = await loadClientYourMove(INPUT);
    expect(cards.map((c) => c.id)).toEqual(['need-1']);
    expect(m.listClientMoveDetails).toHaveBeenCalledWith({
      companyId: 'co-1',
      projectRequestIds: ['need-1'],
    });
  });
});

describe('billing hold', () => {
  it('no wallet gives no card and no hold read', async () => {
    const cards = await loadClientYourMove(INPUT);
    expect(m.readHoldStatus).not.toHaveBeenCalled();
    expect(cards).toEqual([]);
  });

  it('a covered hold gives no card', async () => {
    m.findByCompanyId.mockResolvedValue({ id: 'w-1' });
    m.readHoldStatus.mockResolvedValue({ onHold: true, amountToClearMinor: 0 });
    m.findOpenByCompany.mockResolvedValue([{ openedAt: NOW }]);
    expect(await loadClientYourMove(INPUT)).toEqual([]);
    expect(m.findOpenByCompany).not.toHaveBeenCalled();
  });

  it('an uncovered hold gives a card dated from the earliest opened receivable, with no figure', async () => {
    m.findByCompanyId.mockResolvedValue({ id: 'w-1' });
    m.readHoldStatus.mockResolvedValue({ onHold: true, amountToClearMinor: 12345 });
    m.findOpenByCompany.mockResolvedValue([
      { openedAt: new Date('2026-10-17T12:00:00.000Z') },
      { openedAt: new Date('2026-10-19T12:00:00.000Z') },
    ]);
    const cards = await loadClientYourMove(INPUT);
    const [card] = cards;
    expect(card?.kind).toBe('receivable');
    expect(card?.factAt).toEqual({ template: 'since', iso: '2026-10-17T12:00:00.000Z' });
    expect(JSON.stringify(cards)).not.toContain('12345');
  });
});

describe('reschedule options', () => {
  it('builds a card for a live proposal and drops an expired one', async () => {
    m.listOpenCases.mockResolvedValue({ rows: [caseRow], hasMore: false });
    m.listCaseTrailMeetings.mockResolvedValue(
      new Map([['case-1', [{ meetingId: 'meet-1' }, { meetingId: 'meet-2' }]]])
    );
    m.findLivePendingByMeetingIds.mockResolvedValue([
      {
        proposalId: 'p-live',
        meetingId: 'meet-1',
        originalScheduledStart: new Date('2026-10-21T10:00:00.000Z'),
        expiresAt: new Date('2026-10-22T17:00:00.000Z'),
        createdAt: new Date('2026-10-20T07:45:00.000Z'),
      },
      {
        proposalId: 'p-expired',
        meetingId: 'meet-2',
        originalScheduledStart: new Date('2026-10-19T10:00:00.000Z'),
        expiresAt: new Date('2026-10-19T17:00:00.000Z'),
        createdAt: new Date('2026-10-18T07:45:00.000Z'),
      },
    ]);
    m.listLiveOptionStartsByProposalIds.mockResolvedValue(
      new Map([['p-live', [new Date('2026-10-22T09:00:00.000Z')]]])
    );
    m.findExpertPartyNames.mockResolvedValue([
      { expertProfileId: 'ep-1', firstName: 'Jordan', lastName: 'Lee', agencyName: 'Summit Labs' },
    ]);
    const cards = await loadClientYourMove(INPUT);
    expect(m.listLiveOptionStartsByProposalIds).toHaveBeenCalledWith(['p-live']);
    expect(cards.map((c) => c.id)).toEqual(['reschedule-p-live']);
    expect(cards[0]).toMatchObject({
      counterparty: 'Jordan Lee, Summit Labs',
      title: 'Flow error triage',
      deadline: '2026-10-22T17:00:00.000Z',
    });
  });

  it('scans reschedules only for the cases listOpenCases returned', async () => {
    m.listOpenCases.mockResolvedValue({ rows: [caseRow], hasMore: false });
    await loadClientYourMove(INPUT);
    expect(m.listCaseTrailMeetings).toHaveBeenCalledWith(['case-1']);
  });

  it('warns when the open-case scan was capped', async () => {
    m.listOpenCases.mockResolvedValue({ rows: [], hasMore: true });
    await loadClientYourMove(INPUT);
    expect(m.warn).toHaveBeenCalledWith(expect.stringContaining('open cases'), expect.anything());
  });
});

describe('team, action items and names', () => {
  it('maps join requesters to names and emails', async () => {
    m.listPendingByParty.mockResolvedValue([
      {
        createdAt: NOW,
        requester: { firstName: 'Riley', lastName: 'Morgan', email: 'riley@northwind.example' },
      },
    ]);
    const [card] = await loadClientYourMove(INPUT);
    expect(card?.context).toEqual({
      type: 'people',
      people: [{ name: 'Riley Morgan', email: 'riley@northwind.example' }],
      more: 0,
    });
    expect(m.listPendingByParty).toHaveBeenCalledWith('company', 'co-1');
  });

  it('names the expert on client action items via one batched name read', async () => {
    m.listOpenAssignedToClient.mockResolvedValue([
      {
        actionItemId: 'ai',
        engagementId: 'eng-1',
        engagementType: 'case',
        engagementTitle: 'Flow error triage',
        expertProfileId: 'ep-2',
        body: 'Export the flows',
        dueAt: null,
        createdAt: NOW,
      },
    ]);
    m.findExpertPartyNames.mockResolvedValue([
      { expertProfileId: 'ep-2', firstName: 'Sam', lastName: 'Rivera', agencyName: null },
    ]);
    const [card] = await loadClientYourMove(INPUT);
    expect(card).toMatchObject({ kind: 'action_items', counterparty: 'Sam Rivera' });
    expect(m.findExpertPartyNames).toHaveBeenCalledTimes(1);
    expect(m.findExpertPartyNames).toHaveBeenCalledWith(['ep-2']);
  });
});

describe('messages', () => {
  it('excludes the threads of needs-you rows and of closed rows from the scan', async () => {
    m.loadClientPortfolio.mockResolvedValue({
      rows: [
        portfolioRow('need-1', { needsYou: true, clientMoveKind: 'eoi_reply' }),
        portfolioRow('quiet'),
        portfolioRow('closed', { threadRefs: [] }),
      ],
      closedRows: [],
    });
    m.listOpenCases.mockResolvedValue({ rows: [caseRow], hasMore: false });
    await loadClientYourMove(INPUT);
    const refs = m.conversationIdsForContexts.mock.calls[0]?.[0] as {
      contextType: string;
      contextId: string;
    }[];
    expect(
      refs.map((r) => `${r.contextType}:${r.contextId}`).sort((a, b) => a.localeCompare(b))
    ).toEqual(['engagement:case-1', 'relationship:rel-quiet']);
  });

  it('attributes an unread thread to the expert, never the sender', async () => {
    m.loadClientPortfolio.mockResolvedValue({ rows: [portfolioRow('quiet')], closedRows: [] });
    m.conversationIdsForContexts.mockResolvedValue(new Map([['relationship:rel-quiet', 'conv-1']]));
    m.listThreadSummaries.mockResolvedValue([
      {
        conversationId: 'conv-1',
        unread: true,
        latestMessage: {
          body: 'Hi',
          createdAt: NOW,
          senderUserId: 'expert-user',
          senderFirstName: 'Alex',
        },
        latestInboundActivityAt: NOW,
      },
    ]);
    m.countUnreadForViewer.mockResolvedValue(
      new Map([['conv-1', { unreadCount: 2, earliestUnreadAt: NOW }]])
    );
    m.findExpertPartyNames.mockResolvedValue([
      {
        expertProfileId: 'ep-1',
        firstName: 'Alex',
        lastName: 'Chen',
        agencyName: 'Cirrus Partners',
      },
    ]);
    const cards = await loadClientYourMove(INPUT);
    const messages = cards.find((c) => c.kind === 'messages');
    expect(messages).toMatchObject({
      title: '2 unread in 1 conversation',
      counterparty: 'Cirrus Partners',
    });
  });
});

describe('detail warnings', () => {
  it('warns once per needs-you request with no detail', async () => {
    m.loadClientPortfolio.mockResolvedValue({
      rows: [portfolioRow('need-1', { needsYou: true, clientMoveKind: 'kickoff_billing' })],
      closedRows: [],
    });
    await loadClientYourMove(INPUT);
    expect(m.warn).toHaveBeenCalledWith(
      'Dashboard your move found no detail for a needs-you request',
      expect.objectContaining({ projectRequestId: 'need-1' })
    );
  });

  it('passes engagement rows to the portfolio only, asking details for requests', async () => {
    m.loadClientPortfolio.mockResolvedValue({
      rows: [
        portfolioRow('eng-1', { kind: 'engagement', needsYou: true, clientMoveKind: 'completion' }),
      ],
      closedRows: [],
    });
    await loadClientYourMove(INPUT);
    expect(m.listClientMoveDetails).toHaveBeenCalledWith({
      companyId: 'co-1',
      projectRequestIds: [],
    });
  });
});
