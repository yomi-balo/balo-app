import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFindById, mockFindProfileById, mockGetMemberRole } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockFindProfileById: vi.fn(),
  mockGetMemberRole: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  creditSessionsRepository: { findById: mockFindById },
  expertsRepository: { findProfileById: mockFindProfileById },
  partyMembershipsRepository: { getMemberRole: mockGetMemberRole },
}));

import { authorizeSessionExpert } from './authorize-session-expert.js';

const SESSION = { id: 'session_1', companyId: 'company_1', expertProfileId: 'expert_1' };

describe('authorizeSessionExpert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue(SESSION);
  });

  it('returns not_found when the session is missing/soft-deleted (never leaks existence)', async () => {
    mockFindById.mockResolvedValue(undefined);
    const res = await authorizeSessionExpert({ sessionId: 'nope', userId: 'user_1' });
    expect(res).toEqual({ ok: false, code: 'not_found' });
    expect(mockFindProfileById).not.toHaveBeenCalled();
  });

  it('grants an INDEPENDENT expert (userId === profile.userId)', async () => {
    mockFindProfileById.mockResolvedValue({ userId: 'expert_user_1', agencyId: null });
    const res = await authorizeSessionExpert({ sessionId: 'session_1', userId: 'expert_user_1' });
    expect(res).toEqual({ ok: true, session: SESSION, expertProfileId: 'expert_1' });
    // No agency lookup needed for the independent expert.
    expect(mockGetMemberRole).not.toHaveBeenCalled();
  });

  it('grants an AGENCY-based expert via live agency membership', async () => {
    mockFindProfileById.mockResolvedValue({ userId: 'someone_else', agencyId: 'agency_9' });
    mockGetMemberRole.mockResolvedValue('member');
    const res = await authorizeSessionExpert({ sessionId: 'session_1', userId: 'agency_user' });
    expect(res).toEqual({ ok: true, session: SESSION, expertProfileId: 'expert_1' });
    expect(mockGetMemberRole).toHaveBeenCalledWith('agency', 'agency_9', 'agency_user');
  });

  it('denies a stranger who is neither the expert nor an agency member (cross-tenant)', async () => {
    mockFindProfileById.mockResolvedValue({ userId: 'someone_else', agencyId: 'agency_9' });
    mockGetMemberRole.mockResolvedValue(undefined);
    const res = await authorizeSessionExpert({ sessionId: 'session_1', userId: 'stranger' });
    expect(res).toEqual({ ok: false, code: 'forbidden' });
  });

  it('denies when the expert has no agency and the caller is not the expert', async () => {
    mockFindProfileById.mockResolvedValue({ userId: 'someone_else', agencyId: null });
    const res = await authorizeSessionExpert({ sessionId: 'session_1', userId: 'stranger' });
    expect(res).toEqual({ ok: false, code: 'forbidden' });
    expect(mockGetMemberRole).not.toHaveBeenCalled();
  });

  it('denies when the expert profile is missing', async () => {
    mockFindProfileById.mockResolvedValue(undefined);
    const res = await authorizeSessionExpert({ sessionId: 'session_1', userId: 'user_1' });
    expect(res).toEqual({ ok: false, code: 'forbidden' });
  });
});
