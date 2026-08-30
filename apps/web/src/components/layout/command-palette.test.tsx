import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { CAPABILITIES } from '@balo/shared/authz';
import type { Workspace, CompanyWorkspace } from '@balo/shared/workspaces';
import { EXPERT_WORKSPACE } from '@balo/shared/workspaces';
import { SINGLE_COMPANY_WORKSPACE } from '@/test/fixtures/workspaces';
import type { NavCapability } from './nav-registry';

// cmdk / Radix UI need `hasPointerCapture`, which jsdom lacks and — unlike `ResizeObserver` and
// `scrollIntoView` — `src/test/setup.ts` does NOT already stub globally.
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn();
});

// ── Mocks (declared BEFORE the component import — hoisting-safe, workspace-switcher.test.tsx
// precedent) ──

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const mockSwitchWorkspaceAction = vi.fn();
vi.mock('@/lib/auth/actions/switch-workspace', () => ({
  switchWorkspaceAction: (...args: unknown[]) => mockSwitchWorkspaceAction(...args),
}));

let sidebarValue: Record<string, unknown>;
vi.mock('./sidebar-context', () => ({ useSidebar: () => sidebarValue }));

import { toast } from 'sonner';
import { track } from '@/lib/analytics';
import { CommandPalette } from './command-palette';

const COMPANY_A: CompanyWorkspace = SINGLE_COMPANY_WORKSPACE;

const COMPANY_REPRESENTATION: CompanyWorkspace = {
  type: 'company',
  key: 'company:22222222-2222-4222-8222-222222222222',
  companyId: '22222222-2222-4222-8222-222222222222',
  name: 'Represented Co',
  via: 'representation',
  isPersonal: false,
};

// F4 — a plain, non-active company MEMBERSHIP row (the `Building2` icon arm, and the commonest
// real switch case: a client belonging to two companies). Every other fixture list holds only
// the expert + representation rows, so this arm previously rendered in no test at all.
const COMPANY_B: CompanyWorkspace = {
  type: 'company',
  key: 'company:33333333-3333-4333-8333-333333333333',
  companyId: '33333333-3333-4333-8333-333333333333',
  name: 'Acme Robotics',
  via: 'membership',
  isPersonal: false,
  role: 'member',
};

interface RenderPaletteOptions {
  readonly workspaceType: 'company' | 'expert';
  readonly capabilities?: readonly NavCapability[];
  readonly workspaces?: readonly Workspace[];
  readonly activeWorkspaceKey?: string | null;
  readonly userName?: string;
}

function renderPalette(opts: RenderPaletteOptions): ReturnType<typeof render> {
  sidebarValue = {
    navContext: { workspaceType: opts.workspaceType, capabilities: opts.capabilities ?? [] },
    workspaces: opts.workspaces ?? [],
    activeWorkspaceKey: opts.activeWorkspaceKey ?? null,
    userName: opts.userName ?? 'Dana Lee',
  };
  return render(<CommandPalette />);
}

/** Renders, opens via click, collects every visible option's label text, then unmounts — so
 *  successive calls in the same test each start from a clean DOM. */
async function openAndListOptions(opts: RenderPaletteOptions): Promise<string[]> {
  const { unmount } = renderPalette(opts);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Search' }));
  const labels = screen.getAllByRole('option').map((el) => el.textContent?.trim() ?? '');
  unmount();
  return labels;
}

/** Opens the palette and selects the expert workspace row — the shared setup for the three
 *  switch-outcome tests (success / failure / thrown), mirroring `workspace-switcher.test.tsx`'s
 *  `selectExpertWorkspace` precedent so the three near-identical arrange blocks don't repeat. */
async function openAndSelectExpertWorkspace(): Promise<void> {
  const user = userEvent.setup();
  renderPalette({
    workspaceType: 'company',
    workspaces: [EXPERT_WORKSPACE, COMPANY_A],
    activeWorkspaceKey: COMPANY_A.key,
  });
  await user.click(screen.getByRole('button', { name: 'Search' }));
  await user.click(screen.getByRole('option', { name: /Switch to Dana Lee/ }));
}

/** Presses Escape, waits for the dialog to close, then asserts `target` regains focus — shared by
 *  T18 (click-to-open) and T18b (⌘K-opened-from-elsewhere) so the two don't repeat the same
 *  three-line close/focus-restore shape. */
