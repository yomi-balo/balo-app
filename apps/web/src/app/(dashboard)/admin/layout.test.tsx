import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { SessionUser } from '@/lib/auth/session';

const { mockGetCurrentUser, mockRedirect, mockNotFound } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockRedirect: vi.fn(() => {
    throw new Error('REDIRECT');
  }),
  mockNotFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));

vi.mock('next/navigation', () => ({ redirect: mockRedirect, notFound: mockNotFound }));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
// ⚠ Do NOT mock `@/lib/authz/platform` — it is pure and synchronous, and mocking it would make
// the gate assertion vacuous. Let the real predicate run over the seeded `platformRole`.

import AdminLayout from './layout';

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-1',
    email: 'staff@example.com',
    firstName: 'Staff',
    lastName: 'Member',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'user',
    companyId: 'company-1',
    companyName: 'Balo',
    companyRole: 'member',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRedirect.mockImplementation(() => {
    throw new Error('REDIRECT');
  });
  mockNotFound.mockImplementation(() => {
    throw new Error('NOT_FOUND');
  });
});

describe('AdminLayout (BAL-534)', () => {
  it('redirects to /login when there is no user', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(AdminLayout({ children: <div /> })).rejects.toThrow('REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith('/login');
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it('notFound()s for a non-staff platformRole', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ platformRole: 'user' }));
    await expect(AdminLayout({ children: <div /> })).rejects.toThrow('NOT_FOUND');
    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });

  it('renders children for platformRole "admin"', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ platformRole: 'admin' }));
    const ui = await AdminLayout({ children: <div data-testid="child">Child</div> });
    render(ui);
    expect(screen.getByText('Child')).toBeInTheDocument();
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it('renders children for platformRole "super_admin"', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ platformRole: 'super_admin' }));
    const ui = await AdminLayout({ children: <div data-testid="child">Child</div> });
    render(ui);
    expect(screen.getByText('Child')).toBeInTheDocument();
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockNotFound).not.toHaveBeenCalled();
  });
});
