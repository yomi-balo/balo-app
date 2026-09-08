import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { SessionUser } from '@/lib/auth/session';
import RootLayout from './layout';

// `next/font/local` needs a bundler-specific loader for the `.woff` imports in `layout.tsx`;
// under plain Vitest it is stubbed to a fixed CSS variable string, the pattern Next's own
// testing docs recommend for `next/font`.
vi.mock('next/font/local', () => ({
  default: () => ({ variable: 'mock-font-variable' }),
}));

const { mockGetCurrentUser } = vi.hoisted(() => ({ mockGetCurrentUser: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));

/**
 * BAL-553 fix round 1, B1 — `Providers` is stubbed so this test asserts what the LAYOUT actually
 * PASSES DOWN (the `(marketing)/layout.test.tsx` precedent for the same technique). The real
 * `Providers` tree (ThemeProvider/QueryProvider/PostHogProvider/AuthModalProvider) is exercised
 * elsewhere; this file is about the wiring, not the providers' own behaviour.
 */
// Neither `Toaster` (reads `window.matchMedia`, unavailable in jsdom) nor `AppFooter` (its own
// unrelated concern, `apps/web/src/components/layout/app-footer.tsx`) has anything to do with
// B1's suppression wiring — stubbed out so this file stays about `Providers`' props only.
vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }));
vi.mock('@/components/layout/app-footer', () => ({ AppFooter: () => null }));

vi.mock('@/components/providers', () => ({
  Providers: ({
    userId,
    userTraitsJson,
    children,
  }: {
    userId?: string;
    userTraitsJson?: string;
    children: React.ReactNode;
  }) => (
    <div
      data-testid="providers"
      data-user-id={userId ?? '__undefined__'}
      data-user-traits={userTraitsJson ?? '__undefined__'}
    >
      {children}
    </div>
  ),
}));

function makeSessionUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-1',
    email: 'dana@northwind.test',
    firstName: 'Dana',
    lastName: 'Okoro',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'user',
    companyId: 'company-1',
    companyName: 'Northwind Industrial',
    companyRole: 'owner',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * BAL-553 fix round 1, B1 — before this test existed, reverting
 * `userId={analyticsUserId}` back to `userId={user?.id}` (the pre-BAL-553 line) failed NO test
 * anywhere in the suite; `layout.tsx` is the only production behaviour change in the whole ticket
 * with zero coverage, and ruling OQ2 made the suppression mandatory in THIS PR. Mutation-tested:
 * reverting the suppression in `layout.tsx` makes the first `it` below fail.
 */
describe('RootLayout — BAL-553 analytics identify suppression under impersonation', () => {
  it('passes userId AND userTraitsJson as undefined for an impersonated session', async () => {
    mockGetCurrentUser.mockResolvedValue(
      makeSessionUser({ id: 'target-1', isImpersonating: true, impersonatorUserId: 'admin-1' })
    );

    const ui = await RootLayout({ children: <p>Body</p> });
    render(ui);

    expect(screen.getByText('Body')).toBeInTheDocument();
    const providers = screen.getByTestId('providers');
    expect(providers.dataset.userId).toBe('__undefined__');
    expect(providers.dataset.userTraits).toBe('__undefined__');
  });

  it('passes the real userId and userTraitsJson for a normal (non-impersonated) session', async () => {
    mockGetCurrentUser.mockResolvedValue(makeSessionUser());

    const ui = await RootLayout({ children: <p>Body</p> });
    render(ui);

    const providers = screen.getByTestId('providers');
    expect(providers.dataset.userId).toBe('user-1');
    expect(providers.dataset.userTraits).toBe(
      JSON.stringify({
        email: 'dana@northwind.test',
        active_mode: 'client',
        platform_role: 'user',
      })
    );
  });

  it('passes undefined userId/userTraitsJson when there is no session at all', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const ui = await RootLayout({ children: <p>Body</p> });
    render(ui);

    const providers = screen.getByTestId('providers');
    expect(providers.dataset.userId).toBe('__undefined__');
    expect(providers.dataset.userTraits).toBe('__undefined__');
  });

  it('degrades to no session (not a crash) when getCurrentUser() rejects', async () => {
    mockGetCurrentUser.mockRejectedValue(new Error('WORKOS_COOKIE_PASSWORD missing'));

    const ui = await RootLayout({ children: <p>Body</p> });
    render(ui);

    expect(screen.getByText('Body')).toBeInTheDocument();
    const providers = screen.getByTestId('providers');
    expect(providers.dataset.userId).toBe('__undefined__');
  });
});
