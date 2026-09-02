import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockFindByIdWithRelations = vi.fn();
const mockEnsureForContext = vi.fn();
const mockFindByContext = vi.fn();
vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    findByIdWithRelations: (...args: unknown[]) => mockFindByIdWithRelations(...args),
  },
  conversationsRepository: {
    ensureForContext: (...args: unknown[]) => mockEnsureForContext(...args),
    findByContext: (...args: unknown[]) => mockFindByContext(...args),
  },
}));

import { readConversationAccess, resolveConversationAccess } from './resolve-conversation-access';
import { log } from '@/lib/logging';
import type { SessionUser } from '@/lib/auth/session';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const OTHER_REL_ID = 'b0000000-0000-4000-8000-000000000099';
const EXPERT_PROFILE_ID = 'c0000000-0000-4000-8000-000000000003';
const CLIENT_USER_ID = 'user-client';
const CONVERSATION_ID = 'd0000000-0000-4000-8000-000000000004';
const DENIED = 'You do not have access to this conversation.';

function relationship(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REL_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    status: 'eoi_submitted',
    invitedAt: new Date(),
    updatedAt: new Date(),
    expertProfile: {
      id: EXPERT_PROFILE_ID,
      user: { id: 'user-expert', firstName: 'Priya', lastName: 'Nair' },
    },
    expressionsOfInterest: [],
    conversationMessages: [],
    ...overrides,
  };
}

function requestGraph(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REQUEST_ID,
    companyId: 'company-1',
    createdByUserId: CLIENT_USER_ID,
    status: 'eoi_submitted',
    title: 'CPQ implementation',
    relationships: [relationship()],
    ...overrides,
  };
}

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: CLIENT_USER_ID,
    email: 'dana@example.com',
    firstName: 'Dana',
    lastName: 'Whitfield',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'user',
    companyId: 'company-1',
    companyName: 'Northwind',
    companyRole: 'owner',
    ...overrides,
  };
}

const EXPERT_USER = user({
  id: 'user-expert',
  companyId: 'company-expert',
  expertProfileId: EXPERT_PROFILE_ID,
});

describe('resolveConversationAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindByIdWithRelations.mockResolvedValue(requestGraph());
    mockEnsureForContext.mockResolvedValue({
      conversation: { id: CONVERSATION_ID },
      created: false,
    });
    mockFindByContext.mockResolvedValue({ id: CONVERSATION_ID });
  });

  it('denies when the request does not exist (generic copy)', async () => {
    mockFindByIdWithRelations.mockResolvedValue(undefined);
    const result = await resolveConversationAccess(user(), REQUEST_ID, REL_ID);
    expect(result).toEqual({ ok: false, error: DENIED });
    expect(log.warn).toHaveBeenCalledWith('Conversation access denied', expect.any(Object));
  });

  it('denies an admin (observer, no chat)', async () => {
    const result = await resolveConversationAccess(
      user({ platformRole: 'admin', companyId: 'other-co' }),
      REQUEST_ID,
      REL_ID
    );
    expect(result.ok).toBe(false);
  });

  it('denies a stranger (no lens)', async () => {
    const result = await resolveConversationAccess(
      user({ companyId: 'unrelated-co' }),
      REQUEST_ID,
      REL_ID
    );
    expect(result.ok).toBe(false);
  });

  it('denies an expert claiming a FOREIGN relationship id', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      requestGraph({
        relationships: [
          relationship(),
          relationship({ id: OTHER_REL_ID, expertProfileId: 'exp-other' }),
        ],
      })
    );
    const result = await resolveConversationAccess(EXPERT_USER, REQUEST_ID, OTHER_REL_ID);
    expect(result).toEqual({ ok: false, error: DENIED });
  });

  it('denies a client claiming a relationship id not on this request', async () => {
    const result = await resolveConversationAccess(user(), REQUEST_ID, OTHER_REL_ID);
    expect(result).toEqual({ ok: false, error: DENIED });
  });

  it('denies an `invited` (not yet open) relationship for both lenses', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      requestGraph({ relationships: [relationship({ status: 'invited' })] })
    );
    const asClient = await resolveConversationAccess(user(), REQUEST_ID, REL_ID);
    expect(asClient.ok).toBe(false);
    // An invited expert resolves to the expert lens, but the thread isn't open.
    const asExpert = await resolveConversationAccess(EXPERT_USER, REQUEST_ID, REL_ID);
    expect(asExpert.ok).toBe(false);
  });

  it('denies a `declined` relationship', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      requestGraph({ relationships: [relationship({ status: 'declined' })] })
    );
    const result = await resolveConversationAccess(user(), REQUEST_ID, REL_ID);
    expect(result.ok).toBe(false);
  });

  it('denies a declined EXPERT (the lens resolver excludes their relationship → no lens)', async () => {
    // A declined relationship no longer grants the expert lens (BAL-276), so the
    // expert resolves to a non-participant and is denied — distinct from the
    // client-lens declined case above.
    mockFindByIdWithRelations.mockResolvedValue(
      requestGraph({ relationships: [relationship({ status: 'declined' })] })
    );
    const result = await resolveConversationAccess(EXPERT_USER, REQUEST_ID, REL_ID);
    expect(result).toEqual({ ok: false, error: DENIED });
  });

  it('client sender → expert recipient (expertProfileId)', async () => {
    const result = await resolveConversationAccess(user(), REQUEST_ID, REL_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ctx.lens).toBe('client');
      expect(result.recipient).toEqual({ role: 'expert', expertProfileId: EXPERT_PROFILE_ID });
      expect(result.relationship.id).toBe(REL_ID);
    }
  });

  it('expert sender → client recipient (request owner user id)', async () => {
    const result = await resolveConversationAccess(EXPERT_USER, REQUEST_ID, REL_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ctx.lens).toBe('expert');
      expect(result.recipient).toEqual({ role: 'client', userId: CLIENT_USER_ID });
    }
  });

  // ── BAL-424: the conversation seam ────────────────────────────────────
  describe('conversationId (BAL-424)', () => {
    it('returns the relationship-anchored conversation id on the ok path', async () => {
      const result = await resolveConversationAccess(user(), REQUEST_ID, REL_ID);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.conversationId).toBe(CONVERSATION_ID);
      }
      expect(mockEnsureForContext).toHaveBeenCalledWith({
        contextType: 'relationship',
        contextId: REL_ID,
      });
    });

    /**
     * ⚠ THE ORDERING RULE. `ensureForContext` WRITES. If it ran before the lens/status
     * guards, an unauthenticated or non-participant caller could make this function mint a
     * row for any relationship id they guessed — and the denial would then differ
     * observably from a genuine miss.
     */
    it.each([
      ['a missing request', undefined, () => user(), REL_ID],
      [
        'an admin observer',
        requestGraph(),
        () => user({ platformRole: 'admin', companyId: 'x' }),
        REL_ID,
      ],
      ['a stranger', requestGraph(), () => user({ companyId: 'unrelated-co' }), REL_ID],
      ['a foreign relationship claim', requestGraph(), () => user(), OTHER_REL_ID],
      [
        'a thread that is not open',
        requestGraph({ relationships: [relationship({ status: 'invited' })] }),
        () => user(),
        REL_ID,
      ],
    ])('never touches the conversation seam for %s', async (_label, graph, actor, relId) => {
      mockFindByIdWithRelations.mockResolvedValue(graph);
      const result = await resolveConversationAccess(actor(), REQUEST_ID, relId);
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty('conversationId');
      expect(mockEnsureForContext).not.toHaveBeenCalled();
    });

    /** The denial log must not confirm a thread's existence either. */
    it('logs no conversationId on a denial', async () => {
      mockFindByIdWithRelations.mockResolvedValue(undefined);
      await resolveConversationAccess(user(), REQUEST_ID, REL_ID);
      expect(log.warn).toHaveBeenCalledWith(
        'Conversation access denied',
        expect.not.objectContaining({ conversationId: expect.anything() })
      );
    });
  });
});

