import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { CAPABILITIES } from '@balo/shared/authz';
import { track, NAV_EVENTS } from '@/lib/analytics';
import { SINGLE_COMPANY_WORKSPACE } from '@/test/fixtures/workspaces';
import type { NavContext } from './nav-registry';

// ── Mocks (declared BEFORE the component import) ────────────────────────────────────────────

let sidebarValue: Record<string, unknown>;
let pathname = '/dashboard';
let isMobile = true;

vi.mock('./sidebar-context', () => ({
  useSidebar: () => sidebarValue,
}));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobile,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

vi.mock('@/lib/auth/actions/switch-workspace', () => ({
  switchWorkspaceAction: vi.fn(),
}));

vi.mock('@/lib/auth/actions/logout', () => ({
  logoutAction: vi.fn(),
}));

import { MobileTabBar } from './mobile-tab-bar';

function navContextFor(workspaceType: 'company' | 'expert', canManage: boolean): NavContext {
  return {
    workspaceType,
    capabilities: canManage ? [CAPABILITIES.MANAGE_MEMBERS] : [],
  };
}

function renderTabBar(opts: {
  workspaceType?: 'company' | 'expert';
  canManage?: boolean;
  checklistCompletedCount?: number;
  checklistAllComplete?: boolean;
}): ReturnType<typeof render> {
  sidebarValue = {
    navContext: navContextFor(opts.workspaceType ?? 'company', opts.canManage ?? false),
    checklistCompletedCount: opts.checklistCompletedCount ?? 0,
    checklistAllComplete: opts.checklistAllComplete ?? false,
    workspaces: [SINGLE_COMPANY_WORKSPACE],
    activeWorkspaceKey: SINGLE_COMPANY_WORKSPACE.key,
    userName: 'Jane Doe',
    userInitials: 'JD',
    userAvatarUrl: null,
  };
  return render(<MobileTabBar />);
}

