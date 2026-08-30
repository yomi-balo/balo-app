import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { CAPABILITIES } from '@balo/shared/authz';
import type { CompanyWorkspace, Workspace } from '@balo/shared/workspaces';
import { EXPERT_WORKSPACE } from '@balo/shared/workspaces';
import { track } from '@/lib/analytics';
import { SINGLE_COMPANY_WORKSPACE } from '@/test/fixtures/workspaces';
import { resolveMoreItems, type NavContext } from './nav-registry';

/**
 * BAL-501 — `MobileMoreSheet`'s own suite.
 *
 * ⚠ THE RELOCATED PIN: `sidebar.test.tsx`'s deleted 'mobile drawer renders ALL enabled entries,
 * including Projects' block had exactly one load-bearing guarantee — Projects stays reachable on
 * a phone. It moves here (see 'renders every resolved more item, including Projects' below), per
 * D20's third ticket-authorised unfreeze.
 */

// ── Mocks (declared BEFORE the component import) ────────────────────────────────────────────

let sidebarValue: Record<string, unknown>;

vi.mock('./sidebar-context', () => ({
  useSidebar: () => sidebarValue,
}));

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const mockSwitchWorkspaceAction = vi.fn();
vi.mock('@/lib/auth/actions/switch-workspace', () => ({
  switchWorkspaceAction: (...args: unknown[]) => mockSwitchWorkspaceAction(...args),
}));

const mockLogoutAction = vi.fn();
vi.mock('@/lib/auth/actions/logout', () => ({
  logoutAction: () => mockLogoutAction(),
}));

import { toast } from 'sonner';
import { Sheet } from '@/components/ui/sheet';
import { MobileMoreSheet } from './mobile-more-sheet';

const COMPANY_B_REPRESENTATION: CompanyWorkspace = {
  type: 'company',
  key: 'company:22222222-2222-4222-8222-222222222222',
  companyId: '22222222-2222-4222-8222-222222222222',
  name: 'Represented Co',
  via: 'representation',
  isPersonal: false,
};

function navContextFor(workspaceType: 'company' | 'expert', canManage: boolean): NavContext {
  return {
    workspaceType,
    capabilities: canManage ? [CAPABILITIES.MANAGE_MEMBERS] : [],
  };
}

function buildSidebarValue(opts: {
  workspaceType?: 'company' | 'expert';
  canManage?: boolean;
  workspaces?: readonly Workspace[];
  activeWorkspaceKey?: string | null;
  checklistCompletedCount?: number;
  checklistAllComplete?: boolean;
}): Record<string, unknown> {
  return {
    navContext: navContextFor(opts.workspaceType ?? 'company', opts.canManage ?? false),
    checklistCompletedCount: opts.checklistCompletedCount ?? 0,
    checklistAllComplete: opts.checklistAllComplete ?? false,
    workspaces: opts.workspaces ?? [SINGLE_COMPANY_WORKSPACE],
    activeWorkspaceKey: opts.activeWorkspaceKey ?? SINGLE_COMPANY_WORKSPACE.key,
    userName: 'Jane Doe',
    userInitials: 'JD',
    userAvatarUrl: null,
  };
}

function renderSheet(
  sidebar: Record<string, unknown>,
  onNavigate: () => void = vi.fn()
): ReturnType<typeof render> {
  sidebarValue = sidebar;
  const items = resolveMoreItems(sidebar.navContext as NavContext);
  return render(
    <Sheet open onOpenChange={() => {}}>
      <MobileMoreSheet items={items} onNavigate={onNavigate} />
    </Sheet>
  );
}

