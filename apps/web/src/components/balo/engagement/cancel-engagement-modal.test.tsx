import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';

import { track, ENGAGEMENT_EVENTS } from '@/lib/analytics';

const { run, cancelEngagementAction } = vi.hoisted(() => ({
  run: vi.fn(),
  cancelEngagementAction: vi.fn(),
}));
let mockPending = false;

vi.mock('./use-engagement-lifecycle-action', () => ({
  useEngagementLifecycleAction: () => ({ isPending: mockPending, run }),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/cancel-engagement', () => ({
  cancelEngagementAction,
}));

import { CancelEngagementModal } from './cancel-engagement-modal';

const DIALOG = {
  body: "Delivery stops straight away for Northwind and Priya's agency, and it can't be undone.",
  reasonHint: 'Northwind and CloudPeak both see this.',
  reviewNote: null,
};

function setup(overrides: Partial<React.ComponentProps<typeof CancelEngagementModal>> = {}) {
  const onClose = vi.fn();
  render(
    <CancelEngagementModal
      open
      engagementId="eng-1"
      deliveryStatus="active"
      dialog={DIALOG}
      onClose={onClose}
      {...overrides}
    />
  );
  return { onClose };
}

describe('CancelEngagementModal', () => {
  beforeEach(() => {
    mockPending = false;
    run.mockClear();
    cancelEngagementAction.mockReset().mockResolvedValue({ success: true });
    vi.mocked(track).mockClear();
  });

  it('states what happens, with the reason hint, and Cancel project disabled until a reason', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Cancel this project?' })).toBeInTheDocument();
    expect(screen.getByText(/Delivery stops straight away/)).toBeInTheDocument();
    expect(screen.getByText('Northwind and CloudPeak both see this.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel project' })).toBeDisabled();
  });

  it('gives "Keep the project" initial focus and never uses a solid destructive button', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Keep the project' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Cancel project' }).className).not.toMatch(
      /bg-destructive/
    );
  });

  it('shows the review note only when there is one', () => {
    setup({ dialog: { ...DIALOG, reviewNote: 'Priya has marked the project ready.' } });
    expect(screen.getByText('Priya has marked the project ready.')).toBeInTheDocument();
  });

  it('keeps the confirm disabled for a whitespace-only reason', async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Reason'), '   ');
    expect(screen.getByRole('button', { name: 'Cancel project' })).toBeDisabled();
  });

  it('cancels with the trimmed reason and closes', async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.type(screen.getByLabelText('Reason'), '  Client changed direction. ');
    await user.click(screen.getByRole('button', { name: 'Cancel project' }));
    expect(cancelEngagementAction).toHaveBeenCalledWith({
      engagementId: 'eng-1',
      reason: 'Client changed direction.',
    });
    expect(run).toHaveBeenCalledWith(expect.anything(), 'Project cancelled', onClose);
    // Closing is the hook's success callback: until it fires (a failure never calls it) the
    // dialog stays open with the reason in place.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Reason')).toHaveValue('  Client changed direction. ');
    const onSuccess = run.mock.calls[0]?.[2] as (() => void) | undefined;
    onSuccess?.();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(track).not.toHaveBeenCalledWith(ENGAGEMENT_EVENTS.CANCEL_DIALOG_KEPT, expect.anything());
  });

  it('uses the strong destructive text token for Cancel project', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Cancel project' })).toHaveClass(
      'text-destructive-strong'
    );
  });

  it('tracks a keep via the button', async () => {
    const user = userEvent.setup();
    const { onClose } = setup({ deliveryStatus: 'pending_acceptance' });
    await user.click(screen.getByRole('button', { name: 'Keep the project' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(ENGAGEMENT_EVENTS.CANCEL_DIALOG_KEPT, {
      engagement_id: 'eng-1',
      delivery_status: 'pending_acceptance',
      via: 'button',
    });
  });

  it('tracks a keep via Escape', async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(ENGAGEMENT_EVENTS.CANCEL_DIALOG_KEPT, {
      engagement_id: 'eng-1',
      delivery_status: 'active',
      via: 'dismiss',
    });
  });

  it('still lets the viewer keep the project while a cancel is in flight', async () => {
    const user = userEvent.setup();
    mockPending = true;
    const { onClose } = setup();
    const keep = screen.getByRole('button', { name: 'Keep the project' });
    expect(keep).toBeEnabled();
    await user.click(keep);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not track a keep when the dialog is closed while a cancel is in flight', async () => {
    const user = userEvent.setup();
    mockPending = true;
    const { onClose } = setup();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Keep the project' }));
    expect(onClose).toHaveBeenCalled();
    expect(track).not.toHaveBeenCalledWith(ENGAGEMENT_EVENTS.CANCEL_DIALOG_KEPT, expect.anything());
  });
});
