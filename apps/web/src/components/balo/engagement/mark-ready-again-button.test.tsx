import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';

import { render, screen, waitFor } from '@/test/utils';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/request-completion', () => ({
  requestCompletionAction: vi.fn(),
}));

import { MarkReadyAgainButton } from './mark-ready-again-button';
import { requestCompletionAction } from '@/app/(dashboard)/engagements/[id]/_actions/request-completion';
import { toast } from 'sonner';

const requestMock = vi.mocked(requestCompletionAction);

function setup(): void {
  render(
    <MarkReadyAgainButton
      engagementId="eng-1"
      ctaLabel="Mark project ready again"
      modalBody="All 2 milestones are delivered."
      clientCompanyName="Northwind"
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requestMock.mockResolvedValue({ success: true });
});

describe('MarkReadyAgainButton', () => {
  it('opens a dialog titled with the CTA label and the pre-derived body', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Mark project ready again' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Mark project ready again' })).toBeInTheDocument();
    expect(screen.getByText('All 2 milestones are delivered.')).toBeInTheDocument();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('sends the project on confirm, toasts and refreshes', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Mark project ready again' }));
    await user.click(await screen.findByRole('button', { name: /Send for Northwind's review/i }));

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith({ engagementId: 'eng-1' });
    });
    expect(toast.success).toHaveBeenCalledWith('Project sent for review');
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('toasts the returned error and keeps the page honest on failure', async () => {
    requestMock.mockResolvedValue({
      success: false,
      error: 'Not every milestone is complete yet.',
    });
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Mark project ready again' }));
    await user.click(await screen.findByRole('button', { name: /Send for Northwind's review/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Not every milestone is complete yet.');
    });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('closes the dialog from "Not yet" without calling the action', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Mark project ready again' }));
    await user.click(await screen.findByRole('button', { name: 'Not yet' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(requestMock).not.toHaveBeenCalled();
  });
});
