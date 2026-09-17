import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';

const { mockGetCurrentUser, mockRedirect, mockNotFound, mockLoadStaffAccess } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockRedirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  mockLoadStaffAccess: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('next/navigation', () => ({
  redirect: mockRedirect,
  notFound: mockNotFound,
}));
vi.mock('./_lib/load-staff-access', () => ({ loadStaffAccess: mockLoadStaffAccess }));

vi.mock('./_components/staff-access-workspace', () => ({
  StaffAccessWorkspace: (props: {
    people: unknown[];
    viewerId: string;
    initialPersonId: string | null;
  }) => (
    <div data-testid="workspace">
      workspace:{props.people.length}:{props.viewerId}:{props.initialPersonId ?? 'none'}
    </div>
  ),
}));
vi.mock('./_components/staff-access-states', () => ({
  StaffAccessNoAccess: () => <div data-testid="no-access" />,
}));

import StaffAccessPage from './page';

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

async function renderPage(searchParams: { person?: string } = {}) {
  const ui = await StaffAccessPage({ searchParams: Promise.resolve(searchParams) });
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

describe('StaffAccessPage (RSC) — auth gate', () => {
  it('redirects to /login when there is no current user', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockLoadStaffAccess).not.toHaveBeenCalled();
  });

  it('notFound()s for a viewer without VIEW_PLATFORM_ADMIN, before ever calling loadStaffAccess', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ platformRole: 'user' }));
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockLoadStaffAccess).not.toHaveBeenCalled();
  });
});

describe('StaffAccessPage (RSC) — staff render', () => {
  it('renders the Staff access heading', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockLoadStaffAccess.mockResolvedValue({ ok: true, people: [] });
    await renderPage();
    expect(screen.getByRole('heading', { name: 'Staff access' })).toBeInTheDocument();
  });

  it('a loader throw is log.error’d with the userId and re-thrown', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockLoadStaffAccess.mockRejectedValue(new Error('boom'));

    await expect(renderPage()).rejects.toThrow('boom');

    expect(log.error).toHaveBeenCalledWith(
      'Staff access roster failed',
      expect.objectContaining({ userId: 'user-x' })
    );
  });

  it('D5 — a forbidden DTO renders the no-access state, never notFound()', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockLoadStaffAccess.mockResolvedValue({ ok: false, reason: 'forbidden' });
    await renderPage();
    expect(screen.getByTestId('no-access')).toBeInTheDocument();
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it('renders the workspace with the people, viewer id, and initial person from the URL', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ id: 'user-x' }));
    mockLoadStaffAccess.mockResolvedValue({
      ok: true,
      people: [{ id: 'p1' }, { id: 'p2' }],
    });
    await renderPage({ person: 'p2' });
    expect(screen.getByTestId('workspace')).toHaveTextContent('workspace:2:user-x:p2');
  });

  it('passes null initialPersonId when no ?person= is present', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockLoadStaffAccess.mockResolvedValue({ ok: true, people: [] });
    await renderPage();
    expect(screen.getByTestId('workspace')).toHaveTextContent('workspace:0:user-x:none');
  });
});
