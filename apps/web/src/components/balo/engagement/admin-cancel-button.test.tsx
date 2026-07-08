import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/cancel-engagement', () => ({
  cancelEngagementAction: vi.fn(),
}));

import { AdminCancelButton } from './admin-cancel-button';
import { cancelEngagementAction } from '@/app/(dashboard)/engagements/[id]/_actions/cancel-engagement';
import { toast } from 'sonner';

const cancelMock = vi.mocked(cancelEngagementAction);

beforeEach(() => {
  vi.clearAllMocks();
  cancelMock.mockResolvedValue({ success: true });
});

describe('AdminCancelButton', () => {
  it('renders the trigger and opens the cancel dialog', async () => {
    const user = userEvent.setup();
    render(<AdminCancelButton engagementId="eng-1" />);
    await user.click(screen.getByRole('button', { name: /Cancel engagement/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Reason')).toBeInTheDocument();
  });

  it('calls the cancel action with the reason on confirm', async () => {
    const user = userEvent.setup();
    render(<AdminCancelButton engagementId="eng-1" />);
    await user.click(screen.getByRole('button', { name: /Cancel engagement/i }));

    const dialog = await screen.findByRole('dialog');
    await user.type(screen.getByLabelText('Reason'), 'Client changed direction.');
    await user.click(
      screen.getAllByRole('button', { name: 'Cancel engagement' }).find((b) => dialog.contains(b))!
    );

    await waitFor(() => {
      expect(cancelMock).toHaveBeenCalledWith({
        engagementId: 'eng-1',
        reason: 'Client changed direction.',
      });
    });
    expect(toast.success).toHaveBeenCalledWith('Engagement cancelled');
  });
});
