import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const {
  mockListThreadSummaries,
  mockListMessagesPage,
  mockListFiles,
  mockEnsureManyForContexts,
  mockFindProfileById,
  mockListActiveMeetingsForContexts,
  mockListProposalsByRequest,
  mockFindCurrentProposalByRelationship,
  mockListChangeRequestsByProposal,
  mockFindUserById,
} = vi.hoisted(() => ({
  mockListThreadSummaries: vi.fn(),
  mockListMessagesPage: vi.fn(),
  mockListFiles: vi.fn(),
  mockEnsureManyForContexts: vi.fn(),
  mockFindProfileById: vi.fn(),
  mockListActiveMeetingsForContexts: vi.fn(),
  mockListProposalsByRequest: vi.fn(),
  mockFindCurrentProposalByRelationship: vi.fn(),
  mockListChangeRequestsByProposal: vi.fn(),
  mockFindUserById: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  conversationContextKey: (ref: { contextType: string; contextId: string }) =>
    `${ref.contextType}:${ref.contextId}`,
  conversationsRepository: {
    listThreadSummaries: (...args: unknown[]) => mockListThreadSummaries(...args),
    listMessagesPage: (...args: unknown[]) => mockListMessagesPage(...args),
    listFiles: (...args: unknown[]) => mockListFiles(...args),
    ensureManyForContexts: (...args: unknown[]) => mockEnsureManyForContexts(...args),
  },
  expertsRepository: {
    findProfileById: (...args: unknown[]) => mockFindProfileById(...args),
  },
  // BAL-283 — the batched "is a call booked on this context?" read.
  meetingsRepository: {
    listActiveMeetingsForContexts: (...args: unknown[]) =>
      mockListActiveMeetingsForContexts(...args),
  },
  proposalsRepository: {
    listByRequest: (...args: unknown[]) => mockListProposalsByRequest(...args),
    findCurrentByRelationship: (...args: unknown[]) =>
      mockFindCurrentProposalByRelationship(...args),
  },
  proposalChangeRequestsRepository: {
    listByProposal: (...args: unknown[]) => mockListChangeRequestsByProposal(...args),
  },
  usersRepository: {
    findById: (...args: unknown[]) => mockFindUserById(...args),
  },
}));

const mockIsRealtimeConfigured = vi.fn();
vi.mock('@/lib/realtime/ably-server', () => ({
  isRealtimeConfigured: () => mockIsRealtimeConfigured(),
}));

const mockAttachCards = vi.fn();
vi.mock('@/lib/request-files/thread-file-cards', async () => {
  const { mapMessageRowToView } = await import('@/lib/conversations/conversation-view');
  return {
    attachRequestFileCards: (...args: unknown[]) => {
      mockAttachCards(...args);
      return Promise.resolve(
        (args[2] as Parameters<typeof mapMessageRowToView>[0][]).map(mapMessageRowToView)
      );
    },
  };
});

import { loadConversationView, mapFileRowToView, participantNames } from './conversation-view';
import type { RequestViewerContext } from './resolve-request-lens';

const VIEWER_ID = 'user-client';
const EXPERT_USER_ID = 'user-expert';

function relationship(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'rel-1',
    expertProfileId: 'exp-1',
    status: 'eoi_submitted',
    invitedAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    expertProfile: {
      id: 'exp-1',
      user: { id: EXPERT_USER_ID, firstName: 'Priya', lastName: 'Nair' },
    },
    expressionsOfInterest: [
      {
        id: 'eoi-1',
        submittedAt: new Date('2026-06-02T00:00:00Z'),
        message: '<p>My pitch</p>',
      },
    ],
    conversationMessages: [],
    ...overrides,
  };
}

function request(relationships: Record<string, unknown>[]): Record<string, unknown> {
  return {
    id: 'req-1',
    companyId: 'company-1',
    createdByUserId: VIEWER_ID,
    status: 'eoi_submitted',
    title: 'CPQ implementation',
    createdByUser: { id: VIEWER_ID, firstName: 'Dana', lastName: 'Whitfield', email: 'd@x.com' },
    company: { id: 'company-1', name: 'Northwind' },
    relationships,
  };
}

