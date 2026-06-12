import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockFindById,
  mockFindUserIdByProfileId,
  mockCompanyFindById,
  mockFindIdsByPlatformRoles,
  mockFindUserIdsByProfileIds,
  mockListByRequest,
} = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockFindUserIdByProfileId: vi.fn(),
  mockCompanyFindById: vi.fn(),
  mockFindIdsByPlatformRoles: vi.fn(),
  mockFindUserIdsByProfileIds: vi.fn(),
  mockListByRequest: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  usersRepository: {
    findById: mockFindById,
    findIdsByPlatformRoles: mockFindIdsByPlatformRoles,
  },
  expertsRepository: {
    findUserIdByProfileId: mockFindUserIdByProfileId,
    findUserIdsByProfileIds: mockFindUserIdsByProfileIds,
  },
  companiesRepository: { findById: mockCompanyFindById },
  proposalsRepository: { listByRequest: mockListByRequest },
}));

import { resolveContext } from './resolver.js';

describe('resolveContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hydrates data.user when userId is present in payload', async () => {
    const mockUser = {
      id: 'user-123',
      email: 'test@example.com',
      firstName: 'John',
    };
    mockFindById.mockResolvedValue(mockUser);

    const context = await resolveContext('user.welcome', {
      correlationId: 'user-123',
      userId: 'user-123',
    });

    expect(mockFindById).toHaveBeenCalledWith('user-123');
    expect(context.data.user).toEqual(mockUser);
    expect(context.event).toBe('user.welcome');
    expect(context.payload).toEqual({
      correlationId: 'user-123',
      userId: 'user-123',
    });
  });

  it('returns empty data when userId is not present', async () => {
    const context = await resolveContext('some.event', {
      correlationId: 'abc',
    });

    expect(mockFindById).not.toHaveBeenCalled();
    expect(context.data).toEqual({});
  });

  it('sets data.user to undefined when user is not found', async () => {
    mockFindById.mockResolvedValue(undefined);

    const context = await resolveContext('user.welcome', {
      correlationId: 'user-missing',
      userId: 'user-missing',
    });

    expect(mockFindById).toHaveBeenCalledWith('user-missing');
    expect(context.data.user).toBeUndefined();
  });

  it('hydrates data.expert when expertProfileId is present in payload', async () => {
    const mockExpert = { user: { id: 'expert-user-99' } };
    mockFindUserIdByProfileId.mockResolvedValue(mockExpert);

    const context = await resolveContext('project.request_submitted', {
      correlationId: 'req-1',
      projectRequestId: 'req-1',
      expertProfileId: 'profile-1',
      companyId: 'company-1',
      title: 'Lead routing rebuild',
    });

    expect(mockFindUserIdByProfileId).toHaveBeenCalledWith('profile-1');
    expect(context.data.expert).toEqual(mockExpert);
    expect(context.event).toBe('project.request_submitted');
  });

  it('does not hydrate data.expert when expertProfileId is absent', async () => {
    await resolveContext('user.welcome', {
      correlationId: 'user-123',
      userId: 'user-123',
    });

    expect(mockFindUserIdByProfileId).not.toHaveBeenCalled();
  });

  it('sets data.expert to undefined when the expert profile is not found', async () => {
    mockFindUserIdByProfileId.mockResolvedValue(undefined);

    const context = await resolveContext('project.request_submitted', {
      correlationId: 'req-2',
      expertProfileId: 'missing-profile',
    });

    expect(mockFindUserIdByProfileId).toHaveBeenCalledWith('missing-profile');
    expect(context.data.expert).toBeUndefined();
  });

  it('hydrates data.company when companyId is present (e.g. project.match_requested)', async () => {
    const mockCompany = { id: 'company-1', name: 'Acme Inc' };
    mockCompanyFindById.mockResolvedValue(mockCompany);

    const context = await resolveContext('project.match_requested', {
      correlationId: 'req-3',
      projectRequestId: 'req-3',
      companyId: 'company-1',
      title: 'Lead routing rebuild',
    });

    expect(mockCompanyFindById).toHaveBeenCalledWith('company-1');
    expect(context.data.company).toEqual(mockCompany);
    // No expert hydration for match mode.
    expect(mockFindUserIdByProfileId).not.toHaveBeenCalled();
  });

  it('does not hydrate data.company when companyId is absent', async () => {
    await resolveContext('user.welcome', {
      correlationId: 'user-123',
      userId: 'user-123',
    });

    expect(mockCompanyFindById).not.toHaveBeenCalled();
  });

  // ── BAL-289 fan-out hydration for project.proposal_accepted ──
  describe('project.proposal_accepted fan-out hydration', () => {
    const acceptedPayload = {
      correlationId: 'prop-1',
      projectRequestId: 'req-1',
      relationshipId: 'rel-winner',
      expertProfileId: 'profile-winner',
      title: 'CPQ implementation',
    };

    it('hydrates adminUserIds and nonSelectedExpertUserIds (excluding the winner)', async () => {
      mockFindIdsByPlatformRoles.mockResolvedValue(['admin-1', 'admin-2']);
      mockListByRequest.mockResolvedValue([
        // The accepted/winning proposal — excluded by relationship + profile.
        {
          status: 'submitted',
          relationshipId: 'rel-winner',
          expertProfileId: 'profile-winner',
        },
        // Two losing submitted proposals — included.
        { status: 'submitted', relationshipId: 'rel-a', expertProfileId: 'profile-a' },
        { status: 'submitted', relationshipId: 'rel-b', expertProfileId: 'profile-b' },
        // A non-submitted (e.g. draft) proposal — excluded by status.
        { status: 'draft', relationshipId: 'rel-c', expertProfileId: 'profile-c' },
      ]);
      mockFindUserIdsByProfileIds.mockResolvedValue(['user-a', 'user-b']);

      const context = await resolveContext('project.proposal_accepted', acceptedPayload);

      expect(mockFindIdsByPlatformRoles).toHaveBeenCalledWith(['admin', 'super_admin']);
      expect(context.data.adminUserIds).toEqual(['admin-1', 'admin-2']);

      expect(mockListByRequest).toHaveBeenCalledWith('req-1');
      // Only the two losing submitted proposals' profile ids reach the batch read.
      expect(mockFindUserIdsByProfileIds).toHaveBeenCalledWith(['profile-a', 'profile-b']);
      expect(context.data.nonSelectedExpertUserIds).toEqual(['user-a', 'user-b']);
    });

    it('sets nonSelectedExpertUserIds to [] (no batch read) when no siblings remain', async () => {
      mockFindIdsByPlatformRoles.mockResolvedValue(['admin-1']);
      mockListByRequest.mockResolvedValue([
        {
          status: 'submitted',
          relationshipId: 'rel-winner',
          expertProfileId: 'profile-winner',
        },
      ]);

      const context = await resolveContext('project.proposal_accepted', acceptedPayload);

      expect(context.data.nonSelectedExpertUserIds).toEqual([]);
      expect(mockFindUserIdsByProfileIds).not.toHaveBeenCalled();
    });

    it('hydrates adminUserIds but skips the sibling read when projectRequestId is absent', async () => {
      mockFindIdsByPlatformRoles.mockResolvedValue(['admin-1', 'admin-2']);
      // Payload OMITS projectRequestId → the `typeof === 'string'` FALSE branch.
      const payloadWithoutRequestId = {
        correlationId: acceptedPayload.correlationId,
        relationshipId: acceptedPayload.relationshipId,
        expertProfileId: acceptedPayload.expertProfileId,
        title: acceptedPayload.title,
      };

      const context = await resolveContext('project.proposal_accepted', payloadWithoutRequestId);

      // Admins still hydrated...
      expect(mockFindIdsByPlatformRoles).toHaveBeenCalledWith(['admin', 'super_admin']);
      expect(context.data.adminUserIds).toEqual(['admin-1', 'admin-2']);
      // ...but the sibling fan-out is skipped entirely.
      expect(context.data.nonSelectedExpertUserIds).toBeUndefined();
      expect(mockListByRequest).not.toHaveBeenCalled();
    });

    it('still hydrates the winning expert via data.expert', async () => {
      const winner = { user: { id: 'winner-user' } };
      mockFindUserIdByProfileId.mockResolvedValue(winner);
      mockFindIdsByPlatformRoles.mockResolvedValue([]);
      mockListByRequest.mockResolvedValue([]);

      const context = await resolveContext('project.proposal_accepted', acceptedPayload);

      expect(mockFindUserIdByProfileId).toHaveBeenCalledWith('profile-winner');
      expect(context.data.expert).toEqual(winner);
    });
  });
});