async function escapeAndExpectFocus(
  user: ReturnType<typeof userEvent.setup>,
  target: HTMLElement
): Promise<void> {
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await waitFor(() => expect(target).toHaveFocus());
}

/** Dispatches a raw ⌘K / Ctrl-K keydown on `document`, wrapped in `act` (this bypasses RTL's
 *  event helpers, which do not synthesize `metaKey`+key combos reliably). Returns the event so
 *  callers can assert on `defaultPrevented`. */
function dispatchShortcut(opts: { metaKey?: boolean; ctrlKey?: boolean }): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'k',
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    globalThis.document.dispatchEvent(event);
  });
  return event;
}

describe('CommandPalette', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T1: trigger renders with the shortcut hint, no dialog yet', () => {
    renderPalette({ workspaceType: 'company' });
    const trigger = screen.getByRole('button', { name: 'Search' });
    expect(trigger).toHaveAttribute('aria-keyshortcuts', 'Meta+K Control+K');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('T2: opens on click and tracks command_palette_opened once with method:click', async () => {
    const user = userEvent.setup();
    renderPalette({ workspaceType: 'company' });
    await user.click(screen.getByRole('button', { name: 'Search' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('command_palette_opened', { method: 'click' });
  });

  it('T3: opens on ⌘K, prevents the default browser shortcut, and tracks method:shortcut', () => {
    renderPalette({ workspaceType: 'company' });
    const event = dispatchShortcut({ metaKey: true });

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(track).toHaveBeenCalledWith('command_palette_opened', { method: 'shortcut' });
    expect(event.defaultPrevented).toBe(true);
  });

  it('T4: Ctrl-K opens too', () => {
    renderPalette({ workspaceType: 'company' });
    dispatchShortcut({ ctrlKey: true });

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(track).toHaveBeenCalledWith('command_palette_opened', { method: 'shortcut' });
  });

  it('T5: ⌘K toggles an open palette closed and emits nothing on the close edge', async () => {
    const user = userEvent.setup();
    renderPalette({ workspaceType: 'company' });
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(track).toHaveBeenCalledTimes(1);

    dispatchShortcut({ metaKey: true });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('T6: capability gating is differential — the two label sets differ by exactly ["Team"]', async () => {
    const withoutManage = await openAndListOptions({ workspaceType: 'company', capabilities: [] });
    const withManage = await openAndListOptions({
      workspaceType: 'company',
      capabilities: [CAPABILITIES.MANAGE_MEMBERS],
    });

    const diff = withManage.filter((label) => !withoutManage.includes(label));
    expect(diff).toEqual(['Team']);
  });

  it('T7: workspace-type scoping — expert context includes Expert Settings, company does not', async () => {
    const expertLabels = await openAndListOptions({ workspaceType: 'expert' });
    const companyLabels = await openAndListOptions({ workspaceType: 'company' });

    expect(expertLabels).toContain('Expert Settings');
    expect(companyLabels).not.toContain('Expert Settings');
  });

  it('T8: disabled registry keys never surface, in any context', async () => {
    const contexts: RenderPaletteOptions[] = [
      { workspaceType: 'company', capabilities: [] },
      { workspaceType: 'company', capabilities: [CAPABILITIES.MANAGE_MEMBERS] },
      { workspaceType: 'expert', capabilities: [] },
      { workspaceType: 'expert', capabilities: [CAPABILITIES.MANAGE_MEMBERS] },
    ];
    for (const context of contexts) {
      const labels = await openAndListOptions(context);
      expect(labels).not.toContain('Help');
      expect(labels).not.toContain('Find experts');
      expect(labels).not.toContain('Calendar');
    }
  });

  it('T9: navigate — selecting Projects pushes its href, tracks nav_item_clicked, and closes', async () => {
    const user = userEvent.setup();
    renderPalette({ workspaceType: 'company' });
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.click(screen.getByRole('option', { name: 'Projects' }));

    expect(push).toHaveBeenCalledWith('/projects');
    expect(track).toHaveBeenCalledWith('nav_item_clicked', {
      item: 'projects',
      surface: 'command_palette',
      workspace_type: 'company',
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('T10: fuzzy filter narrows the visible options as the query changes', async () => {
    const user = userEvent.setup();
    renderPalette({ workspaceType: 'company' });
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.type(screen.getByRole('combobox'), 'proj');

    expect(screen.getByRole('option', { name: 'Projects' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Dashboard' })).not.toBeInTheDocument();
  });

  it('T11: an unmatched query renders the action-framed empty state', async () => {
    const user = userEvent.setup();
    renderPalette({ workspaceType: 'company' });
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.type(screen.getByRole('combobox'), 'zzzz');

    expect(screen.getByText('Try a page name or a workspace name')).toBeInTheDocument();
  });

  it('T12: other workspaces are listed, the active one is excluded', async () => {
    const user = userEvent.setup();
    mockSwitchWorkspaceAction.mockResolvedValueOnce({
      success: true,
      data: { workspace: COMPANY_B },
    });
    renderPalette({
      workspaceType: 'company',
      workspaces: [EXPERT_WORKSPACE, COMPANY_A, COMPANY_B, COMPANY_REPRESENTATION],
      activeWorkspaceKey: COMPANY_A.key,
    });
    await user.click(screen.getByRole('button', { name: 'Search' }));

    expect(screen.getByRole('option', { name: /Switch to Dana Lee/ })).toBeInTheDocument();
    expect(screen.getByText('Represented Co')).toBeInTheDocument();
    expect(screen.queryByText(/Switch to Northwind Industrial/)).not.toBeInTheDocument();

    // F4 — the plain company membership row (the `Building2` icon arm) renders, with its
    // subtitle, and selecting it drives the switch action with that company's key.
    const companyBRow = screen.getByRole('option', { name: /Switch to Acme Robotics/ });
    expect(companyBRow).toBeInTheDocument();
    expect(screen.getByText('Client · Member')).toBeInTheDocument();

    // F2 — the positive counterpart to T13: a non-empty switchable list DOES render the
    // separator. Asserted on the real DOM node (`queryByRole('separator')` is vacuous now that
    // `aria-hidden="true"` removes it from the accessibility tree — see T13), and BEFORE the
    // click below, since selecting a row closes and unmounts the dialog.
    expect(document.querySelector('[data-slot="command-separator"]')).not.toBeNull();

    await user.click(companyBRow);
    expect(mockSwitchWorkspaceAction).toHaveBeenCalledWith(COMPANY_B.key);
  });

  it('T13: an empty or active-only workspace list renders no heading and no separator', async () => {
    const user = userEvent.setup();
    const { unmount } = renderPalette({ workspaceType: 'company', workspaces: [] });
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.queryByText('Switch workspace')).not.toBeInTheDocument();
    // F2 — `queryByRole('separator')` is vacuous now that `aria-hidden="true"` (command-palette.tsx)
    // removes the separator from the accessibility tree; RTL role queries default to
    // `hidden: false`, so this assertion would pass even if the whole guard were deleted. Assert
    // on the real DOM node via its `data-slot` instead (verified against `ui/command.tsx`).
    expect(document.querySelector('[data-slot="command-separator"]')).toBeNull();
    unmount();

    const user2 = userEvent.setup();
    renderPalette({
      workspaceType: 'company',
      workspaces: [COMPANY_A],
      activeWorkspaceKey: COMPANY_A.key,
    });
    await user2.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.queryByText('Switch workspace')).not.toBeInTheDocument();
    expect(document.querySelector('[data-slot="command-separator"]')).toBeNull();
  });

  it('T14: a representation row is present, disabled, and arrow-key roving skips it', async () => {
    const user = userEvent.setup();
    renderPalette({
      workspaceType: 'company',
      workspaces: [COMPANY_A, COMPANY_REPRESENTATION],
      activeWorkspaceKey: COMPANY_A.key,
    });
    await user.click(screen.getByRole('button', { name: 'Search' }));

    const repRow = screen.getByText('Represented Co').closest('[role="option"]');
    expect(repRow).not.toBeNull();
    expect(repRow).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Switching here isn’t available yet')).toBeInTheDocument();

    // F9 — "clicking it never calls the switch action" proved little: the disabled branch wires
    // no `onSelect` at all, so of course a click is a no-op. cmdk tracks the roving item via
    // `aria-selected` on `[role="option"]` (the search input keeps real DOM focus throughout —
    // this is NOT `toHaveFocus()`), and its own item list EXCLUDES `aria-disabled="true"` rows
    // entirely, so `End` (jump to the last selectable item) can never land on `repRow`. If it were
    // reachable, `End` would have selected it instead of the row before it.
    await user.keyboard('{End}');
    expect(repRow).toHaveAttribute('aria-selected', 'false');
    const lastSelectableRow = screen
      .getAllByRole('option')
      .find((option) => option.getAttribute('aria-selected') === 'true');
    expect(lastSelectableRow).toBeDefined();
    expect(lastSelectableRow).not.toBe(repRow);

    // One further ArrowDown has nowhere to go (no `loop` prop) but MUST NOT land on `repRow`.
    await user.keyboard('{ArrowDown}');
    expect(repRow).toHaveAttribute('aria-selected', 'false');
    expect(lastSelectableRow).toHaveAttribute('aria-selected', 'true');
  });

  it('T15: switch success — tracks the action, closes immediately, toasts, and refreshes', async () => {
    mockSwitchWorkspaceAction.mockResolvedValueOnce({
      success: true,
      data: { workspace: EXPERT_WORKSPACE },
    });
    await openAndSelectExpertWorkspace();

    expect(track).toHaveBeenCalledWith('command_palette_action', {
      type: 'switch_workspace',
      destination: 'expert',
    });
    expect(mockSwitchWorkspaceAction).toHaveBeenCalledWith('expert');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Switched to your expert workspace')
    );
    expect(refresh).toHaveBeenCalled();
  });

  it('T16: switch failure — toasts the server error string and still refreshes', async () => {
    mockSwitchWorkspaceAction.mockResolvedValueOnce({
      success: false,
      error: 'Could not switch workspace. Please try again.',
    });
    await openAndSelectExpertWorkspace();

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not switch workspace. Please try again.')
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('T17: a thrown/rejected switch toasts the generic message with no unhandled rejection', async () => {
    mockSwitchWorkspaceAction.mockRejectedValueOnce(new Error('boom'));
    await openAndSelectExpertWorkspace();

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Something went wrong. Please try again.')
    );
  });

  it('T18: Escape closes the dialog and restores focus to the trigger', async () => {
    const user = userEvent.setup();
    renderPalette({ workspaceType: 'company' });
    const trigger = screen.getByRole('button', { name: 'Search' });
    await user.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await escapeAndExpectFocus(user, trigger);
  });

  it('T18b: ⌘K opened from another focused element restores focus to THAT element, not the trigger', async () => {
    // F5 — the AC says Esc restores focus to the PREVIOUSLY focused element; that only coincides
    // with the trigger when the palette was opened by clicking it. Render an unrelated input,
    // focus it, open via the ⌘K shortcut (not a click on the trigger), and prove Esc returns
    // focus to the INPUT rather than falling back to the trigger.
    const user = userEvent.setup();
    renderPalette({ workspaceType: 'company' });
    render(<input aria-label="Some other field" />);
    const otherInput = screen.getByRole('textbox', { name: 'Some other field' });
    await user.click(otherInput);
    expect(otherInput).toHaveFocus();

    dispatchShortcut({ metaKey: true });
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await escapeAndExpectFocus(user, otherInput);
  });

  it('T18c: ⌘K with nothing focused falls back to the trigger rather than stranding focus on body', async () => {
    // F5 — `document.body` satisfies both `instanceof HTMLElement` and `.isConnected`, so without
    // an explicit body exclusion the restore would call `body.focus()` — a no-op that leaves focus
    // on `<body>`. Reachable on a fresh load, after a click on non-focusable chrome, and in Safari
    // (which does not focus a `<button>` on click). The trigger is the better fallback there.
    const user = userEvent.setup();
    renderPalette({ workspaceType: 'company' });
    const trigger = screen.getByRole('button', { name: 'Search' });
    expect(globalThis.document.body).toHaveFocus(); // nothing focused yet

    dispatchShortcut({ metaKey: true });
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await escapeAndExpectFocus(user, trigger);
  });

  it('T19: has no accessibility violations while open', async () => {
    const user = userEvent.setup();
    renderPalette({
      workspaceType: 'company',
      workspaces: [EXPERT_WORKSPACE, COMPANY_A, COMPANY_REPRESENTATION],
      activeWorkspaceKey: COMPANY_A.key,
    });
    await user.click(screen.getByRole('button', { name: 'Search' }));

    // Audit the portaled dialog itself — Radix `hideOthers` aria-hides `container` while open,
    // and auditing `document.body` trips axe's `region` landmark rule (workspace-switcher.test.tsx
    // precedent).
    expect(await axe(screen.getByRole('dialog'))).toHaveNoViolations();
  });
});
