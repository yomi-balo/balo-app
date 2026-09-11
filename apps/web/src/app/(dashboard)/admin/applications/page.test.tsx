import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';

const { mockGetCurrentUser, mockRedirect, mockNotFound, mockLoadApplications } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockRedirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  mockLoadApplications: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('next/navigation', () => ({
  redirect: mockRedirect,
  notFound: mockNotFound,
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock('./_lib/load-applications', () => ({ loadApplications: mockLoadApplications }));

import AdminApplicationsPage from './page';

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

const EMPTY_LIST = {
  ok: true as const,
  rows: [],
  counts: { pending: 0, approved: 0, declined: 0 },
  truncated: false,
};

async function renderPage(searchParams: { filter?: string } = {}) {
  const ui = await AdminApplicationsPage({ searchParams: Promise.resolve(searchParams) });
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

describe('AdminApplicationsPage (RSC) — auth gate', () => {
  it('redirects to /login when there is no current user', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockLoadApplications).not.toHaveBeenCalled();
  });

  it('notFound()s for a viewer without VIEW_PLATFORM_ADMIN, before ever calling loadApplications', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ platformRole: 'user' }));
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockLoadApplications).not.toHaveBeenCalled();
  });
});

describe('AdminApplicationsPage (RSC) — staff render', () => {
  it.each([undefined, 'nope', '__proto__', 'constructor'])(
    'defaults to the pending filter for %s',
    async (rawFilter) => {
      mockGetCurrentUser.mockResolvedValue(user());
      mockLoadApplications.mockResolvedValue(EMPTY_LIST);
      await renderPage({ filter: rawFilter });
      expect(mockLoadApplications).toHaveBeenCalledWith(expect.anything(), 'pending');
    }
  );

  it('reads a valid filter from the (Promise) searchParams', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockLoadApplications.mockResolvedValue(EMPTY_LIST);
    await renderPage({ filter: 'declined' });
    expect(mockLoadApplications).toHaveBeenCalledWith(expect.anything(), 'declined');
  });

  it('renders the Applications heading', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockLoadApplications.mockResolvedValue(EMPTY_LIST);
    await renderPage();
    expect(screen.getByRole('heading', { name: 'Applications' })).toBeInTheDocument();
  });

  it('a loader throw is log.error’d with filter and re-thrown', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockLoadApplications.mockRejectedValue(new Error('boom'));

    await expect(renderPage({ filter: 'pending' })).rejects.toThrow('boom');

    expect(log.error).toHaveBeenCalledWith(
      'Admin applications list failed',
      expect.objectContaining({ userId: 'user-x', filter: 'pending' })
    );
  });

  it('a forbidden DTO from loadApplications (defence-in-depth) renders notFound()', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockLoadApplications.mockResolvedValue({ ok: false, reason: 'forbidden' });
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('renders the pending empty state when there is nothing pending', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockLoadApplications.mockResolvedValue(EMPTY_LIST);
    await renderPage();
    expect(
      screen.getByText(/new applications land here the moment an expert submits/i)
    ).toBeInTheDocument();
  });

  it('renders a pending row with the waiting label derived from submittedAt', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    const submittedAt = new Date(Date.now() - 6 * 86_400_000 - 23 * 60 * 60 * 1000);
    mockLoadApplications.mockResolvedValue({
      ok: true,
      rows: [
        {
          expertProfileId: 'p1',
          applicantUserId: 'u1',
          firstName: 'Priya',
          lastName: 'Shah',
          email: 'priya@example.com',
          agencyName: null,
          applicationStatus: 'submitted',
          submittedAt,
          decidedAt: null,
          decidedByFirstName: null,
          decidedByLastName: null,
          declineReason: null,
        },
      ],
      counts: { pending: 1, approved: 0, declined: 0 },
      truncated: false,
    });
    await renderPage();
    expect(screen.getByText('waiting 6d')).toBeInTheDocument();
  });
});
