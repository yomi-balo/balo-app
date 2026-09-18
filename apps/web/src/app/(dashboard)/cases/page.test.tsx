import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';

vi.mock('server-only', () => ({}));

/**
 * ⚠ `redirect()` THROWS in Next. Mocking it as a throwing sentinel is what makes the control flow
 * genuinely pinned: a page that called `redirect()` and then carried on rendering would pass a
 * mock that merely recorded the call.
 */
const redirectError = new Error('NEXT_REDIRECT');
const mockRedirect = vi.fn();
vi.mock('next/navigation', () => ({
  redirect: (...a: unknown[]) => {
    mockRedirect(...a);
    throw redirectError;
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => '/cases',
}));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: () => mockGetCurrentUser() }));

const mockBuildNavContext = vi.fn();
vi.mock('@/lib/navigation/nav-context', () => ({
  buildNavContext: (...a: unknown[]) => mockBuildNavContext(...a),
}));

const mockResolveEntityListNavEntry = vi.fn();
vi.mock('@/components/layout/nav-registry', () => ({
  resolveEntityListNavEntry: (...a: unknown[]) => mockResolveEntityListNavEntry(...a),
}));

const mockResolveCasesIndexRequest = vi.fn();
const mockLoadCasesIndex = vi.fn();
vi.mock('./_lib/load-cases-index', () => ({
  resolveCasesIndexRequest: (...a: unknown[]) => mockResolveCasesIndexRequest(...a),
  loadCasesIndex: (...a: unknown[]) => mockLoadCasesIndex(...a),
}));

const mockReadCasesIndexData = vi.fn();
vi.mock('./_lib/read-cases-index-data', () => ({
  readCasesIndexData: (...a: unknown[]) => mockReadCasesIndexData(...a),
}));

import CasesPage, { metadata } from './page';

/**
 * BAL-567 — the `/cases` Server Component: the two redirects, the nav-resolved title, and the
 * log context it hands the catch boundary.
 */

const USER = { id: 'user-1', companyId: 'co-1', companyName: 'Acme Corp' };
const COMPANY_REQUEST = { side: 'company', companyId: 'co-1', companyName: 'Acme Corp' };
const EXPERT_REQUEST = { side: 'expert', expertProfileId: 'ep-1', companyName: 'Acme Corp' };

const ERROR_DATA = { kind: 'error' as const };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue(USER);
  mockBuildNavContext.mockResolvedValue({ workspaceType: 'company', capabilities: [] });
  mockResolveEntityListNavEntry.mockReturnValue({ key: 'cases', label: 'Cases', href: '/cases' });
  mockResolveCasesIndexRequest.mockReturnValue(COMPANY_REQUEST);
  mockReadCasesIndexData.mockResolvedValue(ERROR_DATA);
});

describe('CasesPage — the gates', () => {
  it('sends an unauthenticated visitor to /login, and reads NOTHING', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(CasesPage()).rejects.toThrow(redirectError);
    expect(mockRedirect).toHaveBeenCalledWith('/login');
    expect(mockReadCasesIndexData).not.toHaveBeenCalled();
  });

  /**
   * ⚠ `/dashboard`, NOT `/login` — the session IS valid, it simply has no expert profile.
   * Unified with `expert/calendar/page.tsx` so two surfaces cannot send the same session to two
   * different destinations.
   */
  it('sends an expert-mode session with no profile to /dashboard', async () => {
    mockResolveCasesIndexRequest.mockReturnValue(null);
    await expect(CasesPage()).rejects.toThrow(redirectError);
    expect(mockRedirect).toHaveBeenCalledWith('/dashboard');
    expect(mockReadCasesIndexData).not.toHaveBeenCalled();
  });
});

describe('CasesPage — the render', () => {
  it('reads through the catch boundary, with the SESSION’s own request', async () => {
    render(await CasesPage());

    expect(mockReadCasesIndexData).toHaveBeenCalledTimes(1);
    const [read, logContext] = mockReadCasesIndexData.mock.calls[0] ?? [];
    expect(typeof read).toBe('function');
    // IDS AND LABELS ONLY — never a case title or anything a customer wrote.
    expect(logContext).toEqual({ workspaceType: 'company', companyId: 'co-1' });

    await (read as () => Promise<unknown>)();
    expect(mockLoadCasesIndex).toHaveBeenCalledWith({
      viewerUserId: 'user-1',
      request: COMPANY_REQUEST,
    });
  });

  it('logs the EXPERT arm under its own id, never a companyId it does not scope by', async () => {
    mockResolveCasesIndexRequest.mockReturnValue(EXPERT_REQUEST);
    render(await CasesPage());
    const [, logContext] = mockReadCasesIndexData.mock.calls[0] ?? [];
    expect(logContext).toEqual({ workspaceType: 'expert', expertProfileId: 'ep-1' });
  });

  /**
   * ⚠ THE TITLE COMES FROM THE LIVE NAV ENTRY, never a literal — so a future rename moves the
   * top bar's crumb and this page's `<h2>` together.
   */
  it('takes its heading from the nav registry', async () => {
    mockResolveEntityListNavEntry.mockReturnValue({
      key: 'cases',
      label: 'Consultations',
      href: '/cases',
    });
    render(await CasesPage());
    expect(mockResolveEntityListNavEntry).toHaveBeenCalledWith(
      { workspaceType: 'company', capabilities: [] },
      'cases'
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Consultations' })).toBeInTheDocument();
  });

  it('falls back to "Cases" when the nav entry is not resolvable', async () => {
    mockResolveEntityListNavEntry.mockReturnValue(undefined);
    render(await CasesPage());
    expect(screen.getByRole('heading', { level: 2, name: 'Cases' })).toBeInTheDocument();
  });

  it('renders NO second h1 — BAL-499 owns the one in the top bar', async () => {
    render(await CasesPage());
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });
});

describe('CasesPage — metadata', () => {
  it('titles the tab and keeps the surface out of search indexes', () => {
    expect(metadata.title).toBe('Cases — Balo');
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
