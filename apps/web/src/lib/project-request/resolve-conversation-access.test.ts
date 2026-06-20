import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockFindByIdWithRelations = vi.fn();
vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    findByIdWithRelations: (...args: unknown[]) => mockFindByIdWithRelations(...args),
  },
}));

import { resolveConversationAccess } from './resolve-conversation-access';
import { log } from '@/lib/logging';
import type { SessionUser } from '@/lib/auth/session';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const OTHER_REL_ID = 'b0000000-0000-4000-8000-000000000099';
const EXPERT_PROFILE_ID = 'c0000000-0000-4000-8000-000000000003';
const CLIENT_USER_ID = 'user-client';
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
});
