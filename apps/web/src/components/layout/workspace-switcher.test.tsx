import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { render } from '@/test/utils';
import type { CompanyWorkspace, Workspace } from '@balo/shared/workspaces';
import { EXPERT_WORKSPACE } from '@balo/shared/workspaces';

// ── Mocks (declared BEFORE the component import — hoisting-safe, join-control.test.tsx precedent) ──

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

import { toast } from 'sonner';
import { track } from '@/lib/analytics';
import { WorkspaceSwitcher, type WorkspaceSwitcherProps } from './workspace-switcher';

const COMPANY_A: CompanyWorkspace = {
  type: 'company',
  key: 'company:11111111-1111-4111-8111-111111111111',
  companyId: '11111111-1111-4111-8111-111111111111',
  name: 'Northwind Industrial',
  via: 'membership',
  isPersonal: false,
  role: 'owner',
};

const COMPANY_B_REPRESENTATION: CompanyWorkspace = {
  type: 'company',
  key: 'company:22222222-2222-4222-8222-222222222222',
  companyId: '22222222-2222-4222-8222-222222222222',
  name: 'Represented Co',
  via: 'representation',
  isPersonal: false,
};

const MULTI: readonly Workspace[] = [EXPERT_WORKSPACE, COMPANY_A, COMPANY_B_REPRESENTATION];

function baseProps(overrides: Partial<WorkspaceSwitcherProps> = {}): WorkspaceSwitcherProps {
  return {
    workspaces: MULTI,
    activeWorkspaceKey: COMPANY_A.key,
    actorName: 'Dana Lee',
    actorInitials: 'DL',
    actorAvatarUrl: null,
    isCollapsed: false,
    ...overrides,
  };
}

/** Renders the multi-workspace switcher, opens the menu, and returns the representation row. */
async function openMenuAndGetRepresentationRow(): Promise<HTMLElement> {
  const user = userEvent.setup();
  render(<WorkspaceSwitcher {...baseProps()} />);
  await user.click(screen.getByRole('button'));
  return screen.getByText('Represented Co').closest('[role="menuitem"]') as HTMLElement;
}

/** Renders the multi-workspace switcher, opens the menu, and selects the expert row — the
 *  shared setup for the three switch-outcome tests (success / failure / thrown / pending). */
async function selectExpertWorkspace(): Promise<void> {
  const user = userEvent.setup();
  render(<WorkspaceSwitcher {...baseProps()} />);
  await user.click(screen.getByRole('button'));
  await user.click(screen.getByRole('menuitem', { name: /Dana Lee/ }));
}

