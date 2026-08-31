import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CAPABILITIES } from '@balo/shared/authz';
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
});
