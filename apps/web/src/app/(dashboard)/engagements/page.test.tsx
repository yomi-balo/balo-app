import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { SessionUser } from '@/lib/auth/session';
import type { EngagementsOversightDTO } from '@/lib/engagements/oversight-row';

// ── Seams the page composes (mirrors the projects RSC page-test precedent) ──
const { mockGetCurrentUser, mockRedirect, mockNotFound, mockLogError, mockLoad } = vi.hoisted(
  () => ({
    mockGetCurrentUser: vi.fn(),
    // redirect()/notFound() must THROW so control flow stops, exactly like Next.
    mockRedirect: vi.fn(() => {
      throw new Error('NEXT_REDIRECT');
    }),
    mockNotFound: vi.fn(() => {
      throw new Error('NEXT_NOT_FOUND');
    }),
    mockLogError: vi.fn(),
    mockLoad: vi.fn(),
  })
);

vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('next/navigation', () => ({ redirect: mockRedirect, notFound: mockNotFound }));
vi.mock('@/lib/logging', () => ({ log: { error: mockLogError } }));
// The `server-only` loader owns its own coverage; the page test only asserts
// WHETHER (and after which gates) it is invoked.
vi.mock('@/lib/engagements/engagements-oversight', () => ({ loadEngagementsOversight: mockLoad }));
// Stub the heavy client shell — this stays a unit test of the page's gating.
vi.mock('./_components/engagements-oversight-shell', () => ({
  EngagementsOversightShell: ({ dto }: { dto: EngagementsOversightDTO }) => (
    <div data-testid="oversight-shell" data-empty={String(dto.isEmpty)} />
  ),
}));

import EngagementsPage from './page';

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

function dto(isEmpty = false): EngagementsOversightDTO {
  return {
    rows: [],
    counts: { active: 0, inReview: 0, stalled: 0, completed: 0, cancelled: 0 },
    isEmpty,
  };
}

async function renderPage() {
  const ui = await EngagementsPage();
  return render(ui);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EngagementsPage (RSC) — auth gate', () => {
  it('redirects to /login when there is no current user (and loads nothing)', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith('/login');
    expect(mockNotFound).not.toHaveBeenCalled();
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('notFound() for a non-admin viewer (no existence leak; loads nothing)', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ platformRole: 'user' }));

    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockNotFound).toHaveBeenCalledTimes(1);
    expect(mockLoad).not.toHaveBeenCalled();
    expect(screen.queryByTestId('oversight-shell')).not.toBeInTheDocument();
  });
});

describe('EngagementsPage (RSC) — admin load', () => {
  it('loads the oversight DTO and renders the shell for an admin', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ platformRole: 'admin' }));
    mockLoad.mockResolvedValue(dto(false));

    await renderPage();

    expect(mockNotFound).not.toHaveBeenCalled();
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('oversight-shell')).toHaveAttribute('data-empty', 'false');
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('admits a super_admin and forwards the empty DTO to the shell', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ platformRole: 'super_admin' }));
    mockLoad.mockResolvedValue(dto(true));

    await renderPage();

    expect(mockNotFound).not.toHaveBeenCalled();
    expect(screen.getByTestId('oversight-shell')).toHaveAttribute('data-empty', 'true');
  });
});

describe('EngagementsPage (RSC) — load error boundary', () => {
  it('logs an error with {userId} and rethrows (to error.tsx) when the load throws', async () => {
    const viewer = user({ platformRole: 'admin' });
    mockGetCurrentUser.mockResolvedValue(viewer);
    mockLoad.mockRejectedValue(new Error('db down'));

    await expect(renderPage()).rejects.toThrow('db down');
    expect(mockLogError).toHaveBeenCalledWith(
      'Failed to load engagements oversight',
      expect.objectContaining({ userId: viewer.id })
    );
    expect(screen.queryByTestId('oversight-shell')).not.toBeInTheDocument();
  });
});
