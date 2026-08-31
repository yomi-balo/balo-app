import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SessionUser } from '@/lib/auth/session';
import type { NavContext } from '@/components/layout/nav-registry';

/**
 * BAL-499 F1 — the credits-chip gate site (`(dashboard)/layout.tsx:68-73`) had NO test.
 * `creditsChipIsInScope` has exactly one production caller and that call site was unasserted;
 * `credits-chip-server-gated.test.ts` only scans `components/layout/**`, so it never sees this
 * file, `top-nav.test.tsx` only proves `TopNav` adds nothing of its own, and the D7 switch test
 * only proves the predicate. THIS is the test that proves the wiring at the actual call site.
 *
 * Proof this matters: moving the workspace-scope check to evaluate INSIDE the `<Suspense>`
 * boundary (rather than gating whether `<Suspense>` is even constructed) leaves an expert
 * workspace's real `loadTopBarWalletData` read invoked and its `<Suspense>` fallback painted —
 * the exact hydration flash the AC forbids — while every other existing test stays green. See
 * the two assertions below marked "F1 PROOF".
 */

const mockGetCurrentUser = vi.fn<() => Promise<SessionUser | null>>();
const mockBuildNavContext = vi.fn<(user: SessionUser | null) => Promise<NavContext>>();
const mockLoadTopBarWalletData = vi.fn();

vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

vi.mock('@/lib/auth/session-sync', () => ({
  checkSessionDrift: () => Promise.resolve({ action: 'ok' }),
}));

vi.mock('@/lib/actions/expert-checklist', () => ({
  getChecklistStatus: () => Promise.resolve({ completedCount: 2, allComplete: false }),
}));

vi.mock('@/lib/navigation/nav-context', () => ({
  buildNavContext: (user: SessionUser | null) => mockBuildNavContext(user),
}));

vi.mock('@/lib/credit/wallet-read', () => ({
  loadTopBarWalletData: (...args: unknown[]) => mockLoadTopBarWalletData(...args),
}));

// BAL-499 F1 fix — `layout.tsx:61` awaits `getWorkspacesForCurrentUser()`, which reaches
// `deriveWorkspacesForUser` → `usersRepository.findForSessionSync` → a REAL `db.select`.
// Unmocked, both tests in this file died with "Cannot read properties of undefined (reading
// 'select')" before reaching a single assertion — `db` is undefined under vitest. The layout's
// own comment promises `[]` "when there is no session user or nothing is derivable", but that
// contract only covers a null user; it does not survive an absent client.
//
// The switcher's list is irrelevant to the credits-chip gate under test here, so it is stubbed
// flat, alongside every other collaborator this file already mocks.
vi.mock('@/lib/workspaces/get-workspaces', () => ({
  getWorkspacesForCurrentUser: () => Promise.resolve([]),
}));

vi.mock('@/components/layout/sidebar', () => ({
  Sidebar: () => <div data-testid="sidebar-stub" />,
}));

vi.mock('@/components/layout/mobile-tab-bar', () => ({
  MobileTabBar: () => null,
}));

vi.mock('@/components/balo/notification-bell', () => ({
  NotificationBell: () => <div data-testid="notification-bell" />,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  redirect: vi.fn(),
  // ⚠ REQUIRED — this file renders the REAL `TopNav`, and BAL-500's ⌘K palette inside it calls
  // `useRouter()`. Without this the render throws before the first assertion.
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// The palette's `useWorkspaceSwitch` value-imports this `'use server'` module. `@/hooks/use-mobile`
// deliberately gets NO stub: BAL-501 removed the hamburger from `top-nav.tsx`, and the only
// remaining consumer (`MobileTabBar`) is already replaced wholesale by the stub above.
vi.mock('@/lib/auth/actions/switch-workspace', () => ({ switchWorkspaceAction: vi.fn() }));

import DashboardLayout from './layout';

const EXPERT_USER: SessionUser = {
  id: 'user-expert-1',
  email: 'ari@example.com',
  firstName: 'Ari',
  lastName: 'Nguyen',
  avatarUrl: null,
  activeMode: 'expert',
  onboardingCompleted: true,
  platformRole: 'user',
  companyId: 'co-ari-personal',
  companyName: 'Ari Nguyen',
  companyRole: 'owner',
  expertProfileId: 'ep-1',
  verticalId: 'salesforce',
};

const COMPANY_USER: SessionUser = {
  id: 'user-company-1',
  email: 'dana@northwind.example',
  firstName: 'Dana',
  lastName: 'Osei',
  avatarUrl: null,
  activeMode: 'client',
  onboardingCompleted: true,
  platformRole: 'user',
  companyId: 'co-northwind',
  companyName: 'Northwind Industrial',
  companyRole: 'owner',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DashboardLayout — the credits-chip gate (BAL-499 F1)', () => {
  it('an expert workspace renders NEITHER the credits chip NOR its loading skeleton', async () => {
    mockGetCurrentUser.mockResolvedValue(EXPERT_USER);
    mockBuildNavContext.mockResolvedValue({ workspaceType: 'expert', capabilities: [] });
    mockLoadTopBarWalletData.mockResolvedValue({ balanceMinor: 12_300, canTopUp: true });

    const element = await DashboardLayout({ children: <div>page body</div> });
    const { container } = render(element);

    // F1 PROOF (1/2): no skeleton anywhere in the returned tree — not just no resolved chip.
    // A gate that has slipped inside the Suspense boundary paints exactly this for an expert
    // workspace even though the resolved chip itself never appears.
    expect(container.querySelector('.animate-pulse')).toBeNull();
    expect(screen.queryByRole('link', { name: /credits/i })).not.toBeInTheDocument();
    expect(container.textContent).not.toContain('A$');

    // F1 PROOF (2/2): the out-of-scope workspace's server read is never even attempted. A
    // gate moved inside <Suspense> invokes CreditsChipSlot (and this read) unconditionally
    // for any authenticated user, regardless of workspace.
    expect(mockLoadTopBarWalletData).not.toHaveBeenCalled();
  });

  it('a company workspace reaches BOTH the skeleton and the real chip machinery', async () => {
    mockGetCurrentUser.mockResolvedValue(COMPANY_USER);
    mockBuildNavContext.mockResolvedValue({ workspaceType: 'company', capabilities: [] });
    mockLoadTopBarWalletData.mockResolvedValue({ balanceMinor: 12_300, canTopUp: true });

    const element = await DashboardLayout({ children: <div>page body</div> });
    const { container } = render(element);

    // The Suspense fallback paints while the server slot's read is in flight — unlike the
    // expert workspace above, this IS reachable here. (react-dom's client renderer does not
    // retry an async function component's suspension the way Next's RSC runtime does, so the
    // fallback is what this test can observe settle on — `credits-chip-slot.test.tsx` and
    // `credits-chip.test.tsx` separately prove what the read resolves TO; this test's job is
    // only the gate at the call site.)
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
    // …and the gate genuinely let the slot's real read through, with the caller's own
    // session-derived ids (never caller-supplied) — the chip machinery is engaged, not stubbed
    // out.
    expect(mockLoadTopBarWalletData).toHaveBeenCalledWith('user-company-1', 'co-northwind');
  });
});
