import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CAPABILITIES, PLATFORM_CAPABILITIES } from '@balo/shared/authz';
import { track, NAV_EVENTS } from '@/lib/analytics';
import { SINGLE_COMPANY_WORKSPACE } from '@/test/fixtures/workspaces';
import type { NavContext } from './nav-registry';

/**
 * BAL-495 — click-emits-event wiring. NEW at refactor time: it cannot live in the frozen
 * `sidebar.test.tsx` because tracking does not exist pre-refactor (open-questions answer #3 —
 * kept as a SEPARATE file so the pinning file stays genuinely frozen).
 */

let sidebarValue: Record<string, unknown>;

vi.mock('./sidebar-context', () => ({
  useSidebar: () => sidebarValue,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
}));

vi.mock('./user-menu', () => ({
  UserMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { Sidebar } from './sidebar';

function buildSidebarValue(mode: 'client' | 'expert'): Record<string, unknown> {
  const navContext: NavContext = {
    workspaceType: mode === 'expert' ? 'expert' : 'company',
    capabilities: [CAPABILITIES.MANAGE_MEMBERS],
  };
  return {
    activeMode: mode,
    userName: 'Jane Doe',
    userInitials: 'JD',
    userAvatarUrl: null,
    checklistCompletedCount: 0,
    checklistAllComplete: false,
    navContext,
    workspaces: [SINGLE_COMPANY_WORKSPACE],
    activeWorkspaceKey: SINGLE_COMPANY_WORKSPACE.key,
    isCollapsed: false,
    toggleCollapsed: vi.fn(),
  };
}

function buildStaffSidebarValue(mode: 'client' | 'expert'): Record<string, unknown> {
  const base = buildSidebarValue(mode);
  return {
    ...base,
    navContext: {
      workspaceType: mode === 'expert' ? 'expert' : 'company',
      capabilities: [CAPABILITIES.MANAGE_MEMBERS, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN],
    },
  };
}

describe('Sidebar nav click tracking (BAL-495)', () => {
  // ⚠ `track` is a global spy that accumulates across tests — vitest.config.ts sets no
  // `clearMocks` and setup.ts only calls `cleanup()`. Without this, `toHaveBeenCalledTimes(1)`
  // below only passes because it happens to run first.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits nav_item_clicked with surface "sidebar" and the company workspace type', async () => {
    const user = userEvent.setup();
    sidebarValue = buildSidebarValue('client');
    render(<Sidebar />);

    await user.click(screen.getByRole('link', { name: /^Projects/ }));

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(NAV_EVENTS.ITEM_CLICKED, {
      item: 'projects',
      surface: 'sidebar',
      workspace_type: 'company',
    });
  });

  it('reports workspace_type "expert" in expert mode', async () => {
    const user = userEvent.setup();
    sidebarValue = buildSidebarValue('expert');
    render(<Sidebar />);

    await user.click(screen.getByRole('link', { name: /^Projects/ }));

    expect(track).toHaveBeenCalledWith(NAV_EVENTS.ITEM_CLICKED, {
      item: 'projects',
      surface: 'sidebar',
      workspace_type: 'expert',
    });
  });

  // BAL-497 / D12 — ZERO new analytics code. `nav_item_clicked` already exists, `find_experts` is
  // already in `NAV_ITEM_KEYS`, and `sidebar.tsx` already fires the hook for EVERY rendered entry —
  // so flipping the registry entry on is what starts the event. This is the gate on that claim:
  // leg 1 of the ADR-1053 shell ping-pong metric.
  it('emits nav_item_clicked for the jump-out Find experts entry, surface "sidebar"', async () => {
    const user = userEvent.setup();
    sidebarValue = buildSidebarValue('client');
    render(<Sidebar />);

    await user.click(screen.getByRole('link', { name: /^Find experts/ }));

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(NAV_EVENTS.ITEM_CLICKED, {
      item: 'find_experts',
      surface: 'sidebar',
      workspace_type: 'company',
    });
  });

  // BAL-534 / D12 — ZERO new analytics CODE. `nav_item_clicked` already exists and `sidebar.tsx`
  // already fires the hook for every rendered entry, so adding the registry entries is what
  // starts the event. The ONLY analytics change in this ticket is the NAV_ITEM_KEYS vocabulary.
  // ⚠ NO `section` property — `use-nav-item-tracking.ts` carries none (D12); admin usage is
  // separable in PostHog by the three new `item` keys alone.
  it('emits nav_item_clicked with the new admin item key, surface "sidebar"', async () => {
    const user = userEvent.setup();
    sidebarValue = buildStaffSidebarValue('client');
    render(<Sidebar />);

    await user.click(screen.getByRole('link', { name: /^Config & catalogue/ }));

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(NAV_EVENTS.ITEM_CLICKED, {
      item: 'admin_catalogue',
      surface: 'sidebar',
      workspace_type: 'company',
    });
  });
});
