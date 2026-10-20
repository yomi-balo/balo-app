import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const m = vi.hoisted(() => ({
  loadExpertPortfolio: vi.fn(),
  listOpenAssignedToExpert: vi.fn(),
  listOpenCases: vi.fn(),
  listExpertMoveDetails: vi.fn(),
  conversationIdsForContexts: vi.fn(),
  ensureManyForContexts: vi.fn(),
  listThreadSummaries: vi.fn(),
  countUnreadForViewer: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({ log: { error: vi.fn(), info: vi.fn(), warn: m.warn } }));
vi.mock('@balo/db', () => ({
  MAX_CASES_INDEX_PAGE_SIZE: 50,
  conversationContextKey: (ref: { contextType: string; contextId: string }) =>
    `${ref.contextType}:${ref.contextId}`,
  actionItemsRepository: { listOpenAssignedToExpert: m.listOpenAssignedToExpert },
  casesIndexRepository: { listOpenCases: m.listOpenCases },
  projectsInboxRepository: { listExpertMoveDetails: m.listExpertMoveDetails },
  conversationsRepository: {
    conversationIdsForContexts: m.conversationIdsForContexts,
    ensureManyForContexts: m.ensureManyForContexts,
    listThreadSummaries: m.listThreadSummaries,
    countUnreadForViewer: m.countUnreadForViewer,
  },
}));
vi.mock('@/lib/projects-inbox/portfolio-view', () => ({
  loadExpertPortfolio: m.loadExpertPortfolio,
  summaryIsUnread: (s: { unread: boolean }) => s.unread,
}));

import { collectThreadRefs, loadExpertYourMove } from './load-your-move';
import type { PortfolioRowView } from '@/lib/projects-inbox/portfolio-row';
import type { SessionUser } from '@/lib/auth/session';

const NOW = new Date('2026-10-20T10:00:00.000Z');
const USER = { id: 'user-1', expertProfileId: 'ep-1' } as SessionUser & { expertProfileId: string };

function portfolioRow(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const isEngagement = over.kind === 'engagement';
  return {
    threadRefs: isEngagement
      ? [{ contextType: 'engagement', contextId: id, expertProfileId: null }]
      : [{ contextType: 'relationship', contextId: `rel-${id}`, expertProfileId: null }],
    id,
    href: `/projects/${id}`,
    title: id,
    companyName: 'Northwind',
    needsYou: false,
    moveKind: null,
    kind: 'request',
    relationshipId: `rel-${id}`,
    updatedRelative: 'today',
    recencyAtIso: NOW.toISOString(),
    signal: null,
    delivery: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.listOpenAssignedToExpert.mockResolvedValue([]);
  m.listOpenCases.mockResolvedValue({ rows: [], hasMore: false });
  m.listExpertMoveDetails.mockResolvedValue(new Map());
  m.conversationIdsForContexts.mockResolvedValue(new Map());
  m.listThreadSummaries.mockResolvedValue([]);
  m.countUnreadForViewer.mockResolvedValue(new Map());
});

describe('loadExpertYourMove', () => {
  it('loads the portfolio once, uses rows only, and asks for details of needs-you requests only', async () => {
    const rows = [
      portfolioRow('need-1', { needsYou: true, moveKind: 'invitation' }),
      portfolioRow('quiet'),
      portfolioRow('eng-1', { needsYou: true, moveKind: 'delivery_changes', kind: 'engagement' }),
    ];
    m.loadExpertPortfolio.mockResolvedValue({
      rows,
      closedRows: [portfolioRow('closed', { needsYou: true, moveKind: 'invitation' })],
    });
    const { cards, rows: returnedRows } = await loadExpertYourMove({
      user: USER,
      calendarNeedsReconnect: false,
      now: NOW,
    });

    expect(m.loadExpertPortfolio).toHaveBeenCalledTimes(1);
    expect(returnedRows).toBe(rows);
    expect(m.listExpertMoveDetails).toHaveBeenCalledWith({
      expertProfileId: 'ep-1',
      projectRequestIds: ['need-1'],
    });
    expect(cards.map((c) => c.id).sort((a, b) => a.localeCompare(b))).toEqual(['eng-1', 'need-1']);
  });

  it('warns once per needs-you request with no detail', async () => {
    m.loadExpertPortfolio.mockResolvedValue({
      rows: [portfolioRow('need-1', { needsYou: true, moveKind: 'invitation' })],
      closedRows: [],
    });
    await loadExpertYourMove({ user: USER, calendarNeedsReconnect: false, now: NOW });
    expect(m.warn).toHaveBeenCalledWith(
      'Dashboard your move found no detail for a needs-you request',
      expect.objectContaining({ projectRequestId: 'need-1' })
    );
  });

  it('never provisions conversations and excludes needs-you contexts from the messages scan', async () => {
    m.loadExpertPortfolio.mockResolvedValue({
      rows: [
        portfolioRow('need-1', { needsYou: true, moveKind: 'invitation' }),
        portfolioRow('quiet'),
        portfolioRow('eng-q', { kind: 'engagement' }),
        portfolioRow('eng-n', {
          kind: 'engagement',
          needsYou: true,
          moveKind: 'delivery_changes',
        }),
      ],
      closedRows: [],
    });
    m.listOpenCases.mockResolvedValue({
      rows: [{ engagementId: 'case-1', companyName: 'Orbit' }],
      hasMore: false,
    });
    await loadExpertYourMove({ user: USER, calendarNeedsReconnect: false, now: NOW });

    expect(m.ensureManyForContexts).not.toHaveBeenCalled();
    const refs = m.conversationIdsForContexts.mock.calls[0]?.[0] as {
      contextType: string;
      contextId: string;
    }[];
    expect(
      refs.map((r) => `${r.contextType}:${r.contextId}`).sort((a, b) => a.localeCompare(b))
    ).toEqual(['engagement:case-1', 'engagement:eng-q', 'relationship:rel-quiet']);
  });

  it('builds a Messages card from unread threads, attributed to the company', async () => {
    m.loadExpertPortfolio.mockResolvedValue({ rows: [portfolioRow('quiet')], closedRows: [] });
    m.conversationIdsForContexts.mockResolvedValue(new Map([['relationship:rel-quiet', 'conv-1']]));
    m.listThreadSummaries.mockResolvedValue([
      {
        conversationId: 'conv-1',
        unread: true,
        latestMessage: {
          body: 'Hi',
          createdAt: NOW,
          senderUserId: 'client-1',
          senderFirstName: 'Dana',
        },
        latestInboundActivityAt: NOW,
      },
    ]);
    m.countUnreadForViewer.mockResolvedValue(
      new Map([['conv-1', { unreadCount: 2, earliestUnreadAt: NOW }]])
    );
    const { cards } = await loadExpertYourMove({
      user: USER,
      calendarNeedsReconnect: false,
      now: NOW,
    });
    const messages = cards.find((c) => c.kind === 'messages');
    expect(messages?.title).toBe('2 unread in 1 conversation');
    expect(JSON.stringify(cards)).not.toContain('Dana');
  });

  it('warns when the open-case scan was capped', async () => {
    m.loadExpertPortfolio.mockResolvedValue({ rows: [], closedRows: [] });
    m.listOpenCases.mockResolvedValue({ rows: [], hasMore: true });
    await loadExpertYourMove({ user: USER, calendarNeedsReconnect: false, now: NOW });
    expect(m.warn).toHaveBeenCalledWith(expect.stringContaining('open cases'), expect.anything());
  });

  it('adds the calendar blocker when the calendar needs reconnecting', async () => {
    m.loadExpertPortfolio.mockResolvedValue({ rows: [], closedRows: [] });
    const { cards } = await loadExpertYourMove({
      user: USER,
      calendarNeedsReconnect: true,
      now: NOW,
    });
    expect(cards.map((c) => c.kind)).toEqual(['calendar_reconnect']);
  });
});

describe('collectThreadRefs', () => {
  const asRows = (rows: Record<string, unknown>[]): PortfolioRowView[] =>
    rows as unknown as PortfolioRowView[];

  it('skips needs-you rows on both sides and rows with no open thread', () => {
    const rows = asRows([
      portfolioRow('expert-card', { needsYou: true, moveKind: 'invitation' }),
      portfolioRow('client-card', { needsYou: true, clientMoveKind: 'eoi_reply' }),
      portfolioRow('closed', { threadRefs: [] }),
      portfolioRow('quiet'),
    ]);
    const refs = collectThreadRefs(rows, [], 'company');
    expect(refs.map((r) => r.ref.contextId)).toEqual(['rel-quiet']);
    expect(refs[0]?.party).toEqual({ kind: 'company', name: 'Northwind' });
  });

  it('names the delivering expert as the party on the company rail', () => {
    const rows = asRows([
      portfolioRow('quiet', {
        threadRefs: [{ contextType: 'engagement', contextId: 'e1', expertProfileId: 'ep-9' }],
      }),
    ]);
    expect(collectThreadRefs(rows, [], 'expert')[0]?.party).toEqual({
      kind: 'expert',
      expertProfileId: 'ep-9',
    });
  });
});
