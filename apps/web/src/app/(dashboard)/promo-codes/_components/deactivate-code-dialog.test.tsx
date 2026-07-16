import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { makePromoRow as makeRow } from '@/test/fixtures/promo-codes';

const { mockDeactivate, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockDeactivate: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));
vi.mock('../_actions/deactivate-promo-code', () => ({
  deactivatePromoCode: (...a: unknown[]) => mockDeactivate(...a),
}));
vi.mock('sonner', () => ({ toast: { success: mockToastSuccess, error: mockToastError } }));

import { DeactivateCodeDialog } from './deactivate-code-dialog';

beforeEach(() => {
  vi.clearAllMocks();
  mockDeactivate.mockResolvedValue({ success: true });
});

describe('DeactivateCodeDialog', () => {
  it('renders nothing when there is no row', () => {
    render(<DeactivateCodeDialog row={null} onOpenChange={vi.fn()} />);
    expect(
      screen.queryByRole('heading', { name: /deactivate this code/i })
    ).not.toBeInTheDocument();
  });

  it('confirms and shows the code being deactivated', () => {
    render(<DeactivateCodeDialog row={makeRow()} onOpenChange={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /deactivate this code/i })).toBeInTheDocument();
    expect(screen.getByText('WELCOME50')).toBeInTheDocument();
  });

  it('calls the action, toasts, and closes on confirm', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<DeactivateCodeDialog row={makeRow()} onOpenChange={onOpenChange} />);
    await user.click(screen.getByRole('button', { name: /^deactivate$/i }));

    await waitFor(() => expect(mockDeactivate).toHaveBeenCalledWith({ id: 'p-1' }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('toasts the error and stays open on failure', async () => {
    mockDeactivate.mockResolvedValue({ success: false, error: 'This code no longer exists.' });
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<DeactivateCodeDialog row={makeRow()} onOpenChange={onOpenChange} />);
    await user.click(screen.getByRole('button', { name: /^deactivate$/i }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('This code no longer exists.'));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
