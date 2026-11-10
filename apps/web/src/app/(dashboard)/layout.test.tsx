import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
const mockLoadViewerTimezoneContext = vi.fn();
const { mockRedirect } = vi.hoisted(() => ({ mockRedirect: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

const mockCheckSessionDrift = vi.fn<() => Promise<{ action: 'ok' | 'sync-needed' }>>();
vi.mock('@/lib/auth/session-sync', () => ({
  checkSessionDrift: () => mockCheckSessionDrift(),
}));

vi.mock('@/components/layout/session-sync-redirect', () => ({
  SessionSyncRedirect: () => <div data-testid="session-sync-redirect" />,
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

vi.mock('@/lib/timezone/load-viewer-timezone-context', () => ({
  loadViewerTimezoneContext: (...args: unknown[]) => mockLoadViewerTimezoneContext(...args),
}));

vi.mock('@/components/balo/date/viewer-timezone-context', () => ({
  ViewerTimezoneProvider: ({
    savedTimezone,
    children,
  }: {
    savedTimezone: string | null;
    children: React.ReactNode;
  }) => (
    <div data-testid="viewer-timezone-provider" data-saved-timezone={savedTimezone ?? ''}>
      {children}
    </div>
  ),
}));

vi.mock('@/components/balo/timezone-mismatch/timezone-mismatch-gate', () => ({
  TimezoneMismatchGate: ({ mismatchPrompt }: { mismatchPrompt: { expertProfileId: string } }) => (
    <div data-testid="timezone-mismatch-gate" data-expert={mismatchPrompt.expertProfileId} />
  ),
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

// BAL-504 — a spy, not a DOM marker: real props carry the session email, and this file's
// fixtures are stand-ins for real users, so nothing here needs it rendered to the DOM.
const { mockAnalyticsIdentify } = vi.hoisted(() => ({ mockAnalyticsIdentify: vi.fn() }));
vi.mock('@/components/providers/analytics-identify', () => ({
  AnalyticsIdentify: (props: Record<string, unknown>) => {
    mockAnalyticsIdentify(props);
    return null;
  },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  redirect: mockRedirect,
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

const APPLICANT_USER: SessionUser = {
  ...COMPANY_USER,
  id: 'user-applicant-1',
  companyId: 'co-applicant-personal',
  companyName: 'Applicant Person',
  expertProfileId: 'ep-pending',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadViewerTimezoneContext.mockResolvedValue({ savedTimezone: null, mismatchPrompt: null });
  mockCheckSessionDrift.mockResolvedValue({ action: 'ok' });
});

describe('DashboardLayout — session drift', () => {
  it('hard-navigates via SessionSyncRedirect instead of redirect(), with no chrome', async () => {
    mockCheckSessionDrift.mockResolvedValue({ action: 'sync-needed' });

    const element = await DashboardLayout({ children: <div data-testid="child-sentinel" /> });
    render(element);

    expect(screen.getByTestId('session-sync-redirect')).toBeInTheDocument();
    expect(screen.queryByTestId('child-sentinel')).not.toBeInTheDocument();
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockGetCurrentUser).not.toHaveBeenCalled();
    expect(mockLoadViewerTimezoneContext).not.toHaveBeenCalled();
  });

  it('renders children for a pending applicant (client mode, expertProfileId set)', async () => {
    mockGetCurrentUser.mockResolvedValue(APPLICANT_USER);
    mockBuildNavContext.mockResolvedValue({ workspaceType: 'company', capabilities: [] });

    const element = await DashboardLayout({ children: <div data-testid="child-sentinel" /> });
    const { container } = render(element);

    expect(container.querySelector('main')).toContainElement(screen.getByTestId('child-sentinel'));
    expect(screen.queryByTestId('session-sync-redirect')).not.toBeInTheDocument();
  });
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

describe('DashboardLayout — analytics identify placement (BAL-504)', () => {
  it('passes the projected identify props for a normal user', async () => {
    mockGetCurrentUser.mockResolvedValue(COMPANY_USER);
    mockBuildNavContext.mockResolvedValue({ workspaceType: 'company', capabilities: [] });

    const element = await DashboardLayout({ children: <div>page body</div> });
    render(element);

    expect(mockAnalyticsIdentify).toHaveBeenCalledWith({
      userId: 'user-company-1',
      userTraitsJson: JSON.stringify({
        email: 'dana@northwind.example',
        active_mode: 'client',
        platform_role: 'user',
      }),
    });
  });

  it('passes {} for an impersonated session', async () => {
    mockGetCurrentUser.mockResolvedValue({
      ...COMPANY_USER,
      isImpersonating: true,
      impersonatorUserId: 'admin-1',
    });
    mockBuildNavContext.mockResolvedValue({ workspaceType: 'company', capabilities: [] });

    const element = await DashboardLayout({ children: <div>page body</div> });
    render(element);

    expect(mockAnalyticsIdentify).toHaveBeenCalledWith({});
  });
});

describe('DashboardLayout — timezone context (BAL-634)', () => {
  const PROMPT = {
    expertProfileId: 'ep-1',
    scheduleTimezone: 'Australia/Sydney',
    commonRange: { startTime: '09:00', endTime: '17:00' },
  };

  it('wraps the page in the provider with the saved zone and mounts no gate for a client', async () => {
    mockGetCurrentUser.mockResolvedValue(COMPANY_USER);
    mockBuildNavContext.mockResolvedValue({ workspaceType: 'company', capabilities: [] });
    mockLoadViewerTimezoneContext.mockResolvedValue({
      savedTimezone: 'Australia/Sydney',
      mismatchPrompt: null,
    });

    const element = await DashboardLayout({ children: <div>page body</div> });
    render(element);

    const provider = screen.getByTestId('viewer-timezone-provider');
    expect(provider).toHaveAttribute('data-saved-timezone', 'Australia/Sydney');
    expect(provider).toContainElement(screen.getByText('page body'));
    expect(screen.queryByTestId('timezone-mismatch-gate')).not.toBeInTheDocument();
    expect(mockLoadViewerTimezoneContext).toHaveBeenCalledWith(COMPANY_USER);
  });

  it('mounts the gate for an eligible expert', async () => {
    mockGetCurrentUser.mockResolvedValue(EXPERT_USER);
    mockBuildNavContext.mockResolvedValue({ workspaceType: 'expert', capabilities: [] });
    mockLoadViewerTimezoneContext.mockResolvedValue({
      savedTimezone: 'Australia/Sydney',
      mismatchPrompt: PROMPT,
    });

    const element = await DashboardLayout({ children: <div>page body</div> });
    render(element);

    expect(screen.getByTestId('timezone-mismatch-gate')).toHaveAttribute('data-expert', 'ep-1');
  });

  it('mounts the gate in the client workspace too, because activeMode never decides it', async () => {
    mockGetCurrentUser.mockResolvedValue({ ...EXPERT_USER, activeMode: 'client' });
    mockBuildNavContext.mockResolvedValue({ workspaceType: 'company', capabilities: [] });
    mockLoadViewerTimezoneContext.mockResolvedValue({
      savedTimezone: 'Australia/Sydney',
      mismatchPrompt: PROMPT,
    });

    const element = await DashboardLayout({ children: <div>page body</div> });
    render(element);

    expect(screen.getByTestId('timezone-mismatch-gate')).toBeInTheDocument();
  });

  it('reads nothing and renders no provider value without a session user', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockBuildNavContext.mockResolvedValue({ workspaceType: 'company', capabilities: [] });

    const element = await DashboardLayout({ children: <div>page body</div> });
    render(element);

    expect(mockLoadViewerTimezoneContext).not.toHaveBeenCalled();
    expect(screen.getByTestId('viewer-timezone-provider')).toHaveAttribute(
      'data-saved-timezone',
      ''
    );
    expect(screen.queryByTestId('timezone-mismatch-gate')).not.toBeInTheDocument();
  });
});

describe('timezone gate placement (BAL-634)', () => {
  const appDir = join(__dirname, '..');

  it('the call page and the lobby live outside the dashboard layout', () => {
    expect(existsSync(join(appDir, '(call)/meetings/[meetingId]/call/page.tsx'))).toBe(true);
    expect(existsSync(join(appDir, 'join/m/[meetingId]/lobby-client.tsx'))).toBe(true);
  });

  it('nothing under the dashboard layout is a call surface', () => {
    const dashboardDir = __dirname;
    const callDirs: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'node_modules') continue;
        if (entry.name === 'call') callDirs.push(join(dir, entry.name));
        walk(join(dir, entry.name));
      }
    };
    walk(dashboardDir);
    expect(callDirs).toEqual([]);
  });
});