describe('WorkspaceSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('zero workspaces renders nothing', () => {
    const { container } = render(<WorkspaceSwitcher {...baseProps({ workspaces: [] })} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('single workspace renders a static label — no button, no tabindex, no chevron', () => {
    render(
      <WorkspaceSwitcher
        {...baseProps({ workspaces: [COMPANY_A], activeWorkspaceKey: COMPANY_A.key })}
      />
    );
    expect(screen.getByText('Northwind Industrial')).toBeInTheDocument();
    expect(screen.getByText('Client · Owner')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    const withTabIndex = document.querySelectorAll('[tabindex]');
    expect(withTabIndex).toHaveLength(0);
    expect(document.querySelector('.lucide-chevrons-up-down')).not.toBeInTheDocument();
  });

  it('U2: the static label carries a title attribute naming the workspace, even collapsed', () => {
    const { container } = render(
      <WorkspaceSwitcher
        {...baseProps({
          workspaces: [COMPANY_A],
          activeWorkspaceKey: COMPANY_A.key,
          isCollapsed: true,
        })}
      />
    );
    // Collapsed hides the visible name/subtitle text entirely (D11) — `title` is the only
    // remaining textual identification, and the wrapper stays non-interactive (D11 stands).
    expect(screen.queryByText('Northwind Industrial')).not.toBeInTheDocument();
    const labelWrapper = container.firstElementChild;
    expect(labelWrapper).toHaveAttribute('title', 'Northwind Industrial — Client · Owner');
  });

  it('multi, expanded: trigger accessible name names the active workspace', () => {
    render(<WorkspaceSwitcher {...baseProps()} />);
    expect(
      screen.getByRole('button', { name: 'Switch workspace — currently Northwind Industrial' })
    ).toBeInTheDocument();
  });

  it('opening shows both section labels in order, and one menuitem per workspace', async () => {
    const user = userEvent.setup();
    render(<WorkspaceSwitcher {...baseProps()} />);
    await user.click(screen.getByRole('button'));

    const labels = screen.getAllByText(/Your expert workspace|Companies/);
    expect(labels.map((l) => l.textContent)).toEqual(['Your expert workspace', 'Companies']);
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
  });

  it('the current row carries the "Current workspace" sr-only text and no other row does', async () => {
    const user = userEvent.setup();
    render(<WorkspaceSwitcher {...baseProps()} />);
    await user.click(screen.getByRole('button'));

    expect(screen.getAllByText('Current workspace')).toHaveLength(1);
    const currentItem = screen.getByText('Current workspace').closest('[role="menuitem"]');
    expect(currentItem).toHaveTextContent('Northwind Industrial');
  });

  it('a represented company shows "Client · Representing", the disabled note, and aria-disabled', async () => {
    const repItem = await openMenuAndGetRepresentationRow();

    expect(repItem).not.toBeNull();
    expect(within(repItem).getByText('Client · Representing')).toBeInTheDocument();
    expect(within(repItem).getByText('Switching here isn’t available yet')).toBeInTheDocument();
    expect(repItem).toHaveAttribute('aria-disabled', 'true');
  });

  it('D5 — clicking the representation row never calls switchWorkspaceAction', async () => {
    const repItem = await openMenuAndGetRepresentationRow();
    const user = userEvent.setup();
    await user.click(repItem);

    expect(mockSwitchWorkspaceAction).not.toHaveBeenCalled();
  });

  it('switch success: calls the action, toasts success, and refreshes', async () => {
    mockSwitchWorkspaceAction.mockResolvedValueOnce({
      success: true,
      data: { workspace: EXPERT_WORKSPACE },
    });
    await selectExpertWorkspace();

    await waitFor(() => expect(mockSwitchWorkspaceAction).toHaveBeenCalledWith('expert'));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Switched to your expert workspace')
    );
    expect(refresh).toHaveBeenCalled();
  });

  it('switch success with no data: still toasts (S5 — toast never depends on data presence)', async () => {
    // `AuthResult<T>.data` is typed `data?: T`; the action always populates it in practice, but
    // the toast must not silently drop when it doesn't (CLAUDE.md: toast on every user-initiated
    // mutation).
    mockSwitchWorkspaceAction.mockResolvedValueOnce({ success: true, data: undefined });
    await selectExpertWorkspace();

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Switched to workspace'));
    expect(refresh).toHaveBeenCalled();
  });

  it('switch failure: toasts the error string and still refreshes', async () => {
    mockSwitchWorkspaceAction.mockResolvedValueOnce({
      success: false,
      error: 'Could not switch workspace. Please try again.',
    });
    await selectExpertWorkspace();

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not switch workspace. Please try again.')
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('thrown: toasts a generic error with no unhandled rejection', async () => {
    mockSwitchWorkspaceAction.mockRejectedValueOnce(new Error('boom'));
    await selectExpertWorkspace();

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Something went wrong. Please try again.')
    );
  });

  it('pending: the trigger is disabled with aria-busy while switching, then re-enables', async () => {
    let resolveAction: (value: unknown) => void = () => {};
    mockSwitchWorkspaceAction.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAction = resolve;
      })
    );
    await selectExpertWorkspace();

    const trigger = screen.getByRole('button');
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute('aria-busy', 'true');

    resolveAction({ success: true, data: { workspace: EXPERT_WORKSPACE } });
    await waitFor(() => expect(trigger).not.toBeDisabled());
  });

  it('no-op: selecting the already-current workspace does not call the action', async () => {
    const user = userEvent.setup();
    render(<WorkspaceSwitcher {...baseProps()} />);
    await user.click(screen.getByRole('button'));
    await user.click(screen.getByRole('menuitem', { name: /Northwind Industrial/ }));

    expect(mockSwitchWorkspaceAction).not.toHaveBeenCalled();
  });

  it('analytics: opening fires SWITCHER_OPENED once with the full row count, including disabled rows', async () => {
    const user = userEvent.setup();
    render(<WorkspaceSwitcher {...baseProps()} />);
    await user.click(screen.getByRole('button'));

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('workspace_switcher_opened', { workspace_count: 3 });
  });

  it('analytics: the single-context render never fires the open event', () => {
    render(<WorkspaceSwitcher {...baseProps({ workspaces: [COMPANY_A] })} />);
    expect(track).not.toHaveBeenCalled();
  });

  it('collapsed, multi: no name/subtitle text renders; the trigger still opens the menu', async () => {
    const user = userEvent.setup();
    render(<WorkspaceSwitcher {...baseProps({ isCollapsed: true })} />);
    expect(screen.queryByText('Northwind Industrial')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button'));
    const menu = screen.getByRole('menu');
    expect(menu).toBeInTheDocument();
    // D14 — the deliberate departure from every other `DropdownMenuContent` in the repo: the
    // 56px rail places the menu to the side, not under the trigger.
    expect(menu).toHaveAttribute('data-side', 'right');
  });

  it('defensive: an activeWorkspaceKey naming no row falls back to the first workspace, no row current', async () => {
    const user = userEvent.setup();
    render(<WorkspaceSwitcher {...baseProps({ activeWorkspaceKey: 'company:does-not-exist' })} />);
    await user.click(screen.getByRole('button'));

    expect(screen.queryByText('Current workspace')).not.toBeInTheDocument();
  });

  it('keyboard: opens on Enter, arrow keys skip the disabled row, Enter selects, Escape closes', async () => {
    mockSwitchWorkspaceAction.mockResolvedValueOnce({
      success: true,
      data: { workspace: EXPERT_WORKSPACE },
    });
    const user = userEvent.setup();
    render(<WorkspaceSwitcher {...baseProps()} />);

    const trigger = screen.getByRole('button');
    await user.tab();
    expect(trigger).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(await screen.findByRole('menu')).toBeInTheDocument();

    // DOM order: expert row, then the two company rows (current, then the disabled
    // representation row). Radix excludes `disabled` items from roving focus, so the
    // representation row is never a stop — assert that observed behaviour rather than fighting
    // it (D5's row stays reachable to screen readers in browse mode, just not via arrow keys).
    const expertItem = screen.getByRole('menuitem', { name: /Dana Lee/ });
    const currentItem = screen.getByRole('menuitem', { name: /Northwind Industrial/ });
    await waitFor(() => expect(expertItem).toHaveFocus());

    await user.keyboard('{ArrowDown}');
    expect(currentItem).toHaveFocus();

    // One more ArrowDown would land on the disabled representation row if it were focusable;
    // Radix's roving focus excludes it, and this menu doesn't loop, so focus simply stays put
    // on the last enabled item — the observed behaviour, not a wrap.
    await user.keyboard('{ArrowDown}');
    expect(currentItem).toHaveFocus();

    // Move back up to the expert row and select it with Enter.
    await user.keyboard('{ArrowUp}');
    expect(expertItem).toHaveFocus();

    await user.keyboard('{Enter}');
    await waitFor(() => expect(mockSwitchWorkspaceAction).toHaveBeenCalledWith('expert'));
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());

    // Re-open and confirm Escape closes without selecting, returning focus to the trigger.
    await user.click(trigger);
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('has no accessibility violations with the menu open', async () => {
    const user = userEvent.setup();
    render(<WorkspaceSwitcher {...baseProps()} />);
    await user.click(screen.getByRole('button'));
    // `DropdownMenuContent` portals to `document.body`, not RTL's `container` — and while the
    // menu is open Radix's `hideOthers` sets `container[aria-hidden]`, so auditing `container`
    // tests nothing (0 menuitems inside it). Audit the portaled menu itself. Do not swap this for
    // `document.body` — that trips axe's `region` landmark rule (an isolated-render artefact).
    expect(await axe(screen.getByRole('menu'))).toHaveNoViolations();
  });
});
