import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const {
  mockListThreadSummaries,
  mockListMessagesPage,
  mockListFiles,
  mockEnsureManyForContexts,
  mockFindProfileById,
  mockListActiveMeetingsForContexts,
} = vi.hoisted(() => ({
  mockListThreadSummaries: vi.fn(),
  mockListMessagesPage: vi.fn(),
  mockListFiles: vi.fn(),
  mockEnsureManyForContexts: vi.fn(),
  mockFindProfileById: vi.fn(),
  mockListActiveMeetingsForContexts: vi.fn(),
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
}));

const mockIsRealtimeConfigured = vi.fn();
vi.mock('@/lib/realtime/ably-server', () => ({
  isRealtimeConfigured: () => mockIsRealtimeConfigured(),
}));

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
};

const EXPERT_CTX: RequestViewerContext = {
  lens: 'expert',
  archetype: 'participant',
  isOwner: false,
  isInvitedExpert: true,
  relationshipId: 'rel-1',
  canSeeContact: true,
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
  });

  it('builds one thread per OPEN relationship and skips invited/declined ones', async () => {
    const req = request([
      relationship(),
      relationship({ id: 'rel-2', status: 'invited' }),
      relationship({ id: 'rel-3', status: 'declined' }),
    ]);
    const view = await loadConversationView(req as never, CLIENT_CTX, USER);
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
          senderUserId: EXPERT_USER_ID,
        },
      }),
    ]);
    const req = request([
      relationship({ id: 'rel-new', invitedAt: new Date('2026-06-05T00:00:00Z') }),
      relationship({ id: 'rel-old', invitedAt: new Date('2026-06-01T00:00:00Z') }),
    ]);
    const view = await loadConversationView(req as never, CLIENT_CTX, USER);
    expect(view.threads.map((t) => t.relationshipId)).toEqual(['rel-old', 'rel-new']);
    // …but selection DOES react to activity.
    expect(view.defaultThreadId).toBe('rel-new');
  });

  it('expert lens sees ONLY their own thread and never EOI html', async () => {
    const req = request([relationship(), relationship({ id: 'rel-2' })]);
    const view = await loadConversationView(req as never, EXPERT_CTX, {
      id: EXPERT_USER_ID,
    } as never);
    expect(view.threads.map((t) => t.relationshipId)).toEqual(['rel-1']);
    const [thread] = view.threads;
    expect(thread?.eoiHtml).toBeNull();
    expect(thread?.eoiSubmittedAtIso).toBeNull();
    // No username hydration for the expert lens.
    expect(mockFindProfileById).not.toHaveBeenCalled();
  });

  it('client lens carries the EOI html + the hydrated expert username', async () => {
    const view = await loadConversationView(request([relationship()]) as never, CLIENT_CTX, USER);
    const [thread] = view.threads;
    expect(thread?.eoiHtml).toBe('<p>My pitch</p>');
    expect(thread?.eoiSubmittedAtIso).toBe('2026-06-02T00:00:00.000Z');
    expect(thread?.expertUsername).toBe('priya-nair');
  });

  // ── BAL-283 — availabilitySharedAtIso + bookedCall ──────────────────────────────────────

  it('maps availabilitySharedAt to an ISO string, and null when never shared', async () => {
    const sharedView = await loadConversationView(
      request([relationship({ availabilitySharedAt: new Date('2026-08-20T00:00:00Z') })]) as never,
      CLIENT_CTX,
      USER
    );
    expect(sharedView.threads[0]?.availabilitySharedAtIso).toBe('2026-08-20T00:00:00.000Z');

    const neverSharedView = await loadConversationView(
      request([relationship()]) as never,
      CLIENT_CTX,
      USER
    );
    expect(neverSharedView.threads[0]?.availabilitySharedAtIso).toBeNull();
  });

  it('runs ONE batched booked-call query for the whole page, never one per relationship', async () => {
    const req = request([relationship(), relationship({ id: 'rel-2' })]);
    mockListThreadSummaries.mockResolvedValue([
      summary(),
      summary({ conversationId: convIdFor('rel-2') }),
    ]);
    await loadConversationView(req as never, CLIENT_CTX, USER);

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

  it('bookedCall is null when no live meeting exists, and carries the upcoming one when it does', async () => {
    mockListActiveMeetingsForContexts.mockResolvedValue(new Map([['rel-1', [meetingRow()]]]));
    const view = await loadConversationView(request([relationship()]) as never, CLIENT_CTX, USER);
    expect(view.threads[0]?.bookedCall).toEqual({
      meetingId: 'meeting-1',
      scheduledStartIso: '2999-09-01T04:00:00.000Z',
    });

    mockListActiveMeetingsForContexts.mockResolvedValue(new Map([['rel-1', []]]));
    const emptyView = await loadConversationView(
      request([relationship()]) as never,
      CLIENT_CTX,
      USER
    );
    expect(emptyView.threads[0]?.bookedCall).toBeNull();
  });

  it('an ENDED intro call is NOT the booked call — the CTA comes back (C2)', async () => {
    mockListActiveMeetingsForContexts.mockResolvedValue(
      new Map([['rel-1', [meetingRow({ status: 'ended' })]]])
    );
    const view = await loadConversationView(request([relationship()]) as never, CLIENT_CTX, USER);
    expect(view.threads[0]?.bookedCall).toBeNull();
  });

  it('a meeting whose window has already passed is NOT the booked call, even at status scheduled', async () => {
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
    const view = await loadConversationView(request([relationship()]) as never, CLIENT_CTX, USER);
    expect(view.threads[0]?.bookedCall).toBeNull();
  });

  it('with a past call AND an upcoming one, the UPCOMING one wins (repository order is start asc)', async () => {
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
    const view = await loadConversationView(request([relationship()]) as never, CLIENT_CTX, USER);
    expect(view.threads[0]?.bookedCall).toEqual({
      meetingId: 'meeting-next',
      scheduledStartIso: '2999-09-01T04:00:00.000Z',
    });
  });

  it('falls back to a null username when profile hydration fails', async () => {
    mockFindProfileById.mockRejectedValue(new Error('db down'));
    const view = await loadConversationView(request([relationship()]) as never, CLIENT_CTX, USER);
    expect(view.threads[0]?.expertUsername).toBeNull();
  });

  it('derives unread from inbound activity vs the watermark', async () => {
    mockListThreadSummaries.mockResolvedValue([
      summary({
        latestInboundActivityAt: new Date('2026-06-09T10:00:00Z'),
        lastReadAt: new Date('2026-06-09T09:00:00Z'),
      }),
    ]);
    const view = await loadConversationView(request([relationship()]) as never, CLIENT_CTX, USER);
    expect(view.threads[0]?.unread).toBe(true);
  });

  it('own activity never makes a thread unread (no inbound)', async () => {
    mockListThreadSummaries.mockResolvedValue([
      summary({
        latestMessage: {
          id: 'm-1',
          body: '<p>mine</p>',
          createdAt: new Date('2026-06-09T10:00:00Z'),
          senderUserId: VIEWER_ID,
        },
        latestInboundActivityAt: null,
      }),
    ]);
    const view = await loadConversationView(request([relationship()]) as never, CLIENT_CTX, USER);
    expect(view.threads[0]?.unread).toBe(false);
    expect(view.threads[0]?.latestMessageFromViewer).toBe(true);
  });

  it('truncates the preview to 140 plain-text chars', async () => {
    const long = 'a'.repeat(300);
    mockListThreadSummaries.mockResolvedValue([
      summary({
        latestMessage: {
          id: 'm-1',
          body: `<p>${long}</p>`,
          createdAt: new Date('2026-06-09T10:00:00Z'),
          senderUserId: EXPERT_USER_ID,
        },
      }),
    ]);
    const view = await loadConversationView(request([relationship()]) as never, CLIENT_CTX, USER);
    const preview = view.threads[0]?.latestMessagePreview ?? '';
    expect(preview.length).toBeLessThanOrEqual(140);
    expect(preview.endsWith('…')).toBe(true);
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

    const view = await loadConversationView(request([relationship()]) as never, CLIENT_CTX, USER);
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
    });
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
      USER
    );
    expect(view.threads).toEqual([]);
    expect(view.defaultThreadId).toBeNull();
    expect(view.initialMessages).toEqual([]);
    expect(mockListMessagesPage).not.toHaveBeenCalled();
  });

  it('reflects realtime availability', async () => {
    mockIsRealtimeConfigured.mockReturnValue(false);
    const view = await loadConversationView(request([relationship()]) as never, CLIENT_CTX, USER);
    expect(view.realtimeEnabled).toBe(false);
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