describe('MobileTabBar (BAL-501)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pathname = '/dashboard';
    isMobile = true;
  });

  it('renders one Link per resolved tab plus a More button, in registry order, for a company workspace', () => {
    renderTabBar({ workspaceType: 'company' });
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/dashboard',
      '/consultations',
      '/messages',
    ]);
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument();
  });

  it('renders one Link per resolved tab plus a More button for an expert workspace', () => {
    renderTabBar({ workspaceType: 'expert' });
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/dashboard',
      '/consultations',
      '/messages',
    ]);
    // Default checklist state (incomplete) puts the rollup dot on the accessible name — match
    // loosely here; the rollup grammar itself is pinned by the dedicated tests below.
    expect(screen.getByRole('button', { name: /More/ })).toBeInTheDocument();
  });

  it('tab labels use shortLabel where present, and label otherwise', () => {
    renderTabBar({ workspaceType: 'company' });
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('Consults')).toBeInTheDocument();
    expect(screen.getByText('Messages')).toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });

  it('pathname "/dashboard" — Dashboard carries aria-current="page"; More is not active', () => {
    pathname = '/dashboard';
    renderTabBar({ workspaceType: 'company' });
    const dashboardLink = screen.getByRole('link', { name: /Home/ });
    expect(dashboardLink).toHaveAttribute('aria-current', 'page');
    const moreLabel = screen.getByText('More');
    expect(moreLabel.className).not.toContain('text-primary');
  });

  it('pathname "/projects" — no tab is active, and More IS active (the demoted-Projects case)', () => {
    pathname = '/projects';
    renderTabBar({ workspaceType: 'company' });
    for (const link of screen.getAllByRole('link')) {
      expect(link).not.toHaveAttribute('aria-current', 'page');
    }
    const moreLabel = screen.getByText('More');
    expect(moreLabel.className).toContain('text-primary');
  });

  /*
   * ⚠ THE REGRESSION PIN for the negated-fallback bug. `moreActive` must be a POSITIVE rule over
   * `moreItems`, never `!tabs.some(...)`. These routes reach a list only via `ENTITY_PARENTS` /
   * `SUPPLEMENTAL_ROUTE_LABELS`, so NO tab prefix-matches them and no More item does either — the
   * honest answer is "nothing lit", matching desktop. Under the old negated rule every one of them
   * lit More while the top bar simultaneously rendered "Back to Consultations".
   */
  it.each([
    ['/cases/abc', 'a case (Consultations via ENTITY_PARENTS)'],
    ['/meetings/abc', 'a meeting (Consultations via ENTITY_PARENTS)'],
    ['/engagements', 'a non-registry route'],
    ['/billing/top-up', 'a supplemental route'],
    ['/promo-codes', 'a supplemental route'],
    ['/redeem', 'a supplemental route'],
  ])('pathname "%s" — %s lights NO tab and NOT More (fails neutral, like desktop)', (path) => {
    pathname = path;
    renderTabBar({ workspaceType: 'company' });
    for (const link of screen.getAllByRole('link')) {
      expect(link).not.toHaveAttribute('aria-current', 'page');
    }
    expect(screen.getByText('More').className).not.toContain('text-primary');
  });

  it('pathname "/settings/account" — a More ITEM being active is what lights More', () => {
    pathname = '/settings/account';
    renderTabBar({ workspaceType: 'company' });
    expect(screen.getByText('More').className).toContain('text-primary');
  });

  it('pathname "/consultations/abc" — Consultations is active via the prefix rule', () => {
    pathname = '/consultations/abc';
    renderTabBar({ workspaceType: 'company' });
    expect(screen.getByRole('link', { name: /Consults/ })).toHaveAttribute('aria-current', 'page');
  });

  it('clicking a tab tracks nav_item_clicked with surface "bottom_tabs"', async () => {
    const user = userEvent.setup();
    renderTabBar({ workspaceType: 'company' });

    await user.click(screen.getByRole('link', { name: /Home/ }));

    expect(track).toHaveBeenCalledWith(NAV_EVENTS.ITEM_CLICKED, {
      item: 'dashboard',
      surface: 'bottom_tabs',
      workspace_type: 'company',
    });
  });

  it('opening the sheet tracks nav_more_opened exactly once; closing emits nothing new', async () => {
    const user = userEvent.setup();
    renderTabBar({ workspaceType: 'company' });

    await user.click(screen.getByRole('button', { name: 'More' }));
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(NAV_EVENTS.MORE_OPENED, { workspace_type: 'company' });

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('rollup dot: expert + incomplete checklist ⇒ dot present, "More, 1 item needs attention"', () => {
    const { container } = renderTabBar({
      workspaceType: 'expert',
      checklistCompletedCount: 3,
      checklistAllComplete: false,
    });
    expect(
      screen.getByRole('button', { name: 'More, 1 item needs attention' })
    ).toBeInTheDocument();
    expect(container.querySelector('.bg-destructive')).not.toBeNull();
  });

  it('rollup dot: expert + complete checklist ⇒ no dot, plain "More"', () => {
    renderTabBar({
      workspaceType: 'expert',
      checklistCompletedCount: 5,
      checklistAllComplete: true,
    });
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /needs attention/ })).not.toBeInTheDocument();
  });

  it('rollup dot: company workspace ⇒ no dot regardless of checklist state', () => {
    const incomplete = renderTabBar({
      workspaceType: 'company',
      checklistCompletedCount: 0,
      checklistAllComplete: false,
    });
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument();
    expect(incomplete.container.querySelector('.bg-destructive')).toBeNull();
    incomplete.unmount();

    const complete = renderTabBar({
      workspaceType: 'company',
      checklistCompletedCount: 5,
      checklistAllComplete: true,
    });
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument();
    expect(complete.container.querySelector('.bg-destructive')).toBeNull();
  });

  it('<nav> carries aria-label "Primary" and the sticky/z-40/lg:hidden classes', () => {
    renderTabBar({ workspaceType: 'company' });
    const nav = screen.getByLabelText('Primary');
    expect(nav.className).toContain('sticky');
    expect(nav.className).toContain('bottom-0');
    expect(nav.className).toContain('z-40');
    expect(nav.className).toContain('lg:hidden');
  });

  it('has no accessibility violations, closed', async () => {
    const { baseElement } = renderTabBar({ workspaceType: 'company' });
    // 'region' and 'page-has-heading-one' are page-level rules, inapplicable to an isolated tab bar.
    const results = await axe(baseElement, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });

  it('has no accessibility violations, open', async () => {
    const user = userEvent.setup();
    const { baseElement } = renderTabBar({ workspaceType: 'company' });
    await user.click(screen.getByRole('button', { name: 'More' }));
    const results = await axe(baseElement, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });

  it('D19 — crossing to desktop closes an open sheet', async () => {
    const user = userEvent.setup();
    const { rerender } = renderTabBar({ workspaceType: 'company' });
    await user.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    isMobile = false;
    rerender(<MobileTabBar />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
