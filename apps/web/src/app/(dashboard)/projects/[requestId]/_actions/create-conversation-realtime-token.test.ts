import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_OPEN = 'b0000000-0000-4000-8000-000000000002';
const REL_OPEN_2 = 'b0000000-0000-4000-8000-000000000003';
const REL_INVITED = 'b0000000-0000-4000-8000-000000000004';
const EXPERT_PROFILE_ID = 'c0000000-0000-4000-8000-000000000003';
// BAL-424: entitlement is still resolved over RELATIONSHIPS, but the granted CHANNELS key on
// the CONVERSATION each one anchors.
const CONV_OPEN = 'd0000000-0000-4000-8000-000000000012';
const CONV_OPEN_2 = 'd0000000-0000-4000-8000-000000000013';

vi.mock('server-only', () => ({}));

const mockFindByIdWithRelations = vi.fn();
const mockEnsureManyForContexts = vi.fn();
vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    findByIdWithRelations: (...args: unknown[]) => mockFindByIdWithRelations(...args),
  },
  conversationsRepository: {
    ensureManyForContexts: (...args: unknown[]) => mockEnsureManyForContexts(...args),
  },
}));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireUser(),
}));

const mockIsConfigured = vi.fn();
const mockCreateTokenRequest = vi.fn();
vi.mock('@/lib/realtime/ably-server', () => ({
  isRealtimeConfigured: () => mockIsConfigured(),
  getAblyRest: () => ({ auth: { createTokenRequest: mockCreateTokenRequest } }),
}));

import { createConversationRealtimeTokenAction } from './create-conversation-realtime-token';
import { log } from '@/lib/logging';

function relationship(
  id: string,
  status: string,
  expertProfileId = 'exp-x'
): Record<string, unknown> {
  return {
    id,
    expertProfileId,
    status,
    invitedAt: new Date(),
    updatedAt: new Date(),
    expertProfile: { id: expertProfileId, user: { id: 'u-x', firstName: 'X', lastName: 'Y' } },
    expressionsOfInterest: [],
    conversationMessages: [],
  };
}

function requestGraph(relationships: Record<string, unknown>[]): Record<string, unknown> {
  return {
    id: REQUEST_ID,
    companyId: 'company-1',
    createdByUserId: 'user-client',
    status: 'eoi_submitted',
    title: 'CPQ implementation',
    relationships,
  };
}

const CLIENT_USER = {
  id: 'user-client',
  companyId: 'company-1',
  platformRole: 'user',
};

const EXPERT_USER = {
  id: 'user-expert',
  companyId: 'company-expert',
  platformRole: 'user',
  expertProfileId: EXPERT_PROFILE_ID,
};

const TOKEN = { keyName: 'k', mac: 'm', nonce: 'n', timestamp: 1, capability: '{}' };

describe('createConversationRealtimeTokenAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(CLIENT_USER);
    mockIsConfigured.mockReturnValue(true);
    mockCreateTokenRequest.mockResolvedValue(TOKEN);
    mockFindByIdWithRelations.mockResolvedValue(
      requestGraph([
        relationship(REL_OPEN, 'eoi_submitted'),
        relationship(REL_OPEN_2, 'proposal_requested'),
        relationship(REL_INVITED, 'invited'),
      ])
    );
    mockEnsureManyForContexts.mockResolvedValue(
      new Map([
        [`relationship:${REL_OPEN}`, CONV_OPEN],
        [`relationship:${REL_OPEN_2}`, CONV_OPEN_2],
      ])
    );
  });

  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await createConversationRealtimeTokenAction({ requestId: REQUEST_ID });
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
  });

  it('denies an admin observer', async () => {
    mockRequireUser.mockResolvedValue({ ...CLIENT_USER, platformRole: 'admin' });
    const result = await createConversationRealtimeTokenAction({ requestId: REQUEST_ID });
    expect(result.success).toBe(false);
    expect(log.warn).toHaveBeenCalledWith('Realtime token denied', expect.any(Object));
    expect(mockCreateTokenRequest).not.toHaveBeenCalled();
  });

  it('client lens: subscribe-only capabilities over EVERY open thread (no wildcards)', async () => {
    const result = await createConversationRealtimeTokenAction({ requestId: REQUEST_ID });
    expect(result).toEqual({ success: true, tokenRequest: TOKEN });
    const params = mockCreateTokenRequest.mock.calls[0]?.[0] as {
      clientId: string;
      capability: string;
      ttl: number;
    };
    expect(params.clientId).toBe(CLIENT_USER.id);
    expect(JSON.parse(params.capability)).toEqual({
      [`conversation:${CONV_OPEN}`]: ['subscribe'],
      [`conversation:${CONV_OPEN_2}`]: ['subscribe'],
    });
    // ⚠ ENSURE, not find: a thread whose conversation did not yet exist would silently drop
    // out of the capability list, and its first message would be invisible to the
    // counterparty until their 15-minute token refreshed. The invited (closed) thread is
    // never offered to the seam.
    expect(mockEnsureManyForContexts).toHaveBeenCalledWith([
      { contextType: 'relationship', contextId: REL_OPEN },
      { contextType: 'relationship', contextId: REL_OPEN_2 },
    ]);
  });

  it('bounds post-revocation staleness with an explicit 15-minute TTL', async () => {
    await createConversationRealtimeTokenAction({ requestId: REQUEST_ID });
    expect(mockCreateTokenRequest).toHaveBeenCalledWith(
      expect.objectContaining({ ttl: 15 * 60 * 1000 })
    );
  });

  it("expert lens: only the expert's own open channel", async () => {
    mockRequireUser.mockResolvedValue(EXPERT_USER);
    mockFindByIdWithRelations.mockResolvedValue(
      requestGraph([
        relationship(REL_OPEN, 'eoi_submitted', EXPERT_PROFILE_ID),
        relationship(REL_OPEN_2, 'eoi_submitted', 'exp-other'),
      ])
    );
    mockEnsureManyForContexts.mockResolvedValue(new Map([[`relationship:${REL_OPEN}`, CONV_OPEN]]));
    const result = await createConversationRealtimeTokenAction({ requestId: REQUEST_ID });
    expect(result.success).toBe(true);
    const params = mockCreateTokenRequest.mock.calls[0]?.[0] as { capability: string };
    expect(JSON.parse(params.capability)).toEqual({
      [`conversation:${CONV_OPEN}`]: ['subscribe'],
    });
  });

  it('denies when the viewer has no open threads', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      requestGraph([relationship(REL_INVITED, 'invited')])
    );
    const result = await createConversationRealtimeTokenAction({ requestId: REQUEST_ID });
    expect(result).toEqual({ success: false, error: 'No open conversations on this request.' });
    // ⚠ THE WRITE RUNS AFTER THE PARTICIPANT LENS IS PROVEN, NEVER BEFORE.
    expect(mockEnsureManyForContexts).not.toHaveBeenCalled();
  });

  it('returns the disabled flag (no error toast material) when ABLY_API_KEY is unset', async () => {
    mockIsConfigured.mockReturnValue(false);
    const result = await createConversationRealtimeTokenAction({ requestId: REQUEST_ID });
    expect(result).toEqual({ success: false, disabled: true });
    expect(log.warn).toHaveBeenCalledWith(
      'Realtime disabled (no ABLY_API_KEY)',
      expect.any(Object)
    );
  });

  it('maps token-creation failures to a friendly error', async () => {
    mockCreateTokenRequest.mockRejectedValue(new Error('ably 500'));
    const result = await createConversationRealtimeTokenAction({ requestId: REQUEST_ID });
    expect(result).toEqual({ success: false, error: 'Could not connect live updates.' });
    expect(log.error).toHaveBeenCalled();
  });
});
