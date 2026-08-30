import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { CAPABILITIES } from '@balo/shared/authz';
import type { Workspace } from '@balo/shared/workspaces';
import { EXPERT_WORKSPACE } from '@balo/shared/workspaces';
import { SINGLE_COMPANY_WORKSPACE } from '@/test/fixtures/workspaces';
import type { NavContext } from './nav-registry';

/**
 * BAL-495 — THE PINNING RENDER TEST.
 *
 * Written FIRST, against the CURRENT (unrefactored) sidebar, and confirmed green BEFORE any
 * refactor line lands. After the refactor, every `it()` block, every `renderSidebar({...})`
 * call, and every assertion below must pass UNCHANGED — that identity is the only evidence the
 * nav-registry refactor is behaviour-preserving. Do not edit assertions to make the refactor
 * pass; if this file fails post-refactor, the refactor is wrong.
 *
 * `renderSidebar` builds `sidebarValue` from a SEMANTIC input (`mode`, `canManageCompany`), so
 * after the refactor only its body changes (`canManageCompany` boolean → `navContext: {
 * workspaceType, capabilities }`) — everything else in this file is frozen.
 *
 * ⚠⚠ BAL-496 — INTENTIONAL, TICKET-AUTHORISED UNFREEZE (decision D13). This file declared itself
 * frozen for BAL-495's refactor, and every assertion below is still frozen. What changed, and
 * only this: `renderSidebar` now also supplies `workspaces` + `activeWorkspaceKey`, because
 * `SidebarContent` reads them from the (wholesale-mocked) context and would otherwise render
 * against `undefined`. The default fixture is a SINGLE company workspace on purpose — that is
 * BAL-496's static-label branch, which adds NO new interactive element, so every pre-existing
 * role/label/order assertion below still means what it meant. One `it()` block is ADDED (the
 * AC-5 badge gate); none is edited or removed.
 *
 * ⚠⚠ BAL-503 — a SECOND, TICKET-AUTHORISED UNFREEZE (in the same spirit as BAL-496's D13 above).
 * D1 deliberately CHANGES the client bottom section: `team` narrows to the expert workspace only,
 * and a new `settings` entry (`/settings`) takes its place for the client. Exactly the two
 * `it()` blocks asserting the CLIENT bottom-href arrays are updated below (`'/settings/team'` →
 * `'/settings'`, both the no-manage and can-manage cases — the two are now IDENTICAL, which is
 * the executable evidence that the client bottom section no longer varies by capability). Every
 * other assertion in this file — including both EXPERT bottom-href cases and the mobile drawer
 * fixture (expert mode) — stays frozen with no edit.
 */

// ── Mocks (declared BEFORE the component import — hoisting-safe, top-nav.test.tsx precedent) ──

let sidebarValue: Record<string, unknown>;
let isMobile = false;

vi.mock('./sidebar-context', () => ({
  useSidebar: () => sidebarValue,
}));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobile,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  // BAL-496 fix-round S2 — a multi-workspace fixture renders `WorkspaceMenu`, which calls
  // `useRouter()` (workspace-switcher.test.tsx precedent). Not exercised by any click in this
  // file, but the mock must exist or the render itself throws.
  useRouter: () => ({ refresh: vi.fn() }),
}));

