import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

import type { ActionItemNodeView, ActionItemsPanelView } from '@/lib/engagement/action-items-view';

// ── Server actions: mocked (the island calls them; the units are tested elsewhere) ──
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/create-action-item', () => ({
  createActionItemAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/update-action-item', () => ({
  updateActionItemAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/assign-action-item', () => ({
  assignActionItemAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/set-action-item-status', () => ({
  setActionItemStatusAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/remove-action-item', () => ({
  removeActionItemAction: vi.fn(),
}));

const refreshMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock, push: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import { toast } from 'sonner';
import { createActionItemAction } from '@/app/(dashboard)/engagements/[id]/_actions/create-action-item';
import { updateActionItemAction } from '@/app/(dashboard)/engagements/[id]/_actions/update-action-item';
import { assignActionItemAction } from '@/app/(dashboard)/engagements/[id]/_actions/assign-action-item';
import { setActionItemStatusAction } from '@/app/(dashboard)/engagements/[id]/_actions/set-action-item-status';
import { removeActionItemAction } from '@/app/(dashboard)/engagements/[id]/_actions/remove-action-item';
import { ActionItemsPanel } from './action-items-panel';

function makeNode(over: Partial<ActionItemNodeView> = {}): ActionItemNodeView {
  return {
    id: 'ai-1',
    body: 'Send the migration plan',
    status: 'open',
    assigneeParty: null,
    assigneeLabel: null,
    dueLabel: null,
    dueAtValue: null,
    isOverdue: false,
    ...over,
  };
}

function makeView(over: Partial<ActionItemsPanelView> = {}): ActionItemsPanelView {
  return {
    engagementId: 'eng-1',
    items: [makeNode()],
    canWrite: true,
    viewerParty: 'expert',
    clientCompanyName: 'Northwind Industrial',
    expertPartyShort: 'Priya',
    ...over,
  };
}

