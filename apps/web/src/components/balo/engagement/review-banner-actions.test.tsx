import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/withdraw-completion-request', () => ({
  withdrawCompletionRequestAction: vi.fn(),
}));

import { ReviewBannerActions } from './review-banner-actions';
import { withdrawCompletionRequestAction } from '@/app/(dashboard)/engagements/[id]/_actions/withdraw-completion-request';
import { toast } from 'sonner';

const withdrawMock = vi.mocked(withdrawCompletionRequestAction);

beforeEach(() => {
  vi.clearAllMocks();
  withdrawMock.mockResolvedValue({ success: true });
});

describe('ReviewBannerActions', () => {
  it('renders nothing for the client lens (D7 seam)', () => {
    const { container } = render(
      <ReviewBannerActions lens="client" engagementId="eng-1" clientCompanyName="Northwind" />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for the admin lens', () => {
    const { container } = render(
      <ReviewBannerActions lens="admin" engagementId="eng-1" clientCompanyName="Northwind" />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('expert lens: opens the modal and calls the withdraw action + toasts on confirm', async () => {
    const user = userEvent.setup();
    render(
      <ReviewBannerActions lens="expert" engagementId="eng-1" clientCompanyName="Northwind" />
    );

    await user.click(screen.getByRole('button', { name: /Withdraw request/i }));
    // The modal confirm button shares the label — pick the one inside the dialog.
    const dialog = await screen.findByRole('dialog');
    await user.click(
      screen.getAllByRole('button', { name: /Withdraw request/i }).find((b) => dialog.contains(b))!
    );

    await waitFor(() => {
      expect(withdrawMock).toHaveBeenCalledWith({ engagementId: 'eng-1' });
    });
    expect(toast.success).toHaveBeenCalledWith('Completion request withdrawn');
  });
});
