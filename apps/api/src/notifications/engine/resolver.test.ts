import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindById, mockFindUserIdByProfileId, mockCompanyFindById } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockFindUserIdByProfileId: vi.fn(),
  mockCompanyFindById: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  usersRepository: { findById: mockFindById },
  expertsRepository: { findUserIdByProfileId: mockFindUserIdByProfileId },
  companiesRepository: { findById: mockCompanyFindById },
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
});