// ⚠ MUST MOCK: user-menu.tsx imports `logoutAction` from the `@/lib/auth/actions` BARREL, which
// re-exports modules that import `@balo/db` → `postgres` in jsdom. Pass children through so the
// user-pill button (and its aria-label) still renders.
vi.mock('./user-menu', () => ({
  UserMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock NotificationBell to avoid fetch calls, per top-nav.test.tsx precedent.
vi.mock('@/components/balo/notification-bell', () => ({
  NotificationBell: () => <div data-testid="notification-bell" />,
}));

import { Sidebar } from './sidebar';
import { TopNav } from './top-nav';

// ── THE ONLY THING THAT MAY CHANGE IN THE REFACTOR (decision 6: renderSidebar's BODY only) ──
function navContextFor(mode: 'client' | 'expert', canManageCompany: boolean): NavContext {
  return {
    workspaceType: mode === 'expert' ? 'expert' : 'company',
    capabilities: canManageCompany ? [CAPABILITIES.MANAGE_MEMBERS] : [],
  };
}

function renderSidebar(opts: {
  mode: 'client' | 'expert';
  canManageCompany: boolean;
  checklistCompletedCount?: number;
  checklistAllComplete?: boolean;
  workspaces?: readonly Workspace[];
  activeWorkspaceKey?: string;
  isCollapsed?: boolean;
}): ReturnType<typeof render> {
  sidebarValue = {
    activeMode: opts.mode,
    userName: 'Jane Doe',
    userInitials: 'JD',
    userAvatarUrl: null,
    checklistCompletedCount: opts.checklistCompletedCount ?? 0,
    checklistAllComplete: opts.checklistAllComplete ?? false,
    navContext: navContextFor(opts.mode, opts.canManageCompany),
    workspaces: opts.workspaces ?? [SINGLE_COMPANY_WORKSPACE],
    activeWorkspaceKey: opts.activeWorkspaceKey ?? SINGLE_COMPANY_WORKSPACE.key,
    isCollapsed: opts.isCollapsed ?? false,
    isMobileOpen: true,
    // Stateful by construction: mutates the module-level `sidebarValue` so a subsequent
    // `rerender(<Sidebar />)` observes the flip. `useSidebar` is mocked as `() => sidebarValue`,
    // so this closure reassigning the outer binding is what makes the collapse toggle testable.
    toggleCollapsed: () => {
      sidebarValue = { ...sidebarValue, isCollapsed: !sidebarValue.isCollapsed };
    },
    setMobileOpen: vi.fn(),
  };
  return render(<Sidebar />);
}

function primaryNav(): HTMLElement {
  return screen.getByRole('navigation');
}

describe('Sidebar (BAL-495 pinning test — pre/post refactor identical)', () => {
  it('renders the top items in exact order for both modes', () => {
    for (const mode of ['client', 'expert'] as const) {
      const { unmount } = renderSidebar({ mode, canManageCompany: false });
      const links = within(primaryNav()).getAllByRole('link');
      expect(links.map((l) => l.textContent?.trim())).toEqual([
        'Dashboard',
        'Consultations',
        'Projects',
        'Messages',
      ]);
      expect(links.map((l) => l.getAttribute('href'))).toEqual([
        '/dashboard',
        '/consultations',
        '/projects',
        '/messages',
      ]);
      unmount();
    }
  });

  it('bottom gating matrix — client, cannot manage company → Settings + Account', () => {
    renderSidebar({ mode: 'client', canManageCompany: false });
    const allLinks = screen.getAllByRole('link');
    const bottomHrefs = allLinks
      .map((l) => l.getAttribute('href'))
      .filter(
        (href) =>
          href && !['/dashboard', '/consultations', '/projects', '/messages', '/'].includes(href)
      );
    expect(bottomHrefs).toEqual(['/settings', '/settings/account']);
  });

  it('bottom gating matrix — client, can manage company → Settings + Account (identical to the no-manage case)', () => {
    renderSidebar({ mode: 'client', canManageCompany: true });
    const allLinks = screen.getAllByRole('link');
    const bottomHrefs = allLinks
      .map((l) => l.getAttribute('href'))
      .filter(
        (href) =>
          href && !['/dashboard', '/consultations', '/projects', '/messages', '/'].includes(href)
      );
    expect(bottomHrefs).toEqual(['/settings', '/settings/account']);
  });

  it('bottom gating matrix — expert, cannot manage company → Expert Settings + Account', () => {
    renderSidebar({ mode: 'expert', canManageCompany: false });
    const allLinks = screen.getAllByRole('link');
    const bottomHrefs = allLinks
      .map((l) => l.getAttribute('href'))
      .filter(
        (href) =>
          href && !['/dashboard', '/consultations', '/projects', '/messages', '/'].includes(href)
      );
    expect(bottomHrefs).toEqual(['/expert/settings', '/settings/account']);
  });

  it('bottom gating matrix — expert, can manage company → Expert Settings + Team + Account', () => {
    renderSidebar({ mode: 'expert', canManageCompany: true });
    const allLinks = screen.getAllByRole('link');
    const bottomHrefs = allLinks
      .map((l) => l.getAttribute('href'))
      .filter(
        (href) =>
          href && !['/dashboard', '/consultations', '/projects', '/messages', '/'].includes(href)
      );
    expect(bottomHrefs).toEqual(['/expert/settings', '/settings/team', '/settings/account']);
  });

  it('checklist badge, incomplete: shows N/5 on the Expert Settings link only', () => {
    renderSidebar({
      mode: 'expert',
      canManageCompany: false,
      checklistCompletedCount: 3,
      checklistAllComplete: false,
    });
    const expertSettingsLink = screen.getByRole('link', { name: /Expert Settings/ });
    expect(within(expertSettingsLink).getByText('3/5')).toBeInTheDocument();

    const dashboardLink = screen.getByRole('link', { name: /^Dashboard/ });
    expect(within(dashboardLink).queryByText('3/5')).not.toBeInTheDocument();
  });

  it('checklist badge, complete: N/5 text is gone, check glyph is present', () => {
    renderSidebar({
      mode: 'expert',
      canManageCompany: false,
      checklistCompletedCount: 5,
      checklistAllComplete: true,
    });
    const expertSettingsLink = screen.getByRole('link', { name: /Expert Settings/ });
    expect(within(expertSettingsLink).queryByText(/\/5/)).not.toBeInTheDocument();
    expect(expertSettingsLink.querySelector('.bg-success\\/10')).toBeInTheDocument();
  });

  it('collapsed path: hides labels and badges, toggle relabels to Expand sidebar', async () => {
    const user = userEvent.setup();
    const { rerender } = renderSidebar({
      mode: 'expert',
      canManageCompany: false,
      checklistCompletedCount: 3,
      checklistAllComplete: false,
    });
    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    rerender(<Sidebar />);

    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
    expect(screen.queryByText('Consultations')).not.toBeInTheDocument();
    expect(screen.queryByText('3/5')).not.toBeInTheDocument();
    // Links still exist (icon-only)
    expect(screen.getAllByRole('link').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
  });

  // BAL-496 fix-round S2 — D10/A1's collapsed-header branch (`sidebar.tsx:107`, `showLogo`) had
  // zero coverage: both suites pinned `isCollapsed: false`. These two cases exercise both arms.
  it('collapsed + multi-workspace: the switcher avatar renders, the Logo mark does not', () => {
    renderSidebar({
      mode: 'client',
      canManageCompany: false,
      isCollapsed: true,
      workspaces: [SINGLE_COMPANY_WORKSPACE, EXPERT_WORKSPACE],
      activeWorkspaceKey: SINGLE_COMPANY_WORKSPACE.key,
    });
    // D10 — the Logo mark yields the collapsed rail to the switcher once there is one.
    expect(document.querySelector('a[href="/"]')).not.toBeInTheDocument();
    // D11 — length >= 2 renders the full dropdown, avatar-only when collapsed.
    expect(screen.getByRole('button', { name: /Switch workspace/ })).toBeInTheDocument();
    expect(screen.queryByText(SINGLE_COMPANY_WORKSPACE.name)).not.toBeInTheDocument();
  });

  it('collapsed + zero workspaces: the Logo mark returns (A1 exception)', () => {
    renderSidebar({
      mode: 'client',
      canManageCompany: false,
      isCollapsed: true,
      workspaces: [],
    });
    expect(document.querySelector('a[href="/"]')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Switch workspace/ })).not.toBeInTheDocument();
  });

  it('mobile drawer renders ALL enabled entries, including Projects', async () => {
    const user = userEvent.setup();
    isMobile = true;
    try {
      sidebarValue = {
        activeMode: 'expert',
        userName: 'Jane Doe',
        userInitials: 'JD',
        userAvatarUrl: null,
        checklistCompletedCount: 0,
        checklistAllComplete: false,
        navContext: navContextFor('expert', true),
        workspaces: [SINGLE_COMPANY_WORKSPACE],
        activeWorkspaceKey: SINGLE_COMPANY_WORKSPACE.key,
        isCollapsed: false,
        isMobileOpen: false,
        toggleCollapsed: vi.fn(),
        setMobileOpen: vi.fn(),
      };

      const { rerender } = render(
        <>
          <TopNav />
          <Sidebar />
        </>
      );

      await user.click(screen.getByRole('button', { name: 'Open navigation menu' }));

      // The mock setMobileOpen doesn't actually flip isMobileOpen, so re-render with it true.
      sidebarValue = { ...sidebarValue, isMobileOpen: true };
      rerender(
        <>
          <TopNav />
          <Sidebar />
        </>
      );

      expect(screen.getByText('Navigation')).toBeInTheDocument();
      const dialog = screen.getByRole('dialog');
      const links = within(dialog).getAllByRole('link');
      const hrefs = links.map((l) => l.getAttribute('href'));
      expect(hrefs).toEqual([
        '/', // the Logo link, also rendered inside SidebarContent
        '/dashboard',
        '/consultations',
        '/projects',
        '/messages',
        '/expert/settings',
        '/settings/team',
        '/settings/account',
      ]);
    } finally {
      isMobile = false;
    }
  });

  it('presentation survivors: expert mode shows Expert badge/subtitle, client mode shows Client', () => {
    const { unmount } = renderSidebar({ mode: 'expert', canManageCompany: false });
    expect(screen.getAllByText('Expert').length).toBeGreaterThan(0);
    unmount();

    renderSidebar({ mode: 'client', canManageCompany: false });
    expect(screen.getByText('Client')).toBeInTheDocument();
  });

  // BAL-496 / D7 — THE AC-5 GATE. The pre-existing assertion above stays GREEN after the badge
  // is deleted, because the user pill still emits the word "Expert" — so the AC had no gate at
  // all. This pins the BADGE, not the word.
  it('AC5: the Logo expert badge no longer renders in expert mode', () => {
    // ⚠ `checklistAllComplete: false` is LOAD-BEARING. `ChecklistBadge`'s all-complete branch
    // uses the SAME `bg-success/10 text-success` pair as the deleted logo badge, so a complete
    // checklist would make the class query below false-positive.
    renderSidebar({ mode: 'expert', canManageCompany: false, checklistAllComplete: false });

    // (a) class gate — nothing carries the deleted badge's exact class pair (`logo.tsx`).
    expect(document.querySelectorAll('.bg-success\\/10.text-success')).toHaveLength(0);

    // (b) structural gate that survives a class rename — the Logo link has no "Expert" inside it.
    const logo = screen.getByRole('link', { name: /balo/i });
    expect(within(logo).queryByText('Expert')).toBeNull();
  });

  it('active state: Dashboard link carries active styling, Projects does not (pathname /dashboard)', () => {
    renderSidebar({ mode: 'client', canManageCompany: false });
    const dashboardLink = screen.getByRole('link', { name: /^Dashboard/ });
    const projectsLink = screen.getByRole('link', { name: /^Projects/ });
    expect(dashboardLink.className).toContain('bg-primary/10');
    expect(projectsLink.className).not.toContain('bg-primary/10');
  });

  // ⚠ Decision rule: if this fails against the UNMODIFIED sidebar, that is a pre-existing a11y
  // defect, out of scope for a pure refactor. Drop this assertion and file a follow-up ticket —
  // do not fix the markup here.
  it('has no accessibility violations', async () => {
    const { container } = renderSidebar({ mode: 'client', canManageCompany: true });
    expect(await axe(container)).toHaveNoViolations();
  });
});