describe('ActionItemsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createActionItemAction).mockResolvedValue({ success: true, actionItemId: 'ai-new' });
    vi.mocked(updateActionItemAction).mockResolvedValue({ success: true, actionItemId: 'ai-1' });
    vi.mocked(assignActionItemAction).mockResolvedValue({ success: true, actionItemId: 'ai-1' });
    vi.mocked(setActionItemStatusAction).mockResolvedValue({ success: true, actionItemId: 'ai-1' });
    vi.mocked(removeActionItemAction).mockResolvedValue({ success: true, actionItemId: 'ai-1' });
  });

  it('renders items with body, party assignee and due label (success state)', () => {
    render(
      <ActionItemsPanel
        view={makeView({
          items: [
            makeNode({
              body: 'Confirm data mapping',
              assigneeParty: 'client',
              assigneeLabel: 'Northwind Industrial',
              dueLabel: '9 Jul 2026',
              dueAtValue: '2026-07-09',
            }),
          ],
        })}
      />
    );

    expect(screen.getByText('Confirm data mapping')).toBeInTheDocument();
    expect(screen.getByText('Northwind Industrial')).toBeInTheDocument();
    expect(screen.getByText(/Due 9 Jul 2026/)).toBeInTheDocument();
  });

  it('flags an overdue item with "Past due" (helpful fact, not a countdown)', () => {
    render(
      <ActionItemsPanel
        view={makeView({
          items: [makeNode({ dueLabel: '1 Jun 2026', dueAtValue: '2026-06-01', isOverdue: true })],
        })}
      />
    );
    expect(screen.getByText(/Past due · 1 Jun 2026/)).toBeInTheDocument();
  });

  it('empty + writable renders the invitation copy and an add form', () => {
    render(<ActionItemsPanel view={makeView({ items: [] })} />);
    expect(
      screen.getByText(/Add the first action item so both sides stay aligned/)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Add$/ })).toBeInTheDocument();
  });

  it('read-only (not writable) renders items but no controls', () => {
    render(<ActionItemsPanel view={makeView({ canWrite: false })} />);
    expect(screen.getByText('Send the migration plan')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Add$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit action item/i })).not.toBeInTheDocument();
  });

  it('read-only + empty renders nothing (purely retrospective — nothing to act on)', () => {
    render(<ActionItemsPanel view={makeView({ canWrite: false, items: [] })} />);
    expect(screen.queryByText('Action items')).not.toBeInTheDocument();
  });

  it('adds an action item → calls createActionItemAction and toasts success', async () => {
    const user = userEvent.setup();
    render(<ActionItemsPanel view={makeView({ items: [] })} />);

    await user.type(screen.getByRole('textbox', { name: /new action item/i }), 'Book the kickoff');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));

    expect(createActionItemAction).toHaveBeenCalledWith({
      engagementId: 'eng-1',
      body: 'Book the kickoff',
      dueAt: undefined,
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Action item added'));
    expect(refreshMock).toHaveBeenCalled();
  });

  it('optimistically shows the new item before the action resolves', async () => {
    const user = userEvent.setup();
    let resolve: ((result: { success: true; actionItemId: string }) => void) | undefined;
    vi.mocked(createActionItemAction).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    render(<ActionItemsPanel view={makeView({ items: [] })} />);

    await user.type(screen.getByRole('textbox', { name: /new action item/i }), 'Optimistic row');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));

    expect(screen.getByText('Optimistic row')).toBeInTheDocument();
    resolve?.({ success: true, actionItemId: 'ai-new' });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Action item added'));
  });

  it('toggles an open item to done → calls setActionItemStatusAction(done) and toasts', async () => {
    const user = userEvent.setup();
    render(<ActionItemsPanel view={makeView()} />);

    await user.click(screen.getByRole('checkbox', { name: /mark done/i }));

    expect(setActionItemStatusAction).toHaveBeenCalledWith({
      engagementId: 'eng-1',
      actionItemId: 'ai-1',
      status: 'done',
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Marked done'));
  });

  it('reopens a done item → calls setActionItemStatusAction(open)', async () => {
    const user = userEvent.setup();
    render(<ActionItemsPanel view={makeView({ items: [makeNode({ status: 'done' })] })} />);

    await user.click(screen.getByRole('checkbox', { name: /reopen action item/i }));

    expect(setActionItemStatusAction).toHaveBeenCalledWith({
      engagementId: 'eng-1',
      actionItemId: 'ai-1',
      status: 'open',
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Reopened'));
  });

  it('assigns an item to the client side from the assignee menu', async () => {
    const user = userEvent.setup();
    render(<ActionItemsPanel view={makeView()} />);

    await user.click(screen.getByRole('button', { name: /assign action item/i }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Northwind Industrial' }));

    expect(assignActionItemAction).toHaveBeenCalledWith({
      engagementId: 'eng-1',
      actionItemId: 'ai-1',
      assigneeParty: 'client',
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Assigned'));
  });

  it('unassigns an item from the assignee menu', async () => {
    const user = userEvent.setup();
    render(
      <ActionItemsPanel
        view={makeView({
          items: [makeNode({ assigneeParty: 'expert', assigneeLabel: 'Priya' })],
        })}
      />
    );

    await user.click(screen.getByRole('button', { name: /assign action item/i }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Unassigned' }));

    expect(assignActionItemAction).toHaveBeenCalledWith({
      engagementId: 'eng-1',
      actionItemId: 'ai-1',
      assigneeParty: null,
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Unassigned'));
  });

  it('edits the body via the edit dialog → calls updateActionItemAction', async () => {
    const user = userEvent.setup();
    render(<ActionItemsPanel view={makeView()} />);

    await user.click(screen.getByRole('button', { name: /edit action item/i }));
    const textarea = await screen.findByRole('textbox', { name: /action item/i });
    await user.clear(textarea);
    await user.type(textarea, 'Send the revised plan');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(updateActionItemAction).toHaveBeenCalledWith({
      engagementId: 'eng-1',
      actionItemId: 'ai-1',
      body: 'Send the revised plan',
      dueAt: null,
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Action item updated'));
  });

  it('edits with a due date → sends the ISO datetime', async () => {
    const user = userEvent.setup();
    render(<ActionItemsPanel view={makeView()} />);

    await user.click(screen.getByRole('button', { name: /edit action item/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/due date/i), '2026-07-09');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(updateActionItemAction).toHaveBeenCalledWith({
      engagementId: 'eng-1',
      actionItemId: 'ai-1',
      body: 'Send the migration plan',
      dueAt: '2026-07-09T00:00:00.000Z',
    });
  });

  it('remove opens a confirm dialog — the action is NOT called until confirm is clicked', async () => {
    const user = userEvent.setup();
    render(<ActionItemsPanel view={makeView()} />);

    await user.click(screen.getByRole('button', { name: /remove action item/i }));

    // Confirmation is up; nothing is removed yet.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Remove this action item?')).toBeInTheDocument();
    expect(removeActionItemAction).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: /^Remove$/ }));

    expect(removeActionItemAction).toHaveBeenCalledWith({
      engagementId: 'eng-1',
      actionItemId: 'ai-1',
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Action item removed'));
  });

  it('Cancel dismisses the remove confirm without calling removeActionItemAction', async () => {
    const user = userEvent.setup();
    render(<ActionItemsPanel view={makeView()} />);

    await user.click(screen.getByRole('button', { name: /remove action item/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^Cancel$/ }));

    expect(removeActionItemAction).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByText('Remove this action item?')).not.toBeInTheDocument()
    );
  });

  it('toasts the returned error copy verbatim on a failed mutation', async () => {
    const user = userEvent.setup();
    vi.mocked(removeActionItemAction).mockResolvedValue({
      success: false,
      error: 'This action item is no longer here — refresh and try again.',
    });
    render(<ActionItemsPanel view={makeView()} />);

    await user.click(screen.getByRole('button', { name: /remove action item/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^Remove$/ }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'This action item is no longer here — refresh and try again.'
      )
    );
    expect(refreshMock).toHaveBeenCalled();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <ActionItemsPanel
        view={makeView({
          items: [makeNode({ assigneeParty: 'client', assigneeLabel: 'Northwind Industrial' })],
        })}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
