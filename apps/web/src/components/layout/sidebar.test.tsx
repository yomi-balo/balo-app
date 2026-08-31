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
 *
 * ⚠⚠ BAL-501 — INTENTIONAL, TICKET-AUTHORISED UNFREEZE (the THIRD). ADR-1053 deletes the mobile
 * drawer: `Sidebar` no longer renders a `Sheet` and `TopNav` no longer renders a hamburger, so
 * the `mobile drawer renders ALL enabled entries, including Projects` block asserts against
 * markup that no longer exists. It is DELETED, not edited — an edited version would pin the new
 * surface from the wrong file. Its ONE load-bearing guarantee — Projects stays reachable on a
 * phone — moves to `mobile-more-sheet.test.tsx` ('renders every resolved more item, including
 * Projects'), so the coverage is RELOCATED, never dropped. The `useIsMobile` mock and the
 * `TopNav` import go with it (both existed only for that block). Every other assertion in this
 * file is still frozen.
 *
 * ⚠⚠ BAL-497 — INTENTIONAL, TICKET-AUTHORISED UNFREEZE (the FOURTH), granted by orchestrator
 * decision D8 and extended by the architect's §0.1. Flipping the `find_experts` registry entry on
 * (client workspaces only) adds a FIFTH top item, and D5/D6/D7 move the active background off the
 * link onto a per-section pill and keep the collapsed label MOUNTED. FIVE blocks change, named
 * here so the rest of the file stays genuinely frozen:
 *   1. `renders the top items in exact order for both modes` — the CLIENT arrays gain
 *      'Find experts' / '/experts' in position 2. The EXPERT arrays are untouched (find_experts is
 *      `workspaceTypes: ['company']`).
 *   2+3. BOTH `bottom gating matrix — client, …` blocks — NOT in D8's original three, and they
 *      break for a mechanical reason the orchestrator did not foresee: each subtracts a HARD-CODED
 *      denylist of primary hrefs from `getAllByRole('link')`, and the primary section gained one.
 *      The ONLY edit is adding '/experts' to that denylist; the expectation, title and intent are
 *      unchanged. The two EXPERT counterparts are untouched.
 *   4. `collapsed path: hides labels and badges` — INVERTED by D6: the label span must stay mounted
 *      for `max-width` to animate, so it is now present-but-clipped-and-`aria-hidden`, and the
 *      link's accessible name comes from `aria-label` (exactly ONE label). Badges still hide.
 *   5. `active state: Dashboard link carries active styling` — D7 moved `bg-primary/10` off the
 *      link and onto the pill. The link keeps `text-primary` only.
 * Every other assertion in this file is still frozen and was verified unchanged.
 *
 * ⚠ Reading the two notes together: BAL-503's "the mobile drawer fixture stays frozen" was true
 * when written, one commit before BAL-501 deleted that block outright. The notes are a
 * chronological record, not a description of the file's current state — same convention as
 * BAL-496's note above.
 */

// ── Mocks (declared BEFORE the component import — hoisting-safe, top-nav.test.tsx precedent) ──

let sidebarValue: Record<string, unknown>;

vi.mock('./sidebar-context', () => ({
  useSidebar: () => sidebarValue,
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
    // Stateful by construction: mutates the module-level `sidebarValue` so a subsequent
    // `rerender(<Sidebar />)` observes the flip. `useSidebar` is mocked as `() => sidebarValue`,
    // so this closure reassigning the outer binding is what makes the collapse toggle testable.
    toggleCollapsed: () => {
      sidebarValue = { ...sidebarValue, isCollapsed: !sidebarValue.isCollapsed };
    },
  };
  return render(<Sidebar />);
}

function primaryNav(): HTMLElement {
  return screen.getByRole('navigation');
}

describe('Sidebar (BAL-495 pinning test — pre/post refactor identical)', () => {
  it('renders the top items in exact order for both modes', () => {
    // Calendar (BAL-498) is expert-only and Find experts (BAL-497) is company-only, so the two
    // modes now diverge in BOTH directions: client gains Find experts in position 2, expert
    // gains Calendar between Projects and Messages.
    const client = renderSidebar({ mode: 'client', canManageCompany: false });
    const clientLinks = within(primaryNav()).getAllByRole('link');
    expect(clientLinks.map((l) => l.textContent?.trim())).toEqual([
      'Dashboard',
      'Find experts',
      'Consultations',
      'Projects',
      'Messages',
    ]);
    expect(clientLinks.map((l) => l.getAttribute('href'))).toEqual([
      '/dashboard',
      '/experts',
      '/consultations',
      '/projects',
      '/messages',
    ]);
    client.unmount();

    const expert = renderSidebar({ mode: 'expert', canManageCompany: false });
    const expertLinks = within(primaryNav()).getAllByRole('link');
    expect(expertLinks.map((l) => l.textContent?.trim())).toEqual([
      'Dashboard',
      'Consultations',
      'Projects',
      'Calendar',
      'Messages',
    ]);
    expect(expertLinks.map((l) => l.getAttribute('href'))).toEqual([
      '/dashboard',
      '/consultations',
      '/projects',
      '/expert/calendar',
      '/messages',
    ]);
    expert.unmount();
  });

  it('bottom gating matrix — client, cannot manage company → Settings + Account', () => {
    renderSidebar({ mode: 'client', canManageCompany: false });
    const allLinks = screen.getAllByRole('link');
    // BAL-497 — '/experts' added to the denylist: the primary section gained a fifth href, and
    // this array's job is to name every PRIMARY href so the subtraction below isolates the
    // bottom section. The expectation, title and intent are unchanged.
    const bottomHrefs = allLinks
      .map((l) => l.getAttribute('href'))
      .filter(
        (href) =>
          href &&
          !['/dashboard', '/experts', '/consultations', '/projects', '/messages', '/'].includes(
            href
          )
      );
    expect(bottomHrefs).toEqual(['/settings', '/settings/account']);
  });

  it('bottom gating matrix — client, can manage company → Settings + Account (identical to the no-manage case)', () => {
    renderSidebar({ mode: 'client', canManageCompany: true });
    const allLinks = screen.getAllByRole('link');
    // BAL-497 — '/experts' added to the denylist (see the no-manage case above for why).
    const bottomHrefs = allLinks
      .map((l) => l.getAttribute('href'))
      .filter(
        (href) =>
          href &&
          !['/dashboard', '/experts', '/consultations', '/projects', '/messages', '/'].includes(
            href
          )
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
          href &&
          ![
            '/dashboard',
            '/consultations',
            '/projects',
            '/expert/calendar',
            '/messages',
            '/',
          ].includes(href)
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
          href &&
          ![
            '/dashboard',
            '/consultations',
            '/projects',
            '/expert/calendar',
            '/messages',
            '/',
          ].includes(href)
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

  it('collapsed path: labels stay mounted but clipped and aria-hidden, badges hide, toggle relabels to Expand sidebar', async () => {
    const user = userEvent.setup();
    const { rerender } = renderSidebar({
      mode: 'expert',
      canManageCompany: false,
      checklistCompletedCount: 3,
      checklistAllComplete: false,
    });
    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    rerender(<Sidebar />);

    // D6 — INVERTED from "not.toBeInTheDocument". The span must stay MOUNTED for `max-width` to
    // animate; it is removed from the ACCESSIBILITY tree instead of from the DOM.
    const dashboardLabel = screen.getByText('Dashboard');
    expect(dashboardLabel).toHaveAttribute('aria-hidden', 'true');
    expect(dashboardLabel.className).toContain('max-w-0');
    expect(dashboardLabel.className).toContain('opacity-0');
    expect(screen.getByText('Consultations')).toHaveAttribute('aria-hidden', 'true');

    // …and the collapsed link therefore names itself, exactly ONCE, via aria-label.
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBe(dashboardLabel.closest('a'));

    // Badges still hide entirely when collapsed (unchanged).
    expect(screen.queryByText('3/5')).not.toBeInTheDocument();
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

  it('active state: the PILL carries the active background, Dashboard carries text-primary, Projects carries neither (pathname /dashboard)', () => {
    renderSidebar({ mode: 'client', canManageCompany: false });
    const dashboardLink = screen.getByRole('link', { name: /^Dashboard/ });
    const projectsLink = screen.getByRole('link', { name: /^Projects/ });

    // D7 — the background moved OFF the link. Neither link paints it; double-painting would
    // render the same token at 20%.
    expect(dashboardLink.className).not.toContain('bg-primary/10');
    expect(projectsLink.className).not.toContain('bg-primary/10');
    expect(dashboardLink.className).toContain('text-primary');
    expect(projectsLink.className).not.toContain('text-primary');

    // …and the primary pill paints it, parked on row 0 (Dashboard is index 0).
    const pill = within(primaryNav()).getByTestId('sidebar-nav-pill-primary');
    expect(pill.className).toContain('bg-primary/10');
    expect(pill.className).toContain('opacity-100');
    expect(pill.style.transform).toBe('translateY(0px)');
  });

  // ⚠ Decision rule: if this fails against the UNMODIFIED sidebar, that is a pre-existing a11y
  // defect, out of scope for a pure refactor. Drop this assertion and file a follow-up ticket —
  // do not fix the markup here.
  it('has no accessibility violations', async () => {
    const { container } = renderSidebar({ mode: 'client', canManageCompany: true });
    expect(await axe(container)).toHaveNoViolations();
  });
});