/**
 * BAL-424 — the READ-ONLY sibling. `fetch-thread.ts` (and, until BAL-431 (OSD-2) retired it,
 * `get-conversation-file-download.ts`)
 * authenticate with bare `requireUser()` and sit on `READ_ONLY_ALLOWLIST`; once
 * `resolveConversationAccess` began get-or-creating, using it there would have made them
 * TRANSITIVE writers reachable by an un-onboarded member — invisibly, because the invariant
 * test reads the action's own source.
 */
describe('readConversationAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindByIdWithRelations.mockResolvedValue(requestGraph());
    mockFindByContext.mockResolvedValue({ id: CONVERSATION_ID });
    mockEnsureForContext.mockResolvedValue({
      conversation: { id: CONVERSATION_ID },
      created: false,
    });
  });

  it('returns the conversation id without ever writing', async () => {
    const result = await readConversationAccess(user(), REQUEST_ID, REL_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.conversationId).toBe(CONVERSATION_ID);
    }
    expect(mockFindByContext).toHaveBeenCalledWith({
      contextType: 'relationship',
      contextId: REL_ID,
    });
    expect(mockEnsureForContext).not.toHaveBeenCalled();
  });

  it('reports undefined rather than provisioning when no thread exists yet', async () => {
    mockFindByContext.mockResolvedValue(undefined);
    const result = await readConversationAccess(user(), REQUEST_ID, REL_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.conversationId).toBeUndefined();
    }
    expect(mockEnsureForContext).not.toHaveBeenCalled();
  });

  it('runs the SAME authorization as the writing variant — denials match literal for literal', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      requestGraph({ relationships: [relationship({ status: 'invited' })] })
    );
    const read = await readConversationAccess(user(), REQUEST_ID, REL_ID);
    const write = await resolveConversationAccess(user(), REQUEST_ID, REL_ID);
    expect(read).toEqual({ ok: false, error: DENIED });
    expect(write).toEqual({ ok: false, error: DENIED });
    // Neither touches the seam on a denial.
    expect(mockFindByContext).not.toHaveBeenCalled();
    expect(mockEnsureForContext).not.toHaveBeenCalled();
  });

  it('denies an expert claiming a FOREIGN relationship id, exactly as the writer does', async () => {
    const result = await readConversationAccess(EXPERT_USER, REQUEST_ID, OTHER_REL_ID);
    expect(result).toEqual({ ok: false, error: DENIED });
    expect(mockFindByContext).not.toHaveBeenCalled();
  });
});
