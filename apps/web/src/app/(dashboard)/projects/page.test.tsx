import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { SessionUser } from '@/lib/auth/session';
import type { AdminPortfolioDTO, PortfolioDTO } from '@/lib/projects-inbox/portfolio-row';
import type {
  PortfolioLens,
  ResolvedPortfolioLens,
} from '@/lib/projects-inbox/resolve-portfolio-lens';

// ── Seams the page composes (mirrors the BAL-247/251 RSC page-test precedent) ──
const {
  mockGetCurrentUser,
  mockRedirect,
  mockLogError,
  mockResolvePortfolioLens,
  mockLoadClientPortfolio,
  mockLoadExpertPortfolio,
  mockLoadAdminPortfolio,
} = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  // redirect() must THROW so control flow stops, exactly like Next.
  mockRedirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
  mockLogError: vi.fn(),
  mockResolvePortfolioLens: vi.fn(),
  mockLoadClientPortfolio: vi.fn(),
  mockLoadExpertPortfolio: vi.fn(),
  mockLoadAdminPortfolio: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('next/navigation', () => ({
  redirect: mockRedirect,
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/lib/logging', () => ({ log: { error: mockLogError } }));

// The lens resolver is pure and has its own unit tests; here we drive the page's
// branch selection by controlling its return value directly.
vi.mock('@/lib/projects-inbox/resolve-portfolio-lens', () => ({
  resolvePortfolioLens: mockResolvePortfolioLens,
}));

// The `server-only` loaders own their own unit/integration coverage; this test
// only asserts WHICH loader the page invokes (and with what arguments).
vi.mock('@/lib/projects-inbox/portfolio-view', () => ({
  loadClientPortfolio: mockLoadClientPortfolio,
  loadExpertPortfolio: mockLoadExpertPortfolio,
  loadAdminPortfolio: mockLoadAdminPortfolio,
}));

// Stub the heavy client children — this stays a unit test of the page's
// orchestration, not a render test of the shell/analytics island (each has its
// own colocated suite).
vi.mock('./_components/projects-inbox-shell', () => ({
  ProjectsInboxShell: ({ dto }: { dto: PortfolioDTO | AdminPortfolioDTO }) => (
    <div data-testid="inbox-shell" data-lens={dto.lens} />
  ),
}));
vi.mock('./_components/projects-inbox-analytics', () => ({
  ProjectsInboxAnalytics: ({ lens }: { lens: PortfolioLens }) => (
    <div data-testid="inbox-analytics" data-lens={lens} />
  ),
}));

import ProjectsPage from './page';

const COMPANY_ID = 'company-1';
const EXPERT_PROFILE_ID = 'expert-1';

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-x',
    email: 'x@example.com',
    firstName: 'X',
    lastName: 'Y',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'user',
    companyId: COMPANY_ID,
    companyName: 'Northwind Industrial',
    companyRole: 'owner',
    ...overrides,
  };
}

function clientDto(allowedLenses: PortfolioLens[] = ['client']): PortfolioDTO {
  return {
    lens: 'client',
    allowedLenses,
    rows: [],
    tiles: { needs: 0, inProgress: 0, kicked: 0, total: 0 },
    isEmpty: true,
  };
}

function expertDto(allowedLenses: PortfolioLens[] = ['client', 'expert']): PortfolioDTO {
  return {
    lens: 'expert',
    allowedLenses,
    rows: [],
    tiles: { needs: 0, inProgress: 0, kicked: 0, total: 0 },
    isEmpty: true,
  };
}

function adminDto(allowedLenses: PortfolioLens[] = ['client', 'admin']): AdminPortfolioDTO {
  return {
    lens: 'admin',
    allowedLenses,
    triage: [],
    kanban: [],
    tiles: { untriaged: 0, stalled: 0, pipeline: 0, gate: 0 },
    isEmpty: true,
  };
}

function resolved(lens: PortfolioLens, allowedLenses: PortfolioLens[]): ResolvedPortfolioLens {
  return { lens, allowedLenses };
}

async function renderPage(lens?: string) {
  const ui = await ProjectsPage({ searchParams: Promise.resolve({ lens }) });
  return render(ui);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ProjectsPage (RSC) — auth gate', () => {
  it('redirects to /login when there is no current user (and loads nothing)', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith('/login');
    // No lens resolution and no portfolio load for an unauthenticated visitor.
    expect(mockResolvePortfolioLens).not.toHaveBeenCalled();
    expect(mockLoadClientPortfolio).not.toHaveBeenCalled();
    expect(mockLoadExpertPortfolio).not.toHaveBeenCalled();
    expect(mockLoadAdminPortfolio).not.toHaveBeenCalled();
  });
});

