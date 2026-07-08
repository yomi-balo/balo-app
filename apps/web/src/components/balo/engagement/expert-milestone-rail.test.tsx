import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor, act } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

import type { EmptyStateView, MilestoneNodeView } from '@/lib/engagement/engagement-view';
import type { MilestoneActionResult } from '@/app/(dashboard)/engagements/[id]/_actions/milestone-action-shared';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

vi.mock('@/app/(dashboard)/engagements/[id]/_actions/start-milestone', () => ({
  startMilestoneAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/complete-milestone', () => ({
  completeMilestoneAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/revert-milestone', () => ({
  revertMilestoneAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/add-milestone', () => ({
  addMilestoneAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/update-milestone', () => ({
  updateMilestoneAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/remove-milestone', () => ({
  removeMilestoneAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/reorder-milestones', () => ({
  reorderMilestonesAction: vi.fn(),
}));

import { ExpertMilestoneRail } from './expert-milestone-rail';
import { toast } from 'sonner';
import { startMilestoneAction } from '@/app/(dashboard)/engagements/[id]/_actions/start-milestone';
import { completeMilestoneAction } from '@/app/(dashboard)/engagements/[id]/_actions/complete-milestone';
import { revertMilestoneAction } from '@/app/(dashboard)/engagements/[id]/_actions/revert-milestone';
import { addMilestoneAction } from '@/app/(dashboard)/engagements/[id]/_actions/add-milestone';
import { updateMilestoneAction } from '@/app/(dashboard)/engagements/[id]/_actions/update-milestone';
import { removeMilestoneAction } from '@/app/(dashboard)/engagements/[id]/_actions/remove-milestone';
import { reorderMilestonesAction } from '@/app/(dashboard)/engagements/[id]/_actions/reorder-milestones';

const startMock = vi.mocked(startMilestoneAction);
const completeMock = vi.mocked(completeMilestoneAction);
const revertMock = vi.mocked(revertMilestoneAction);
const addMock = vi.mocked(addMilestoneAction);
const updateMock = vi.mocked(updateMilestoneAction);
const removeMock = vi.mocked(removeMilestoneAction);
const reorderMock = vi.mocked(reorderMilestonesAction);

const EMPTY_STATE: EmptyStateView = {
  icon: 'Flag',
  title: 'Shape the delivery plan',
  body: 'Add your first milestone so Northwind Industrial can follow progress.',
};

function node(overrides: Partial<MilestoneNodeView> = {}): MilestoneNodeView {
  return {
    id: 'm-1',
    title: 'Discovery',
    descriptionHtml: null,
    descriptionText: null,
    acceptanceCriteria: null,
    status: 'pending',
    nodeVariant: 'pending',
    statusLabel: 'Not started',
    connectorFilled: false,
    valueLabel: null,
    startedLabel: null,
    completedLabel: null,
    completionNote: null,
    ...overrides,
  };
}

function renderRail(
  milestones: MilestoneNodeView[],
  emptyState: EmptyStateView | null = EMPTY_STATE
) {
  return render(
    <ExpertMilestoneRail
      engagementId="eng-1"
      milestones={milestones}
      emptyState={emptyState}
      expertPersonShort="Priya"
      clientCompanyName="Northwind Industrial"
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  startMock.mockResolvedValue({ success: true, milestoneId: 'm-1', status: 'in_progress' });
  completeMock.mockResolvedValue({ success: true, milestoneId: 'm-2', status: 'completed' });
  revertMock.mockResolvedValue({ success: true, milestoneId: 'm-3', status: 'in_progress' });
  addMock.mockResolvedValue({ success: true, milestoneId: 'm-new', status: 'pending' });
  updateMock.mockResolvedValue({ success: true, milestoneId: 'm-1', status: 'pending' });
  removeMock.mockResolvedValue({ success: true, milestoneId: 'm-1', status: 'pending' });
  reorderMock.mockResolvedValue({ success: true, milestoneId: '', status: 'pending' });
});

describe('ExpertMilestoneRail — emphasis', () => {
  it('emphasises only the NEXT pending Start (default); other Starts are ghost', () => {
    renderRail([node({ id: 'a', title: 'First' }), node({ id: 'b', title: 'Second' })]);
    const starts = screen.getAllByRole('button', { name: /start milestone/i });
    expect(starts).toHaveLength(2);
    expect(starts[0]!.className).toContain('bg-primary');
    expect(starts[1]!.className).not.toContain('bg-primary');
  });

  it('makes the gradient "Mark complete" the sole prominent button while one is in progress', () => {
    renderRail([
      node({
        id: 'a',
        title: 'First',
        status: 'in_progress',
        nodeVariant: 'in_progress',
        statusLabel: 'In progress',
      }),
      node({ id: 'b', title: 'Second' }),
    ]);
    const complete = screen.getByRole('button', { name: /mark complete/i });
    expect(complete.className).toContain('bg-gradient-to-r');
    // The remaining pending Start is de-emphasised (ghost, not default).
    const start = screen.getByRole('button', { name: /start milestone/i });
    expect(start.className).not.toContain('bg-primary');
  });

  it('renders the D3 notify footnote (complete or change the plan)', () => {
    renderRail([node()]);
    expect(
      screen.getByText(/are notified when you complete a milestone or change the plan/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/changes to price go through a new proposal/i)).toBeInTheDocument();
  });
});

