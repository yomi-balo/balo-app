import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { SessionUser } from '@/lib/auth/session';

const { mockGetCurrentUser, mockRedirect, mockNotFound } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockRedirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('next/navigation', () => ({ redirect: mockRedirect, notFound: mockNotFound }));
// ⚠ Do NOT stub CatalogueList — rendering it for real is what covers the composition and keeps
// SonarCloud new-code coverage honest.

import AdminCataloguePage from './page';

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-x',
    email: 'x@example.com',
    firstName: 'X',
    lastName: 'Y',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'admin',
    companyId: 'company-1',
    companyName: 'Northwind Industrial',
    companyRole: 'owner',
    ...overrides,
  };
}

async function renderPage() {
  const ui = await AdminCataloguePage();
  return render(ui);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRedirect.mockImplementation(() => {
    throw new Error('NEXT_REDIRECT');
  });
  mockNotFound.mockImplementation(() => {
    throw new Error('NEXT_NOT_FOUND');
  });
});

describe('AdminCataloguePage (RSC) — auth gate', () => {
  it('redirects to /login when there is no current user', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith('/login');
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it('notFound()s for a non-staff viewer', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ platformRole: 'user' }));
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });
});

describe('AdminCataloguePage (RSC) — admin render', () => {
  it('renders the heading and a link to /promo-codes, and a NON-shipped row renders no link', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ platformRole: 'admin' }));
    await renderPage();
    expect(mockNotFound).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: /Config & catalogue/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Promo codes/ })).toHaveAttribute(
      'href',
      '/promo-codes'
    );
    expect(screen.queryByRole('link', { name: /Taxonomy/ })).not.toBeInTheDocument();
  });

  it('admits a super_admin and shows no "View only" chip — the production state today', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ platformRole: 'super_admin' }));
    await renderPage();
    expect(mockNotFound).not.toHaveBeenCalled();
    expect(screen.queryByText('View only')).not.toBeInTheDocument();
  });
});