describe('ProjectsPage (RSC) — lens → loader dispatch', () => {
  it('loads ONLY the client portfolio for the client lens', async () => {
    const viewer = user();
    mockGetCurrentUser.mockResolvedValue(viewer);
    mockResolvePortfolioLens.mockReturnValue(resolved('client', ['client']));
    mockLoadClientPortfolio.mockResolvedValue(clientDto());

    await renderPage();

    // The raw `?lens=` is forwarded to the resolver untouched.
    expect(mockResolvePortfolioLens).toHaveBeenCalledWith(viewer, undefined);
    expect(mockLoadClientPortfolio).toHaveBeenCalledTimes(1);
    expect(mockLoadClientPortfolio).toHaveBeenCalledWith(viewer, ['client']);
    expect(mockLoadExpertPortfolio).not.toHaveBeenCalled();
    expect(mockLoadAdminPortfolio).not.toHaveBeenCalled();
    // The shell renders with the resolved lens's DTO.
    expect(screen.getByTestId('inbox-shell')).toHaveAttribute('data-lens', 'client');
  });

  it('forwards an explicit allowed ?lens= and loads the expert portfolio', async () => {
    const viewer = user({ expertProfileId: EXPERT_PROFILE_ID, activeMode: 'expert' });
    mockGetCurrentUser.mockResolvedValue(viewer);
    mockResolvePortfolioLens.mockReturnValue(resolved('expert', ['client', 'expert']));
    mockLoadExpertPortfolio.mockResolvedValue(expertDto());

    await renderPage('expert');

    expect(mockResolvePortfolioLens).toHaveBeenCalledWith(viewer, 'expert');
    expect(mockLoadExpertPortfolio).toHaveBeenCalledTimes(1);
    // The expert loader receives a viewer narrowed to a concrete expertProfileId.
    expect(mockLoadExpertPortfolio).toHaveBeenCalledWith(
      expect.objectContaining({ expertProfileId: EXPERT_PROFILE_ID }),
      ['client', 'expert']
    );
    expect(mockLoadClientPortfolio).not.toHaveBeenCalled();
    expect(mockLoadAdminPortfolio).not.toHaveBeenCalled();
    expect(screen.getByTestId('inbox-shell')).toHaveAttribute('data-lens', 'expert');
  });

  it('falls back to the client loader when the expert lens lacks an expert profile', async () => {
    // Defensive seam: resolver says 'expert' but the user has no expertProfileId,
    // so the page's `&& user.expertProfileId !== undefined` guard routes to client.
    const viewer = user();
    mockGetCurrentUser.mockResolvedValue(viewer);
    mockResolvePortfolioLens.mockReturnValue(resolved('expert', ['client', 'expert']));
    mockLoadClientPortfolio.mockResolvedValue(clientDto(['client', 'expert']));

    await renderPage('expert');

    expect(mockLoadClientPortfolio).toHaveBeenCalledWith(viewer, ['client', 'expert']);
    expect(mockLoadExpertPortfolio).not.toHaveBeenCalled();
  });

  it('loads ONLY the admin portfolio for the admin lens', async () => {
    const viewer = user({ platformRole: 'admin' });
    mockGetCurrentUser.mockResolvedValue(viewer);
    mockResolvePortfolioLens.mockReturnValue(resolved('admin', ['client', 'admin']));
    mockLoadAdminPortfolio.mockResolvedValue(adminDto());

    await renderPage('admin');

    expect(mockResolvePortfolioLens).toHaveBeenCalledWith(viewer, 'admin');
    expect(mockLoadAdminPortfolio).toHaveBeenCalledTimes(1);
    // The admin loader takes only the allowedLenses (platform-wide; no per-user arg).
    expect(mockLoadAdminPortfolio).toHaveBeenCalledWith(['client', 'admin']);
    expect(mockLoadClientPortfolio).not.toHaveBeenCalled();
    expect(mockLoadExpertPortfolio).not.toHaveBeenCalled();
    expect(screen.getByTestId('inbox-shell')).toHaveAttribute('data-lens', 'admin');
  });

  it('falls back to the default lens when ?lens= is out of bounds (resolver decides)', async () => {
    // An out-of-bounds ?lens= is forwarded verbatim; the resolver returns the
    // default. The page must honour the RESOLVED lens, not the raw param.
    const viewer = user();
    mockGetCurrentUser.mockResolvedValue(viewer);
    mockResolvePortfolioLens.mockReturnValue(resolved('client', ['client']));
    mockLoadClientPortfolio.mockResolvedValue(clientDto());

    await renderPage('admin'); // not allowed for a plain user

    expect(mockResolvePortfolioLens).toHaveBeenCalledWith(viewer, 'admin');
    expect(mockLoadClientPortfolio).toHaveBeenCalledTimes(1);
    expect(mockLoadAdminPortfolio).not.toHaveBeenCalled();
    expect(mockLoadExpertPortfolio).not.toHaveBeenCalled();
  });

  it('renders both the analytics island and the shell on success', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockResolvePortfolioLens.mockReturnValue(resolved('client', ['client']));
    mockLoadClientPortfolio.mockResolvedValue(clientDto());

    await renderPage();

    expect(screen.getByTestId('inbox-analytics')).toHaveAttribute('data-lens', 'client');
    expect(screen.getByTestId('inbox-shell')).toBeInTheDocument();
    expect(mockLogError).not.toHaveBeenCalled();
  });
});

describe('ProjectsPage (RSC) — load error boundary', () => {
  it('logs an error with {userId, lens} and rethrows (to error.tsx) when the load throws', async () => {
    const viewer = user();
    mockGetCurrentUser.mockResolvedValue(viewer);
    mockResolvePortfolioLens.mockReturnValue(resolved('client', ['client']));
    mockLoadClientPortfolio.mockRejectedValue(new Error('db down'));

    await expect(renderPage()).rejects.toThrow('db down');
    expect(mockLogError).toHaveBeenCalledWith(
      'Failed to load projects inbox',
      expect.objectContaining({ userId: viewer.id, lens: 'client' })
    );
    // The shell must never render when the load fails.
    expect(screen.queryByTestId('inbox-shell')).not.toBeInTheDocument();
  });

  it('captures the admin lens in the error context when the admin load throws', async () => {
    const viewer = user({ platformRole: 'admin' });
    mockGetCurrentUser.mockResolvedValue(viewer);
    mockResolvePortfolioLens.mockReturnValue(resolved('admin', ['client', 'admin']));
    mockLoadAdminPortfolio.mockRejectedValue(new Error('boom'));

    await expect(renderPage('admin')).rejects.toThrow('boom');
    expect(mockLogError).toHaveBeenCalledWith(
      'Failed to load projects inbox',
      expect.objectContaining({ userId: viewer.id, lens: 'admin' })
    );
  });
});
