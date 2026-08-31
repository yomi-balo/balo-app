import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { CAPABILITIES } from '@balo/shared/authz';
import { SINGLE_COMPANY_WORKSPACE } from '@/test/fixtures/workspaces';
import type { NavContext } from './nav-registry';

/**
 * BAL-497 — ALL new sidebar behaviour asserted through the real `<Sidebar />`: jump-out affordance
 * + accessible name, `prefetch={false}`, label max-width/opacity motion, collapsed a11y, the rail's
 * retuned reduced-motion transition, and the pill following `usePathname()` end to end. Kept OUT of
 * the frozen `sidebar.test.tsx` on the `sidebar-analytics.test.tsx` precedent — none of this
 * behaviour existed pre-refactor, so it cannot live in a file whose whole point is "identical
 * before/after".
 */

let pathname = '/dashboard';

vi.mock('./sidebar-context', () => ({
  useSidebar: () => sidebarValue,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}));

// ⚠ MUST MOCK: user-menu.tsx imports `logoutAction` from the `@/lib/auth/actions` BARREL, which
// re-exports modules that import `@balo/db` → `postgres` in jsdom (sidebar.test.tsx precedent).
vi.mock('./user-menu', () => ({
  UserMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// next/link mock (agenda-list.test.tsx precedent, extended to surface `prefetch` — a Next-internal
// prop that never reaches the DOM by default, so without this mock D3's `prefetch={false}` would
// be COMPLETELY untested and could be silently deleted). React 19 treats `ref` as a plain prop, so
// the `{...rest}` spread satisfies Radix `TooltipTrigger asChild` in the collapsed cases.
vi.mock('next/link', () => ({
  default: ({
    href,
    prefetch,
    children,
    ...rest
  }: {
    href: string;
    prefetch?: boolean;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>
      {children}
    </a>
  ),
}));

import { Sidebar } from './sidebar';

let sidebarValue: Record<string, unknown>;

function navContextFor(mode: 'client' | 'expert'): NavContext {
  return {
    workspaceType: mode === 'expert' ? 'expert' : 'company',
    capabilities: [CAPABILITIES.MANAGE_MEMBERS],
  };
}

function renderSidebar(opts: {
  mode: 'client' | 'expert';
  isCollapsed?: boolean;
}): ReturnType<typeof render> {
  sidebarValue = {
    activeMode: opts.mode,
    userName: 'Jane Doe',
    userInitials: 'JD',
    userAvatarUrl: null,
    checklistCompletedCount: 0,
    checklistAllComplete: false,
    navContext: navContextFor(opts.mode),
    workspaces: [SINGLE_COMPANY_WORKSPACE],
    activeWorkspaceKey: SINGLE_COMPANY_WORKSPACE.key,
    isCollapsed: opts.isCollapsed ?? false,
    toggleCollapsed: () => {
      sidebarValue = { ...sidebarValue, isCollapsed: !sidebarValue.isCollapsed };
    },
  };
  return render(<Sidebar />);
}

function primaryNav(): HTMLElement {
  return screen.getByRole('navigation');
}

describe('Sidebar motion + jump-out (BAL-497)', () => {
  it('client sees Find experts with a jump-out arrow inside the suffix slot', () => {
    // NOT `link.querySelector('svg[aria-hidden="true"]')`: lucide-react puts `aria-hidden="true"`
    // on EVERY icon by default, so that selector resolves to the entry's own `Search` icon, not
    // the `ArrowUpRight` — deleting the jump-out arrow entirely would still pass it. Assert the
    // real cardinality (Search + ArrowUpRight = 2 svgs) AND that one of them lives inside the
    // right-aligned `ml-auto` suffix span — that second assertion is what actually pins "in the
    // suffix slot", which this test's title claims but the old body never checked.
    pathname = '/dashboard';
    renderSidebar({ mode: 'client' });
    const link = within(primaryNav()).getByRole('link', { name: /^Find experts/ });
    expect(link).toHaveAttribute('href', '/experts');
    expect(link.querySelectorAll('svg')).toHaveLength(2);
    expect(link.querySelector('span.ml-auto svg')).not.toBeNull();
  });

  it('expert never sees Find experts, on any surface', () => {
    pathname = '/dashboard';
    renderSidebar({ mode: 'expert' });
    expect(screen.queryByRole('link', { name: /Find experts/ })).not.toBeInTheDocument();
    expect(document.querySelector('a[href="/experts"]')).toBeNull();
  });

  it('the accessible name conveys the jump AND contains the visible text (WCAG 2.5.3)', () => {
    pathname = '/dashboard';
    renderSidebar({ mode: 'client' });
    const link = screen.getByRole('link', { name: 'Find experts, opens the public directory' });
    expect(link.textContent?.trim()).toContain('Find experts');
  });

  it('D3 — the /experts anchor carries prefetch={false}; every other anchor is untouched', () => {
    pathname = '/dashboard';
    renderSidebar({ mode: 'client' });
    const experts = screen.getByRole('link', { name: /^Find experts/ });
    expect(experts).toHaveAttribute('data-prefetch', 'false');

    const dashboard = screen.getByRole('link', { name: /^Dashboard/ });
    expect(dashboard).toHaveAttribute('data-prefetch', 'undefined');
  });

  it('collapsed: no arrow renders in the rail — exactly one svg (the Search icon)', () => {
    pathname = '/dashboard';
    renderSidebar({ mode: 'client', isCollapsed: true });
    const link = document.querySelector('a[href="/experts"]');
    expect(link).not.toBeNull();
    expect(link?.querySelectorAll('svg')).toHaveLength(1);
  });

  it('THE PITCH PIN, link side: the rendered link itself carries h-11', () => {
    // sidebar-nav-section.test.tsx's "PITCH PIN, class side" pins `h-11` on the PILL
    // (sidebar-nav-section.tsx) — the pill's own height contributes nothing to the pitch
    // arithmetic. The load-bearing height is on the ROW: sidebar-nav-link.tsx's rendered
    // `<Link>` className. `SIDEBAR_NAV_ROW_HEIGHT_PX` (sidebar-nav-pill.ts) is the constant that
    // arithmetic is built on — if the link's `h-11` ever changes without that constant changing
    // too (or vice versa), the two desync silently: jsdom has no layout, so nothing else here
    // would catch a future `h-12`, or a restored `min-h-[44px] py-3`, drifting the real row
    // height away from `SIDEBAR_NAV_ROW_PITCH_PX`. This is the other half of THE PITCH PIN.
    pathname = '/dashboard';
    renderSidebar({ mode: 'client' });
    expect(screen.getByRole('link', { name: /^Dashboard/ }).className).toContain('h-11');
  });

  it('collapsed: the jump-out row still names itself exactly once', () => {
    pathname = '/dashboard';
    renderSidebar({ mode: 'client', isCollapsed: true });
    expect(
      screen.getByRole('link', { name: 'Find experts, opens the public directory' })
    ).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Find experts/ })).toHaveLength(1);
  });

  it('label motion contract: expanded carries max-w-[150px] opacity-100 and the four motion classes', () => {
    pathname = '/dashboard';
    renderSidebar({ mode: 'client' });
    const expandedLabel = screen.getByText('Dashboard');
    for (const cls of [
      'max-w-[150px]',
      'opacity-100',
      'transition-[max-width,opacity]',
      '[transition-duration:.22s,.16s]',
      '[transition-timing-function:cubic-bezier(.4,0,.2,1),ease]',
      'motion-reduce:transition-none',
    ]) {
      expect(expandedLabel.className).toContain(cls);
    }
  });

  it('collapsing swaps the label to max-w-0 opacity-0 while keeping the motion classes', () => {
    pathname = '/dashboard';
    renderSidebar({ mode: 'client', isCollapsed: true });
    const collapsedLabel = screen.getByText('Dashboard');
    expect(collapsedLabel.className).toContain('max-w-0');
    expect(collapsedLabel.className).toContain('opacity-0');
    expect(collapsedLabel.className).toContain('motion-reduce:transition-none');
  });

  it('the rail retunes to 240ms on the shared curve and neutralises under reduced motion', () => {
    pathname = '/dashboard';
    renderSidebar({ mode: 'client' });
    const aside = document.querySelector('aside');
    expect(aside?.className).toContain('duration-[240ms]');
    expect(aside?.className).toContain('ease-[cubic-bezier(.4,0,.2,1)]');
    expect(aside?.className).toContain('motion-reduce:transition-none');

    const dashboard = screen.getByRole('link', { name: /^Dashboard/ });
    expect(dashboard.className).toContain('motion-reduce:transition-none');
  });

  it('the pill follows the pathname through the real Sidebar: /messages parks the primary pill at 192px', () => {
    pathname = '/messages';
    renderSidebar({ mode: 'client' });
    const pill = within(primaryNav()).getByTestId('sidebar-nav-pill-primary');
    expect(pill.style.transform).toBe('translateY(192px)');
    expect(pill.className).toContain('opacity-100');
  });

  it('a route in neither section fades both pills to opacity-0', () => {
    pathname = '/cases/abc';
    renderSidebar({ mode: 'client' });
    const primaryPill = within(primaryNav()).getByTestId('sidebar-nav-pill-primary');
    expect(primaryPill.className).toContain('opacity-0');
    const secondaryPill = screen.getByTestId('sidebar-nav-pill-secondary');
    expect(secondaryPill.className).toContain('opacity-0');
  });

  it('secondary pill lights for /settings/account at index 1 (account), not settings at index 0 — the longest-match rule end to end', () => {
    pathname = '/settings/account';
    renderSidebar({ mode: 'client' });
    const pill = screen.getByTestId('sidebar-nav-pill-secondary');
    expect(pill.className).toContain('opacity-100');
    expect(pill.style.transform).toBe('translateY(48px)');
  });

  // §0.2/D6-AMENDED — this state had ZERO a11y coverage before BAL-497 (the pre-existing axe
  // block in `sidebar.test.tsx` renders expanded only), and it is where the empty-accessible-name
  // defect lived: a collapsed icon-only link with no `aria-label` and no `<title>` has no
  // accessible name at all, which is a WCAG 2.4.4 / axe `link-name` violation.
  it('has no accessibility violations, collapsed', async () => {
    pathname = '/dashboard';
    const { container } = renderSidebar({ mode: 'client', isCollapsed: true });
    expect(await axe(container)).toHaveNoViolations();
  });
});
