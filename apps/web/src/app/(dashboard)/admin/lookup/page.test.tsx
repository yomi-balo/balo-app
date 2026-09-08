import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';

const { mockGetCurrentUser, mockRedirect, mockNotFound, mockLoadLookup } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockRedirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  mockLoadLookup: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('next/navigation', () => ({
  redirect: mockRedirect,
  notFound: mockNotFound,
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock('./_lib/load-lookup', () => ({ loadLookup: mockLoadLookup }));

import AdminLookupPage from './page';

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

async function renderPage(searchParams: { q?: string } = {}) {
  const ui = await AdminLookupPage({ searchParams: Promise.resolve(searchParams) });
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

describe('AdminLookupPage (RSC) — auth gate', () => {
  it('redirects to /login when there is no current user', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith('/login');
    expect(mockLoadLookup).not.toHaveBeenCalled();
  });

  it('notFound()s for a non-staff viewer, before ever calling loadLookup', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ platformRole: 'user' }));
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockLoadLookup).not.toHaveBeenCalled();
  });
});

describe('AdminLookupPage (RSC) — staff render', () => {
  it('reads q from the (Promise) searchParams and passes it to the shell', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockLoadLookup.mockResolvedValue({ ok: true, results: [], truncated: false, tooShort: false });

    await renderPage({ q: 'northwind' });

    expect(mockLoadLookup).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-x' }),
      'northwind'
    );
    expect(screen.getByRole('textbox', { name: /search lookup/i })).toHaveValue('northwind');
  });

  it('an absent q defaults to the empty string', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockLoadLookup.mockResolvedValue({ ok: true, results: [], truncated: false, tooShort: false });

    await renderPage({});

    expect(mockLoadLookup).toHaveBeenCalledWith(expect.anything(), '');
  });

  it('renders the Lookup heading', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockLoadLookup.mockResolvedValue({ ok: true, results: [], truncated: false, tooShort: false });
    await renderPage();
    expect(screen.getByRole('heading', { name: 'Lookup' })).toBeInTheDocument();
  });

  it('a loader throw is log.error’d with queryLength (never the query) and re-thrown', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockLoadLookup.mockRejectedValue(new Error('boom'));

    await expect(renderPage({ q: 'dana@northwind.com.au' })).rejects.toThrow('boom');

    expect(log.error).toHaveBeenCalledWith(
      'Admin lookup search failed',
      expect.objectContaining({ userId: 'user-x', queryLength: 'dana@northwind.com.au'.length })
    );
    const loggedPayload = vi.mocked(log.error).mock.calls[0]?.[1];
    expect(JSON.stringify(loggedPayload)).not.toContain('dana@northwind.com.au');
  });

  it('a forbidden DTO from loadLookup (defence-in-depth) renders notFound()', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockLoadLookup.mockResolvedValue({ ok: false, reason: 'forbidden' });
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