const CLIENT_CTX: RequestViewerContext = {
  lens: 'client',
  archetype: 'participant',
  isOwner: true,
  isInvitedExpert: false,
  relationshipId: null,
  canSeeContact: false,
  canSeeStaffOnly: false,
  canSeeBaloPanel: false,
};

const EXPERT_CTX: RequestViewerContext = {
  lens: 'expert',
  archetype: 'participant',
  isOwner: false,
  isInvitedExpert: true,
  relationshipId: 'rel-1',
  canSeeContact: true,
  canSeeStaffOnly: false,
  canSeeBaloPanel: false,
};

const USER = { id: VIEWER_ID } as Parameters<typeof loadConversationView>[2];

/** BAL-424: every relationship in these fixtures anchors a conversation named `conv-{relId}`. */
function convIdFor(relationshipId: string): string {
  return `conv-${relationshipId}`;
}

/** The default `ensureManyForContexts` stub: resolve every requested ref via `convIdFor`. */
function stubEnsureMany(): void {
  mockEnsureManyForContexts.mockImplementation(
    (refs: { contextType: string; contextId: string }[]) =>
      Promise.resolve(
        new Map(refs.map((r) => [`${r.contextType}:${r.contextId}`, convIdFor(r.contextId)]))
      )
  );
}

function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversationId: convIdFor('rel-1'),
    latestMessage: null,
    latestInboundActivityAt: null,
    latestOutboundMessageAt: null,
    fileCount: 0,
    lastReadAt: null,
    ...overrides,
  };
}

