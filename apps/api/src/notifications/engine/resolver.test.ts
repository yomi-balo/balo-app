import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindById } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  usersRepository: { findById: mockFindById },
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
});
