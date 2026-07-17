import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CAPABILITIES } from '@balo/shared/authz';

const { mockFindById, mockGetMemberRole } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockGetMemberRole: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  creditSessionsRepository: { findById: mockFindById },
  partyMembershipsRepository: { getMemberRole: mockGetMemberRole },
}));

import { authorizeSessionActor } from './authorize-session-actor.js';

const SESSION = { id: 'session_1', companyId: 'company_1', walletId: 'wallet_1' };

describe('authorizeSessionActor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue(SESSION);
    mockGetMemberRole.mockResolvedValue('member');
  });

  it('returns not_found when the session is missing/soft-deleted (never leaks membership)', async () => {
    mockFindById.mockResolvedValue(undefined);
    const res = await authorizeSessionActor({ sessionId: 'nope', userId: 'user_1' });
    expect(res).toEqual({ ok: false, code: 'not_found' });
    expect(mockGetMemberRole).not.toHaveBeenCalled();
  });

  it('returns forbidden for a non-member of the session company (cross-tenant IDOR)', async () => {
    mockGetMemberRole.mockResolvedValue(undefined);
    const res = await authorizeSessionActor({ sessionId: 'session_1', userId: 'stranger' });
    expect(res).toEqual({ ok: false, code: 'forbidden' });
    // Membership is resolved against the SESSION's company, not any caller-supplied scope.
    expect(mockGetMemberRole).toHaveBeenCalledWith('company', 'company_1', 'stranger');
  });

  it('returns forbidden when the role does not grant the required capability', async () => {
    mockGetMemberRole.mockResolvedValue('unknown_role'); // grants nothing in the authz map
    const res = await authorizeSessionActor({
      sessionId: 'session_1',
      userId: 'user_1',
      requireCapability: CAPABILITIES.CONSUME_CREDITS,
    });
    expect(res).toEqual({ ok: false, code: 'forbidden' });
  });

  it('returns ok + session + role for a member (membership-only, no capability required)', async () => {
    const res = await authorizeSessionActor({ sessionId: 'session_1', userId: 'user_1' });
    expect(res).toEqual({ ok: true, session: SESSION, role: 'member' });
  });

  it('returns ok for a member holding the required CONSUME_CREDITS capability', async () => {
    const res = await authorizeSessionActor({
      sessionId: 'session_1',
      userId: 'user_1',
      requireCapability: CAPABILITIES.CONSUME_CREDITS,
    });
    expect(res).toEqual({ ok: true, session: SESSION, role: 'member' });
  });
});
