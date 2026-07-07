import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor, act } from '@/test/utils';
import userEvent from '@testing-library/user-event';

import type { MilestoneNodeView } from '@/lib/engagement/engagement-view';
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

import { ExpertMilestoneRail } from './expert-milestone-rail';
import { toast } from 'sonner';
import { startMilestoneAction } from '@/app/(dashboard)/engagements/[id]/_actions/start-milestone';
import { completeMilestoneAction } from '@/app/(dashboard)/engagements/[id]/_actions/complete-milestone';
import { revertMilestoneAction } from '@/app/(dashboard)/engagements/[id]/_actions/revert-milestone';

const startMock = vi.mocked(startMilestoneAction);
const completeMock = vi.mocked(completeMilestoneAction);
const revertMock = vi.mocked(revertMilestoneAction);

function node(overrides: Partial<MilestoneNodeView> = {}): MilestoneNodeView {
  return {
    id: 'm-1',
    title: 'Discovery',
    descriptionHtml: null,
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

function renderRail(milestones: MilestoneNodeView[]) {
  return render(
    <ExpertMilestoneRail
      engagementId="eng-1"
      milestones={milestones}
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

  it('renders the notify footnote', () => {
    renderRail([node()]);
    expect(
      screen.getByText(
        'Northwind Industrial and Balo are notified when you complete or reopen a milestone.'
      )
    ).toBeInTheDocument();
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
