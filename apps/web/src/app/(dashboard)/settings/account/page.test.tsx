import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';

const { mockGetCurrentUser, mockRedirect, mockFindDisplayById } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockRedirect: vi.fn(() => {
    throw new Error('REDIRECT');
  }),
  mockFindDisplayById: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: mockRedirect,
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('@balo/db', () => ({ usersRepository: { findDisplayById: mockFindDisplayById } }));
vi.mock('@/lib/auth/actions/update-name', () => ({ updateNameAction: vi.fn() }));

import AccountSettingsPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  mockRedirect.mockImplementation(() => {
    throw new Error('REDIRECT');
  });
  mockGetCurrentUser.mockResolvedValue({
    id: 'user-1',
    firstName: 'Old',
    lastName: 'Cookie',
  });
  mockFindDisplayById.mockResolvedValue({
    id: 'user-1',
    firstName: 'Dana',
    lastName: 'Reyes',
    avatarUrl: null,
  });
});

describe('Account settings page', () => {
  it('redirects a signed-out visitor to login before reading anything', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(AccountSettingsPage()).rejects.toThrow('REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith('/login');
    expect(mockFindDisplayById).not.toHaveBeenCalled();
  });

  it('seeds the form from the database, not the possibly-stale session cookie', async () => {
    render(await AccountSettingsPage());
    expect(mockFindDisplayById).toHaveBeenCalledWith('user-1');
    expect(screen.getByLabelText('First name')).toHaveValue('Dana');
    expect(screen.getByLabelText('Last name')).toHaveValue('Reyes');
  });

  it('renders empty fields for an account with no stored name', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', firstName: null, lastName: null });
    mockFindDisplayById.mockResolvedValue({
      id: 'user-1',
      firstName: null,
      lastName: null,
      avatarUrl: null,
    });
    render(await AccountSettingsPage());
    expect(screen.getByLabelText('First name')).toHaveValue('');
    expect(screen.getByLabelText('Last name')).toHaveValue('');
  });
});