describe('loadConversationView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRealtimeConfigured.mockReturnValue(true);
    stubEnsureMany();
    mockListThreadSummaries.mockResolvedValue([summary()]);
    mockListMessagesPage.mockResolvedValue({ messages: [], hasEarlier: false });
    mockListFiles.mockResolvedValue([]);
    mockFindProfileById.mockResolvedValue({ id: 'exp-1', username: 'priya-nair' });
    mockListActiveMeetingsForContexts.mockResolvedValue(new Map());
    mockListProposalsByRequest.mockResolvedValue([]);
  });

  it('builds one thread per OPEN relationship and skips invited/declined ones', async () => {
    const req = request([
      relationship(),
      relationship({ id: 'rel-2', status: 'invited' }),
      relationship({ id: 'rel-3', status: 'declined' }),
    ]);
    const view = await loadConversationView(req as never, CLIENT_CTX, USER, null);
    expect(view.threads.map((t) => t.relationshipId)).toEqual(['rel-1']);
    // BAL-424: summaries are batched over CONVERSATION ids; the relationship→conversation
    // mapping is resolved once, up front, with an idempotent ensure.
    expect(mockEnsureManyForContexts).toHaveBeenCalledWith([
      { contextType: 'relationship', contextId: 'rel-1' },
    ]);
    expect(mockListThreadSummaries).toHaveBeenCalledWith({
      conversationIds: [convIdFor('rel-1')],
      viewerUserId: VIEWER_ID,
    });
    expect(view.threads[0]?.conversationId).toBe(convIdFor('rel-1'));
  });

  it('orders threads by invite time (id tiebreak) and never by activity', async () => {
    mockListThreadSummaries.mockResolvedValue([
      summary({ conversationId: convIdFor('rel-old') }),
      summary({
        conversationId: convIdFor('rel-new'),
        latestMessage: {
          id: 'm-9',
          body: '<p>hot thread</p>',
          createdAt: new Date('2026-06-09T00:00:00Z'),
          requestSharedFileId: null,
          senderUserId: EXPERT_USER_ID,
        },
      }),
    ]);
    const req = request([
      relationship({ id: 'rel-new', invitedAt: new Date('2026-06-05T00:00:00Z') }),
      relationship({ id: 'rel-old', invitedAt: new Date('2026-06-01T00:00:00Z') }),
    ]);
    const view = await loadConversationView(req as never, CLIENT_CTX, USER, null);
    expect(view.threads.map((t) => t.relationshipId)).toEqual(['rel-old', 'rel-new']);
    // …but selection DOES react to activity.
    expect(view.defaultThreadId).toBe('rel-new');
  });

  it('expert lens sees ONLY their own thread and never EOI html', async () => {
    const req = request([relationship(), relationship({ id: 'rel-2' })]);
    const view = await loadConversationView(
      req as never,
      EXPERT_CTX,
      {
        id: EXPERT_USER_ID,
      } as never,
      null
    );
    expect(view.threads.map((t) => t.relationshipId)).toEqual(['rel-1']);
    const [thread] = view.threads;
    expect(thread?.eoiHtml).toBeNull();
    expect(thread?.eoiSubmittedAtIso).toBeNull();
    // No username hydration for the expert lens.
    expect(mockFindProfileById).not.toHaveBeenCalled();
  });

  it('client lens carries the EOI html + the hydrated expert username', async () => {
    const view = await loadConversationView(
      request([relationship()]) as never,
      CLIENT_CTX,
      USER,
      null
    );
    const [thread] = view.threads;
    expect(thread?.eoiHtml).toBe('<p>My pitch</p>');
    expect(thread?.eoiSubmittedAtIso).toBe('2026-06-02T00:00:00.000Z');
    expect(thread?.expertUsername).toBe('priya-nair');
  });

  // ── BAL-283 — availabilitySharedAtIso + upcomingCalls ──────────────────────────────────────

  it('maps availabilitySharedAt to an ISO string, and null when never shared', async () => {
    const sharedView = await loadConversationView(
      request([relationship({ availabilitySharedAt: new Date('2026-08-20T00:00:00Z') })]) as never,
      CLIENT_CTX,
      USER,
      null
    );
    expect(sharedView.threads[0]?.availabilitySharedAtIso).toBe('2026-08-20T00:00:00.000Z');

    const neverSharedView = await loadConversationView(
      request([relationship()]) as never,
      CLIENT_CTX,
      USER,
      null
    );
    expect(neverSharedView.threads[0]?.availabilitySharedAtIso).toBeNull();
  });

  it('changeRequest is set only for a thread whose CURRENT proposal is changes_requested', async () => {
    mockListProposalsByRequest.mockResolvedValue([
      // A superseded version — not current, so ignored even though it is changes_requested.
      {
        id: 'p-old',
        relationshipId: 'rel-1',
        isCurrent: false,
        status: 'changes_requested',
        version: 1,
      },
      {
        id: 'p-1',
        relationshipId: 'rel-1',
        isCurrent: true,
        status: 'changes_requested',
        version: 1,
      },
      { id: 'p-2', relationshipId: 'rel-2', isCurrent: true, status: 'submitted', version: 1 },
    ]);
    mockListChangeRequestsByProposal.mockResolvedValue([
      { note: 'Add more\n\n  deliverables', requestedByUserId: VIEWER_ID },
      { note: 'An older note', requestedByUserId: VIEWER_ID },
    ]);
    mockFindUserById.mockResolvedValue({ id: VIEWER_ID, firstName: 'Dana' });

    const view = await loadConversationView(
      request([
        relationship({ status: 'proposal_submitted' }),
        relationship({ id: 'rel-2', expertProfileId: 'exp-2', status: 'proposal_submitted' }),
      ]) as never,
      CLIENT_CTX,
      USER,
      null
    );

    expect(mockListProposalsByRequest).toHaveBeenCalledWith('req-1');
    expect(mockListChangeRequestsByProposal).toHaveBeenCalledTimes(1);
    expect(mockListChangeRequestsByProposal).toHaveBeenCalledWith('p-1');
    expect(view.threads.find((t) => t.relationshipId === 'rel-1')?.changeRequest).toEqual({
      requestedBy: 'Dana @ Northwind',
      notePreview: 'Add more deliverables',
      nextVersion: 2,
    });
    expect(view.threads.find((t) => t.relationshipId === 'rel-2')?.changeRequest).toBeNull();
  });

  it('expert lens reads only its own current proposal; requester falls back to the party', async () => {
    mockFindCurrentProposalByRelationship.mockResolvedValue({
      id: 'p-1',
      relationshipId: 'rel-1',
      isCurrent: true,
      status: 'changes_requested',
      version: 2,
    });
    mockListChangeRequestsByProposal.mockResolvedValue([
      { note: 'Tighten the timeline', requestedByUserId: 'gone' },
    ]);
    mockFindUserById.mockResolvedValue(undefined);

    const view = await loadConversationView(
      request([relationship({ status: 'proposal_submitted' })]) as never,
      EXPERT_CTX,
      USER,
      null
    );
    expect(mockFindCurrentProposalByRelationship).toHaveBeenCalledWith('rel-1');
    expect(mockListProposalsByRequest).not.toHaveBeenCalled();
    expect(view.threads[0]?.changeRequest).toEqual({
      requestedBy: 'Northwind',
      notePreview: 'Tighten the timeline',
      nextVersion: 3,
    });
  });

  it('a change-request read failure degrades to no change request, never a broken page', async () => {
    mockListProposalsByRequest.mockResolvedValue([
      {
        id: 'p-1',
        relationshipId: 'rel-1',
        isCurrent: true,
        status: 'changes_requested',
        version: 1,
      },
    ]);
    mockListChangeRequestsByProposal.mockRejectedValue(new Error('db down'));

    const view = await loadConversationView(
      request([relationship({ status: 'proposal_submitted' })]) as never,
      CLIENT_CTX,
      USER,
      null
    );
    expect(view.threads).toHaveLength(1);
    expect(view.threads[0]?.changeRequest).toBeNull();
  });

  it('runs ONE batched booked-call query for the whole page, never one per relationship', async () => {
    const req = request([relationship(), relationship({ id: 'rel-2' })]);
    mockListThreadSummaries.mockResolvedValue([
      summary(),
      summary({ conversationId: convIdFor('rel-2') }),
    ]);
    await loadConversationView(req as never, CLIENT_CTX, USER, null);

    expect(mockListActiveMeetingsForContexts).toHaveBeenCalledTimes(1);
    expect(mockListActiveMeetingsForContexts).toHaveBeenCalledWith({
      contextType: 'request_interaction',
      contextIds: ['rel-1', 'rel-2'],
    });
  });

  // ⚠ EVERY `status` below is a real member of `meetingStatusEnum`
  // (`scheduled | waiting_for_participants | in_progress | ended | cancelled`). The original
  // fixture used `'confirmed'` — a CONSULTATION status, not a meeting one — which was the tell
  // that `status` had never been considered by the pick at all.
  function meetingRow(
    overrides: Partial<{
      meetingId: string;
      scheduledStart: Date;
      scheduledEnd: Date;
      status: 'scheduled' | 'waiting_for_participants' | 'in_progress' | 'ended' | 'cancelled';
    }> = {}
  ) {
    return {
      meetingId: 'meeting-1',
      scheduledStart: new Date('2999-09-01T04:00:00Z'),
      scheduledEnd: new Date('2999-09-01T04:30:00Z'),
      status: 'scheduled' as const,
      ...overrides,
    };
  }

  it('upcomingCalls is empty when no live meeting exists, and carries the upcoming ones when they do', async () => {
    mockListActiveMeetingsForContexts.mockResolvedValue(new Map([['rel-1', [meetingRow()]]]));
    const view = await loadConversationView(
      request([relationship()]) as never,
      CLIENT_CTX,
      USER,
      null
    );
    expect(view.threads[0]?.upcomingCalls).toEqual([
      {
        meetingId: 'meeting-1',
        scheduledStartIso: '2999-09-01T04:00:00.000Z',
        contextType: 'request_interaction',
      },
    ]);

    mockListActiveMeetingsForContexts.mockResolvedValue(new Map([['rel-1', []]]));
    const emptyView = await loadConversationView(
      request([relationship()]) as never,
      CLIENT_CTX,
      USER,
      null
    );
    expect(emptyView.threads[0]?.upcomingCalls).toEqual([]);
  });

  it('an ENDED call is absent from upcomingCalls — the CTA comes back (C2)', async () => {
    mockListActiveMeetingsForContexts.mockResolvedValue(
      new Map([['rel-1', [meetingRow({ status: 'ended' })]]])
    );
    const view = await loadConversationView(
      request([relationship()]) as never,
      CLIENT_CTX,
      USER,
      null
    );
    expect(view.threads[0]?.upcomingCalls).toEqual([]);
  });

  it('a meeting whose window has already passed is absent, even at status scheduled', async () => {
    mockListActiveMeetingsForContexts.mockResolvedValue(
      new Map([
        [
          'rel-1',
          [
            meetingRow({
              scheduledStart: new Date('2020-01-01T04:00:00Z'),
              scheduledEnd: new Date('2020-01-01T04:30:00Z'),
            }),
          ],
        ],
      ])
    );
    const view = await loadConversationView(
      request([relationship()]) as never,
      CLIENT_CTX,
      USER,
      null
    );
    expect(view.threads[0]?.upcomingCalls).toEqual([]);
  });

  it('with a past call AND an upcoming one, only the UPCOMING one is listed', async () => {
    mockListActiveMeetingsForContexts.mockResolvedValue(
      new Map([
        [
          'rel-1',
          [
            meetingRow({
              meetingId: 'meeting-past',
              scheduledStart: new Date('2020-01-01T04:00:00Z'),
              scheduledEnd: new Date('2020-01-01T04:30:00Z'),
              status: 'ended',
            }),
            meetingRow({ meetingId: 'meeting-next' }),
          ],
        ],
      ])
    );
    const view = await loadConversationView(
      request([relationship()]) as never,
      CLIENT_CTX,
      USER,
      null
    );
    expect(view.threads[0]?.upcomingCalls).toEqual([
      {
        meetingId: 'meeting-next',
        scheduledStartIso: '2999-09-01T04:00:00.000Z',
        contextType: 'request_interaction',
      },
    ]);
  });

  it('lists several upcoming calls soonest first', async () => {
    mockListActiveMeetingsForContexts.mockResolvedValue(
      new Map([
        [
          'rel-1',
          [
            meetingRow({
              meetingId: 'meeting-late',
              scheduledStart: new Date('2999-09-03T04:00:00Z'),
              scheduledEnd: new Date('2999-09-03T04:30:00Z'),
            }),
            meetingRow({ meetingId: 'meeting-early' }),
          ],
        ],
      ])
    );
    const view = await loadConversationView(
      request([relationship()]) as never,
      CLIENT_CTX,
      USER,
      null
    );
    expect(view.threads[0]?.upcomingCalls.map((c) => c.meetingId)).toEqual([
      'meeting-early',
      'meeting-late',
    ]);
  });

  describe('a won thread on a kickoff_approved request (project_call context)', () => {
    const ENGAGEMENT_ID = 'eng-1';

    function readByContext(byType: Record<string, Map<string, unknown[]>>): void {
      mockListActiveMeetingsForContexts.mockImplementation(
        async ({ contextType }: { contextType: string }) => byType[contextType] ?? new Map()
      );
    }

    it('reads both contexts for the won thread and merges them, a carried-over call counting once', async () => {
      readByContext({
        request_interaction: new Map([['rel-1', [meetingRow({ meetingId: 'carried' })]]]),
        project_call: new Map([
          [
            ENGAGEMENT_ID,
            [
              meetingRow({ meetingId: 'carried' }),
              meetingRow({
                meetingId: 'project-only',
                scheduledStart: new Date('2999-09-05T04:00:00Z'),
                scheduledEnd: new Date('2999-09-05T04:30:00Z'),
              }),
            ],
          ],
        ]),
      });
      const view = await loadConversationView(
        request([relationship({ status: 'accepted' })]) as never,
        CLIENT_CTX,
        USER,
        ENGAGEMENT_ID
      );
      expect(mockListActiveMeetingsForContexts).toHaveBeenCalledWith({
        contextType: 'project_call',
        contextIds: [ENGAGEMENT_ID],
      });
      expect(view.threads[0]?.upcomingCalls).toEqual([
        {
          meetingId: 'carried',
          scheduledStartIso: '2999-09-01T04:00:00.000Z',
          contextType: 'project_call',
        },
        {
          meetingId: 'project-only',
          scheduledStartIso: '2999-09-05T04:00:00.000Z',
          contextType: 'project_call',
        },
      ]);
    });

    it('other threads read request_interaction only', async () => {
      readByContext({
        request_interaction: new Map([
          ['rel-1', [meetingRow({ meetingId: 'won-call' })]],
          ['rel-2', [meetingRow({ meetingId: 'other-call' })]],
        ]),
        project_call: new Map([[ENGAGEMENT_ID, [meetingRow({ meetingId: 'project-only' })]]]),
      });
      mockListThreadSummaries.mockResolvedValue([
        summary(),
        summary({ conversationId: convIdFor('rel-2') }),
      ]);
      const view = await loadConversationView(
        request([
          relationship({ status: 'accepted' }),
          relationship({ id: 'rel-2', status: 'eoi_submitted' }),
        ]) as never,
        CLIENT_CTX,
        USER,
        ENGAGEMENT_ID
      );
      const wonCalls = view.threads.find((t) => t.relationshipId === 'rel-1')?.upcomingCalls;
      const otherCalls = view.threads.find((t) => t.relationshipId === 'rel-2')?.upcomingCalls;
      expect(wonCalls?.map((c) => c.meetingId).sort()).toEqual(['project-only', 'won-call']);
      expect(otherCalls?.map((c) => c.meetingId)).toEqual(['other-call']);
    });

    it('reads no project_call context when the request has no engagement', async () => {
      mockListActiveMeetingsForContexts.mockResolvedValue(new Map());
      await loadConversationView(
        request([relationship({ status: 'accepted' })]) as never,
        CLIENT_CTX,
        USER,
        null
      );
      expect(mockListActiveMeetingsForContexts).toHaveBeenCalledTimes(1);
    });

    it('an ended project call is absent', async () => {
      readByContext({
        project_call: new Map([[ENGAGEMENT_ID, [meetingRow({ status: 'ended' })]]]),
      });
      const view = await loadConversationView(
        request([relationship({ status: 'accepted' })]) as never,
        CLIENT_CTX,
        USER,
        ENGAGEMENT_ID
      );
      expect(view.threads[0]?.upcomingCalls).toEqual([]);
    });
  });

  it('falls back to a null username when profile hydration fails', async () => {
    mockFindProfileById.mockRejectedValue(new Error('db down'));
    const view = await loadConversationView(
      request([relationship()]) as never,
      CLIENT_CTX,
      USER,
      null
    );
    expect(view.threads[0]?.expertUsername).toBeNull();
  });

  it('derives unread from inbound activity vs the watermark', async () => {
    mockListThreadSummaries.mockResolvedValue([
      summary({
        latestInboundActivityAt: new Date('2026-06-09T10:00:00Z'),
        lastReadAt: new Date('2026-06-09T09:00:00Z'),
      }),
    ]);
    const view = await loadConversationView(
      request([relationship()]) as never,
      CLIENT_CTX,
      USER,
      null
    );
    expect(view.threads[0]?.unread).toBe(true);
  });

  it('own activity never makes a thread unread (no inbound)', async () => {
    mockListThreadSummaries.mockResolvedValue([
      summary({
        latestMessage: {
          id: 'm-1',
          body: '<p>mine</p>',
          createdAt: new Date('2026-06-09T10:00:00Z'),
          requestSharedFileId: null,
          senderUserId: VIEWER_ID,
        },
        latestInboundActivityAt: null,
      }),
    ]);
    const view = await loadConversationView(
      request([relationship()]) as never,
      CLIENT_CTX,
      USER,
      null
    );
    expect(view.threads[0]?.unread).toBe(false);
    expect(view.threads[0]?.latestMessageFromViewer).toBe(true);
  });

  it('viewerHasSentMessage follows the viewer’s newest own message, whoever wrote last', async () => {
    mockListThreadSummaries.mockResolvedValue([summary()]);
    const quiet = await loadConversationView(
      request([relationship()]) as never,
      CLIENT_CTX,
      USER,
      null
    );
    expect(quiet.threads[0]?.viewerHasSentMessage).toBe(false);

    mockListThreadSummaries.mockResolvedValue([
      summary({
        latestMessage: {
          id: 'm-2',
          body: '<p>theirs</p>',
          createdAt: new Date('2026-06-09T11:00:00Z'),
          requestSharedFileId: null,
          senderUserId: 'someone-else',
        },
        latestOutboundMessageAt: new Date('2026-06-09T10:00:00Z'),
      }),
    ]);
    const wrote = await loadConversationView(
      request([relationship()]) as never,
      CLIENT_CTX,
      USER,
      null
    );
    expect(wrote.threads[0]?.latestMessageFromViewer).toBe(false);
    expect(wrote.threads[0]?.viewerHasSentMessage).toBe(true);
  });

  it('truncates the preview to 140 plain-text chars', async () => {
    const long = 'a'.repeat(300);
    mockListThreadSummaries.mockResolvedValue([
      summary({
        latestMessage: {
          id: 'm-1',
          body: `<p>${long}</p>`,
          createdAt: new Date('2026-06-09T10:00:00Z'),
          requestSharedFileId: null,
          senderUserId: EXPERT_USER_ID,
        },
      }),
    ]);
    const view = await loadConversationView(
      request([relationship()]) as never,
      CLIENT_CTX,
      USER,
      null
    );
    const preview = view.threads[0]?.latestMessagePreview ?? '';
    expect(preview.length).toBeLessThanOrEqual(140);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('previews a note-less request-share card as "Shared a file", never blank', async () => {
    mockListThreadSummaries.mockResolvedValue([
      summary({
        latestMessage: {
          id: 'm-1',
          body: '',
          createdAt: new Date('2026-06-09T10:00:00Z'),
          senderUserId: EXPERT_USER_ID,
          requestSharedFileId: 'file-1',
        },
      }),
    ]);
    const view = await loadConversationView(
      request([relationship()]) as never,
      CLIENT_CTX,
      USER,
      null
    );
    expect(view.threads[0]?.latestMessagePreview).toBe('Shared a file');
  });

  it('previews a share card that carries a note as the fallback, never the note', async () => {
    mockListThreadSummaries.mockResolvedValue([
      summary({
        latestMessage: {
          id: 'm-1',
          body: '<p>Here is the spec</p>',
          createdAt: new Date('2026-06-09T10:00:00Z'),
          senderUserId: EXPERT_USER_ID,
          requestSharedFileId: 'file-1',
        },
      }),
    ]);
    const view = await loadConversationView(
      request([relationship()]) as never,
      CLIENT_CTX,
      USER,
      null
    );
    expect(view.threads[0]?.latestMessagePreview).toBe('Shared a file');
  });

  it('loads the first page + files (newest first) for the default thread only', async () => {
    mockListMessagesPage.mockResolvedValue({
      messages: [
        {
          id: 'm-1',
          conversationId: convIdFor('rel-1'),
          body: '<p>hello</p>',
          senderUserId: EXPERT_USER_ID,
          createdAt: new Date('2026-06-08T00:00:00Z'),
          updatedAt: new Date('2026-06-08T00:00:00Z'),
          deletedAt: null,
          senderFirstName: 'Priya',
          senderLastName: 'Nair',
        },
      ],
      hasEarlier: true,
    });
    mockListFiles.mockResolvedValue([
      {
        id: 'f-old',
        conversationId: convIdFor('rel-1'),
        uploadedByUserId: VIEWER_ID,
        r2Key: 'k1',
        fileName: 'old.pdf',
        contentType: 'application/pdf',
        sizeBytes: 100,
        createdAt: new Date('2026-06-07T00:00:00Z'),
        updatedAt: new Date('2026-06-07T00:00:00Z'),
        deletedAt: null,
      },
      {
        id: 'f-new',
        conversationId: convIdFor('rel-1'),
        uploadedByUserId: EXPERT_USER_ID,
        r2Key: 'k2',
        fileName: 'new.pdf',
        contentType: 'application/pdf',
        sizeBytes: 200,
        createdAt: new Date('2026-06-08T00:00:00Z'),
        updatedAt: new Date('2026-06-08T00:00:00Z'),
        deletedAt: null,
      },
    ]);

    const view = await loadConversationView(
      request([relationship()]) as never,
      CLIENT_CTX,
      USER,
      null
    );
    expect(view.initialMessages).toEqual([
      expect.objectContaining({ id: 'm-1', bodyHtml: '<p>hello</p>', senderName: 'Priya Nair' }),
    ]);
    expect(view.initialHasEarlier).toBe(true);
    // ⚠ BAL-424: both reads key on the CONVERSATION and STATE `{ kind: 'full' }`. A
    // repository default would put the meeting-level guest filter one forgotten argument
    // away from handing a guest the whole thread.
    expect(mockListMessagesPage).toHaveBeenCalledWith({
      conversationId: convIdFor('rel-1'),
      scope: { kind: 'full' },
      limit: 30,
      // The request surface is one of the TWO readers that opt in to share cards.
      includeRequestFileShares: true,
    });
    expect(mockAttachCards).toHaveBeenCalledWith(USER, 'req-1', expect.any(Array));
    expect(mockListFiles).toHaveBeenCalledWith(convIdFor('rel-1'), { kind: 'full' });
    expect(view.initialFiles.map((f) => f.id)).toEqual(['f-new', 'f-old']);
    expect(view.initialFiles[0]?.uploadedByName).toBe('Priya Nair');
    expect(view.initialFiles[1]?.uploadedByName).toBe('Dana Whitfield');
  });

  it('returns an empty view shape with zero open threads', async () => {
    mockListThreadSummaries.mockResolvedValue([]);
    const view = await loadConversationView(
      request([relationship({ status: 'invited' })]) as never,
      CLIENT_CTX,
      USER,
      null
    );
    expect(view.threads).toEqual([]);
    expect(view.defaultThreadId).toBeNull();
    expect(view.initialMessages).toEqual([]);
    expect(mockListMessagesPage).not.toHaveBeenCalled();
  });

  it('reflects realtime availability', async () => {
    mockIsRealtimeConfigured.mockReturnValue(false);
    const view = await loadConversationView(
      request([relationship()]) as never,
      CLIENT_CTX,
      USER,
      null
    );
    expect(view.realtimeEnabled).toBe(false);
  });

  describe('closed request (BAL-616)', () => {
    const OPENED_AT = new Date('2026-06-02T00:00:00Z');
    const closedRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
      relationship({
        status: 'declined',
        declineReason: 'request_closed',
        openedAt: OPENED_AT,
        ...overrides,
      });

    it('lists the threads that were open at the close, and excludes pre-close declines', async () => {
      const req = {
        ...request([
          closedRecord(),
          closedRecord({ id: 'rel-2', declineReason: 'client_declined' }),
          closedRecord({ id: 'rel-3', openedAt: null }),
          relationship({ id: 'rel-4', status: 'invited' }),
        ]),
        status: 'closed',
      };
      const view = await loadConversationView(req as never, CLIENT_CTX, USER, null);
      expect(view.threads.map((t) => t.relationshipId)).toEqual(['rel-1']);
    });

    it('reports realtime off even when it is configured, so no refused token is requested', async () => {
      mockIsRealtimeConfigured.mockReturnValue(true);
      const req = { ...request([closedRecord()]), status: 'closed' };
      const view = await loadConversationView(req as never, CLIENT_CTX, USER, null);
      expect(view.realtimeEnabled).toBe(false);
    });
  });
});

describe('mapFileRowToView / participantNames', () => {
  it('attributes uploads to the matching participant, with a neutral fallback', () => {
    const req = request([relationship()]);
    const names = participantNames(
      req as never,
      (req.relationships as Record<string, unknown>[])[0] as never
    );
    expect(names.clientName).toBe('Dana Whitfield');
    expect(names.expertName).toBe('Priya Nair');

    const row = {
      id: 'f-1',
      relationshipId: 'rel-1',
      uploadedByUserId: 'someone-else',
      r2Key: 'k',
      fileName: 'x.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1,
      createdAt: new Date('2026-06-08T00:00:00Z'),
      updatedAt: new Date('2026-06-08T00:00:00Z'),
      deletedAt: null,
    };
    expect(mapFileRowToView(row as never, names).uploadedByName).toBe('Participant');
  });
});
