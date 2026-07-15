import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';

const mockShare = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/proposal/[relationshipId]/_actions/share', () => ({
  shareProposalWithColleague: (...a: unknown[]) => mockShare(...a),
}));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { ShareModal } from './share-modal';
import { toast } from 'sonner';

function renderModal(onOpenChange = vi.fn()): { onOpenChange: ReturnType<typeof vi.fn> } {
  render(<ShareModal open onOpenChange={onOpenChange} requestId="req-1" relationshipId="rel-1" />);
  return { onOpenChange };
}

/** A promise whose resolution we control, to hold the modal in `submitting`. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('ShareModal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the default state with email + note fields', () => {
    renderModal();
    expect(screen.getByText('Share this proposal')).toBeInTheDocument();
    expect(screen.getByLabelText(/Colleague's email/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Add a note/)).toBeInTheDocument();
  });

  it('keeps Send disabled and shows an inline error for a malformed email', async () => {
    const user = userEvent.setup();
    renderModal();

    const sendButton = screen.getByRole('button', { name: /Send/ });
    expect(sendButton).toBeDisabled();

    const emailField = screen.getByLabelText(/Colleague's email/);
    await user.type(emailField, 'not-an-email');
    await user.tab(); // blur → surfaces the inline error

    const error = await screen.findByText(/Enter a valid email address/);
    expect(error).toBeInTheDocument();
    expect(emailField).toHaveAttribute('aria-invalid', 'true');
    expect(emailField).toHaveAttribute('aria-describedby', 'share-email-error');
    expect(sendButton).toBeDisabled();
    expect(mockShare).not.toHaveBeenCalled();
  });

  it('clears the inline error and enables Send once the address is valid', async () => {
    const user = userEvent.setup();
    renderModal();

    const emailField = screen.getByLabelText(/Colleague's email/);
    await user.type(emailField, 'bad');
    await user.tab();
    expect(await screen.findByText(/Enter a valid email address/)).toBeInTheDocument();

    await user.type(emailField, '@northwind.com');
    await waitFor(() =>
      expect(screen.queryByText(/Enter a valid email address/)).not.toBeInTheDocument()
    );
    expect(screen.getByRole('button', { name: /Send/ })).toBeEnabled();
  });

  it('shows the success state and toasts after a successful send', async () => {
    mockShare.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/Colleague's email/), 'alex@northwind.com');
    await user.click(screen.getByRole('button', { name: /Send/ }));

    await waitFor(() => expect(screen.getByText('Sent to alex@northwind.com')).toBeInTheDocument());
    expect(toast.success).toHaveBeenCalledWith('Proposal shared with alex@northwind.com');
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('shows a retryable error and PRESERVES the inputs', async () => {
    mockShare.mockResolvedValue({ ok: false, error: 'send_failed' });
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/Colleague's email/), 'alex@northwind.com');
    await user.type(screen.getByLabelText(/Add a note/), 'Please review');
    await user.click(screen.getByRole('button', { name: /Send/ }));

    await waitFor(() =>
      expect(screen.getByText(/We couldn.t send that just now/)).toBeInTheDocument()
    );
    // Inputs are preserved so the user can retry without re-typing.
    expect(screen.getByLabelText(/Colleague's email/)).toHaveValue('alex@northwind.com');
    expect(screen.getByLabelText(/Add a note/)).toHaveValue('Please review');
  });

  it('disables Escape/backdrop dismissal while submitting', async () => {
    const d = deferred<{ ok: true }>();
    mockShare.mockReturnValue(d.promise);
    const user = userEvent.setup();
    const { onOpenChange } = renderModal();

    await user.type(screen.getByLabelText(/Colleague's email/), 'alex@northwind.com');
    await user.click(screen.getByRole('button', { name: /Send/ }));

    // Mid-send: the Send button is disabled and Escape must NOT close the modal.
    await waitFor(() => expect(screen.getByRole('button', { name: /Send/ })).toBeDisabled());
    await user.keyboard('{Escape}');
    expect(onOpenChange).not.toHaveBeenCalled();

    d.resolve({ ok: true });
    await waitFor(() => expect(screen.getByText('Sent to alex@northwind.com')).toBeInTheDocument());
  });
});