describe('ExpertMilestoneRail — actions', () => {
  it('start: calls startMilestoneAction, toasts success, and refreshes', async () => {
    const user = userEvent.setup();
    renderRail([node({ id: 'a', title: 'First' })]);
    await user.click(screen.getByRole('button', { name: /start milestone/i }));
    await waitFor(() =>
      expect(startMock).toHaveBeenCalledWith({ engagementId: 'eng-1', milestoneId: 'a' })
    );
    expect(toast.success).toHaveBeenCalledWith('Milestone started');
    expect(refresh).toHaveBeenCalled();
  });

  it('complete: opens the modal, submits the note, toasts, and refreshes', async () => {
    const user = userEvent.setup();
    renderRail([
      node({
        id: 'a',
        title: 'First',
        status: 'in_progress',
        nodeVariant: 'in_progress',
        statusLabel: 'In progress',
      }),
    ]);
    await user.click(screen.getByRole('button', { name: /mark complete/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'Shipped the deck.');
    await user.click(within(dialog).getByRole('button', { name: /mark complete/i }));
    await waitFor(() =>
      expect(completeMock).toHaveBeenCalledWith({
        engagementId: 'eng-1',
        milestoneId: 'a',
        completionNote: 'Shipped the deck.',
      })
    );
    expect(toast.success).toHaveBeenCalledWith('Milestone marked complete');
    expect(refresh).toHaveBeenCalled();
  });

  it('revert: opens the confirm modal, confirms, toasts, and refreshes', async () => {
    const user = userEvent.setup();
    renderRail([
      node({
        id: 'a',
        title: 'First',
        status: 'completed',
        nodeVariant: 'completed',
        statusLabel: 'Completed',
      }),
    ]);
    await user.click(screen.getByRole('button', { name: /move back to in progress/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /move back/i }));
    await waitFor(() =>
      expect(revertMock).toHaveBeenCalledWith({ engagementId: 'eng-1', milestoneId: 'a' })
    );
    expect(toast.success).toHaveBeenCalledWith('Milestone moved back to in progress');
    expect(refresh).toHaveBeenCalled();
  });

  it('failure: toasts the error, refreshes, and rolls back the optimistic patch', async () => {
    startMock.mockResolvedValue({ success: false, error: 'Refresh and try again.' });
    const user = userEvent.setup();
    renderRail([node({ id: 'a', title: 'First' })]);
    await user.click(screen.getByRole('button', { name: /start milestone/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Refresh and try again.'));
    expect(refresh).toHaveBeenCalled();
    // The optimistic in-progress patch is reverted once the rejected transition ends:
    // the gradient "Mark complete" is gone and the node is back to its pending
    // "Start milestone" state (plan-mandated rollback-on-failure).
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /mark complete/i })).not.toBeInTheDocument()
    );
    expect(screen.getByRole('button', { name: /start milestone/i })).toBeInTheDocument();
  });

  it('applies the optimistic patch and disables the acting button while pending', async () => {
    let resolveStart: (v: MilestoneActionResult) => void = () => {};
    startMock.mockImplementation(() => new Promise((res) => (resolveStart = res)));
    const user = userEvent.setup();
    renderRail([node({ id: 'a', title: 'First' })]);
    await user.click(screen.getByRole('button', { name: /start milestone/i }));

    // Optimistic patch: the row flips to in-progress → the gradient "Mark complete" appears.
    await waitFor(() => expect(screen.getByText('In progress')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /mark complete/i })).toBeDisabled();

    await act(async () => {
      resolveStart({ success: true, milestoneId: 'a', status: 'in_progress' });
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});

describe('ExpertMilestoneRail — D3 scope edits', () => {
  it('renders the header "Add milestone" button and per-row edit/remove/reorder controls', () => {
    renderRail([node({ id: 'a', title: 'First' }), node({ id: 'b', title: 'Second' })]);
    expect(screen.getByRole('button', { name: /^add milestone$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit First/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove First/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /move First up/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /move First down/i })).toBeInTheDocument();
  });

  it('disables reorder chevrons at the ends of the list', () => {
    renderRail([node({ id: 'a', title: 'First' }), node({ id: 'b', title: 'Second' })]);
    expect(screen.getByRole('button', { name: /move First up/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /move First down/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /move Second up/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /move Second down/i })).toBeDisabled();
  });

  it('empty state renders the "Add the first milestone" gradient CTA', () => {
    renderRail([]);
    expect(screen.getByText('Shape the delivery plan')).toBeInTheDocument();
    const cta = screen.getByRole('button', { name: /add the first milestone/i });
    expect(cta).toBeInTheDocument();
    expect(cta.className).toContain('bg-gradient-to-r');
  });

  it('add: opens the form modal, optimistically appends a row, calls the action, toasts, refreshes', async () => {
    let resolveAdd: (v: MilestoneActionResult) => void = () => {};
    addMock.mockImplementation(() => new Promise((res) => (resolveAdd = res)));
    const user = userEvent.setup();
    renderRail([node({ id: 'a', title: 'First' })]);
    await user.click(screen.getByRole('button', { name: /^add milestone$/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Title'), 'Second milestone');
    await user.click(within(dialog).getByRole('button', { name: /^add milestone$/i }));

    // Optimistic append is visible while the transition is pending.
    await waitFor(() => expect(screen.getByText('Second milestone')).toBeInTheDocument());
    expect(addMock).toHaveBeenCalledWith(
      expect.objectContaining({ engagementId: 'eng-1', title: 'Second milestone' })
    );

    await act(async () => {
      resolveAdd({ success: true, milestoneId: 'm-new', status: 'pending' });
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Milestone added'));
    expect(refresh).toHaveBeenCalled();
  });

  it('add from empty: appends and calls the action', async () => {
    const user = userEvent.setup();
    renderRail([]);
    await user.click(screen.getByRole('button', { name: /add the first milestone/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Title'), 'Kickoff');
    await user.click(within(dialog).getByRole('button', { name: /^add milestone$/i }));
    await waitFor(() =>
      expect(addMock).toHaveBeenCalledWith(
        expect.objectContaining({ engagementId: 'eng-1', title: 'Kickoff' })
      )
    );
    expect(toast.success).toHaveBeenCalledWith('Milestone added');
  });

  it('edit: opens the prefilled modal, calls updateMilestoneAction, toasts, refreshes', async () => {
    const user = userEvent.setup();
    renderRail([node({ id: 'a', title: 'First', descriptionText: 'Old description' })]);
    await user.click(screen.getByRole('button', { name: /edit First/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Title')).toHaveValue('First');
    expect(within(dialog).getByLabelText('Description (optional)')).toHaveValue('Old description');
    const title = within(dialog).getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'First (edited)');
    await user.click(within(dialog).getByRole('button', { name: /save changes/i }));
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          engagementId: 'eng-1',
          milestoneId: 'a',
          title: 'First (edited)',
        })
      )
    );
    expect(toast.success).toHaveBeenCalledWith('Milestone updated');
    expect(refresh).toHaveBeenCalled();
  });

  it('remove: opens the confirm, optimistically drops the row, calls the action, toasts', async () => {
    let resolveRemove: (v: MilestoneActionResult) => void = () => {};
    removeMock.mockImplementation(() => new Promise((res) => (resolveRemove = res)));
    const user = userEvent.setup();
    renderRail([node({ id: 'a', title: 'First' }), node({ id: 'b', title: 'Second' })]);
    await user.click(screen.getByRole('button', { name: /remove First/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /remove milestone/i }));

    // Optimistic drop while the transition is pending — the row (and its edit control)
    // is gone; "Second" remains.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /edit First/i })).not.toBeInTheDocument()
    );
    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(removeMock).toHaveBeenCalledWith({ engagementId: 'eng-1', milestoneId: 'a' });

    await act(async () => {
      resolveRemove({ success: true, milestoneId: 'a', status: 'pending' });
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Milestone removed'));
    expect(refresh).toHaveBeenCalled();
  });

  it('remove of a completed milestone shows the danger copy', async () => {
    const user = userEvent.setup();
    renderRail([
      node({
        id: 'a',
        title: 'First',
        status: 'completed',
        nodeVariant: 'completed',
        statusLabel: 'Completed',
      }),
    ]);
    await user.click(screen.getByRole('button', { name: /remove First/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/is already complete/i)).toBeInTheDocument();
  });

  it('reorder: moving a row down calls reorderMilestonesAction with the new id order, toasts', async () => {
    const user = userEvent.setup();
    renderRail([node({ id: 'a', title: 'First' }), node({ id: 'b', title: 'Second' })]);
    await user.click(screen.getByRole('button', { name: /move First down/i }));
    await waitFor(() =>
      expect(reorderMock).toHaveBeenCalledWith({
        engagementId: 'eng-1',
        orderedMilestoneIds: ['b', 'a'],
      })
    );
    expect(toast.success).toHaveBeenCalledWith('Order updated');
    expect(refresh).toHaveBeenCalled();
  });

  it('add failure: toasts the returned error verbatim and refreshes', async () => {
    addMock.mockResolvedValue({ success: false, error: 'The delivery plan is locked.' });
    const user = userEvent.setup();
    renderRail([node({ id: 'a', title: 'First' })]);
    await user.click(screen.getByRole('button', { name: /^add milestone$/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Title'), 'Second milestone');
    await user.click(within(dialog).getByRole('button', { name: /^add milestone$/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The delivery plan is locked.'));
    expect(refresh).toHaveBeenCalled();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderRail([
      node({ id: 'a', title: 'First' }),
      node({ id: 'b', title: 'Second' }),
    ]);
    expect(await axe(container)).toHaveNoViolations();
  });
});