describe('MobileMoreSheet (BAL-501)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('THE RELOCATED PIN — renders every resolved more item, including Projects, for a company workspace', () => {
    renderSheet(buildSidebarValue({ workspaceType: 'company', canManage: false }));
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/projects', '/settings/account']);
  });

  it('renders every resolved more item, in order, for an expert workspace with manage_members', () => {
    renderSheet(buildSidebarValue({ workspaceType: 'expert', canManage: true }));
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/projects',
      '/expert/settings',
      '/settings/team',
      '/settings/account',
    ]);
  });

  it('/settings/account appears exactly once, and its href comes from the registry', () => {
    renderSheet(buildSidebarValue({ workspaceType: 'expert', canManage: true }));
    const accountLinks = screen
      .getAllByRole('link')
      .filter((l) => l.getAttribute('href') === '/settings/account');
    expect(accountLinks).toHaveLength(1);
  });

  it('Expert Settings row carries the checklist pill', () => {
    renderSheet(
      buildSidebarValue({
        workspaceType: 'expert',
        canManage: false,
        checklistCompletedCount: 3,
        checklistAllComplete: false,
      })
    );
    const expertSettingsLink = screen.getByRole('link', { name: /Expert Settings/ });
    expect(within(expertSettingsLink).getByText('3/5')).toBeInTheDocument();
  });

  it('row click closes the sheet and tracks nav_item_clicked with surface "more_sheet"', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    renderSheet(buildSidebarValue({ workspaceType: 'company', canManage: false }), onNavigate);

    await user.click(screen.getByRole('link', { name: /^Projects/ }));

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('nav_item_clicked', {
      item: 'projects',
      surface: 'more_sheet',
      workspace_type: 'company',
    });
  });

  describe('Workspace section', () => {
    it('0 workspaces — invitation-framed empty state with a Refresh button', async () => {
      const user = userEvent.setup();
      renderSheet(buildSidebarValue({ workspaces: [], activeWorkspaceKey: null }));

      expect(screen.getByText('Workspace')).toBeInTheDocument();
      expect(
        screen.getByText('We couldn’t find a workspace for your account.')
      ).toBeInTheDocument();
      expect(screen.getByText('Still stuck? Sign out and sign back in.')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Refresh' }));
      expect(refresh).toHaveBeenCalled();
    });

    it('1 workspace — a non-interactive row (no button role, no Check)', () => {
      renderSheet(buildSidebarValue({ workspaces: [SINGLE_COMPANY_WORKSPACE], canManage: false }));
      expect(screen.getByText(SINGLE_COMPANY_WORKSPACE.name)).toBeInTheDocument();
      expect(screen.getByText(SINGLE_COMPANY_WORKSPACE.name).closest('button')).toBeNull();
      expect(screen.queryByText('Current workspace')).not.toBeInTheDocument();
    });

    it('2+ workspaces — grouped rows with Check + sr-only "Current workspace" on the current one', () => {
      renderSheet(
        buildSidebarValue({
          workspaces: [EXPERT_WORKSPACE, SINGLE_COMPANY_WORKSPACE],
          activeWorkspaceKey: SINGLE_COMPANY_WORKSPACE.key,
        })
      );
      expect(screen.getByText('Your expert workspace')).toBeInTheDocument();
      expect(screen.getByText('Companies')).toBeInTheDocument();
      expect(screen.getAllByText('Current workspace')).toHaveLength(1);
      const currentRow = screen.getByText('Current workspace').closest('button');
      expect(currentRow).toHaveTextContent(SINGLE_COMPANY_WORKSPACE.name);
    });

    it('representation row is disabled, shows the exact copy, and never calls switchWorkspaceAction on click', async () => {
      const user = userEvent.setup();
      renderSheet(
        buildSidebarValue({
          workspaces: [SINGLE_COMPANY_WORKSPACE, COMPANY_B_REPRESENTATION],
          activeWorkspaceKey: SINGLE_COMPANY_WORKSPACE.key,
        })
      );
      const repRow = screen.getByText('Represented Co').closest('button');
      expect(repRow).toBeDisabled();
      expect(screen.getByText('Switching here isn’t available yet')).toBeInTheDocument();

      if (repRow) await user.click(repRow);
      expect(mockSwitchWorkspaceAction).not.toHaveBeenCalled();
    });

    it('selecting the current workspace is a no-op that closes the sheet, no action call', async () => {
      const user = userEvent.setup();
      const onNavigate = vi.fn();
      renderSheet(
        buildSidebarValue({
          workspaces: [EXPERT_WORKSPACE, SINGLE_COMPANY_WORKSPACE],
          activeWorkspaceKey: SINGLE_COMPANY_WORKSPACE.key,
        }),
        onNavigate
      );

      await user.click(screen.getByText(SINGLE_COMPANY_WORKSPACE.name));
      expect(onNavigate).toHaveBeenCalledTimes(1);
      expect(mockSwitchWorkspaceAction).not.toHaveBeenCalled();
    });

    it('selecting a different workspace closes the sheet, calls the action, and toasts success', async () => {
      mockSwitchWorkspaceAction.mockResolvedValueOnce({
        success: true,
        data: { workspace: EXPERT_WORKSPACE },
      });
      const user = userEvent.setup();
      const onNavigate = vi.fn();
      renderSheet(
        buildSidebarValue({
          workspaces: [EXPERT_WORKSPACE, SINGLE_COMPANY_WORKSPACE],
          activeWorkspaceKey: SINGLE_COMPANY_WORKSPACE.key,
        }),
        onNavigate
      );

      await user.click(screen.getByText('Jane Doe'));

      expect(onNavigate).toHaveBeenCalledTimes(1);
      expect(mockSwitchWorkspaceAction).toHaveBeenCalledWith('expert');
      await vi.waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith('Switched to your expert workspace')
      );
    });
  });

  it('log out row calls the mocked logoutAction and closes the sheet first', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    renderSheet(buildSidebarValue({ workspaceType: 'company', canManage: false }), onNavigate);

    await user.click(screen.getByRole('button', { name: 'Log out' }));

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(mockLogoutAction).toHaveBeenCalledTimes(1);
  });

  it('has no accessibility violations with the sheet open', async () => {
    const { baseElement } = renderSheet(
      buildSidebarValue({
        workspaceType: 'expert',
        canManage: true,
        workspaces: [EXPERT_WORKSPACE, SINGLE_COMPANY_WORKSPACE],
      })
    );
    // 'region' and 'page-has-heading-one' are page-level rules, inapplicable to an isolated sheet.
    const results = await axe(baseElement, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});
