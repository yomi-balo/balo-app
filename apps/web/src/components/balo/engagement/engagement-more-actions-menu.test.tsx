import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';

import { track, ENGAGEMENT_EVENTS } from '@/lib/analytics';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/cancel-engagement', () => ({
  cancelEngagementAction: vi.fn(),
}));

import { EngagementMoreActionsMenu } from './engagement-more-actions-menu';

const DIALOG = {
  body: 'Delivery stops straight away.',
  reasonHint: 'Both see this.',
  reviewNote: null,
};

function setup(deliveryStatus: 'active' | 'pending_acceptance' = 'active') {
  render(
    <EngagementMoreActionsMenu
      engagementId="eng-1"
      deliveryStatus={deliveryStatus}
      cancelDialog={DIALOG}
    />
  );
}

describe('EngagementMoreActionsMenu', () => {
  beforeEach(() => {
    vi.mocked(track).mockClear();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  it('lists Copy project link, a separator, then Cancel project', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Copy project link', 'Cancel project…']);
    expect(items[1]).toHaveAttribute('data-variant', 'destructive');
    expect(screen.getByRole('separator')).toBeInTheDocument();
  });

  it('copies the project link and toasts', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    setup();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Copy project link' }));
    expect(writeText).toHaveBeenCalledWith(`${globalThis.location.origin}/engagements/eng-1`);
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith('Link copied'));
  });

  it('toasts an error when the clipboard refuses', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    setup();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Copy project link' }));
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it('opens the cancel dialog and tracks it, then closes it on Keep', async () => {
    const user = userEvent.setup();
    setup('pending_acceptance');
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Cancel project…' }));
    expect(track).toHaveBeenCalledWith(ENGAGEMENT_EVENTS.CANCEL_DIALOG_OPENED, {
      engagement_id: 'eng-1',
      delivery_status: 'pending_acceptance',
    });
    expect(screen.getByRole('heading', { name: 'Cancel this project?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep the project' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
