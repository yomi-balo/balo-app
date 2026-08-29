import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { CAPABILITIES } from '@balo/shared/authz';
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
}): ReturnType<typeof render> {
  sidebarValue = {
    activeMode: opts.mode,
    userName: 'Jane Doe',
    userInitials: 'JD',
    userAvatarUrl: null,
    checklistCompletedCount: opts.checklistCompletedCount ?? 0,
    checklistAllComplete: opts.checklistAllComplete ?? false,
    navContext: navContextFor(opts.mode, opts.canManageCompany),
    isCollapsed: false,
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

  it('bottom gating matrix — client, cannot manage company → Account only', () => {
    renderSidebar({ mode: 'client', canManageCompany: false });
    const allLinks = screen.getAllByRole('link');
    const bottomHrefs = allLinks
      .map((l) => l.getAttribute('href'))
      .filter(
        (href) =>
          href && !['/dashboard', '/consultations', '/projects', '/messages', '/'].includes(href)
      );
    expect(bottomHrefs).toEqual(['/settings/account']);
  });

  it('bottom gating matrix — client, can manage company → Team + Account', () => {
    renderSidebar({ mode: 'client', canManageCompany: true });
    const allLinks = screen.getAllByRole('link');
    const bottomHrefs = allLinks
      .map((l) => l.getAttribute('href'))
      .filter(
        (href) =>
          href && !['/dashboard', '/consultations', '/projects', '/messages', '/'].includes(href)
      );
    expect(bottomHrefs).toEqual(['/settings/team', '/settings/account']);
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
