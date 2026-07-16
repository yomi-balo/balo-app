import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { makePromoRow as makeRow } from '@/test/fixtures/promo-codes';

const { mockUpdateCap, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockUpdateCap: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));
vi.mock('../_actions/update-promo-cap', () => ({
  updatePromoCap: (...a: unknown[]) => mockUpdateCap(...a),
}));
vi.mock('sonner', () => ({ toast: { success: mockToastSuccess, error: mockToastError } }));

import { EditCapDialog } from './edit-cap-dialog';

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateCap.mockResolvedValue({ success: true, newCap: 250 });
});

describe('EditCapDialog', () => {
  it('renders nothing when there is no row', () => {
    render(<EditCapDialog row={null} onOpenChange={vi.fn()} />);
    expect(screen.queryByRole('heading', { name: /edit redemption cap/i })).not.toBeInTheDocument();
  });

  it('prefills the current cap and shows the usage', () => {
    render(<EditCapDialog row={makeRow()} onOpenChange={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /edit redemption cap/i })).toBeInTheDocument();
    expect((screen.getByLabelText(/total redemption cap/i) as HTMLInputElement).value).toBe('100');
  });

  it('blocks a cap below the redeemed count client-side (no action call)', async () => {
    const user = userEvent.setup();
    render(<EditCapDialog row={makeRow()} onOpenChange={vi.fn()} />);
    const input = screen.getByLabelText(/total redemption cap/i);
    await user.clear(input);
    await user.type(input, '10');
    await user.click(screen.getByRole('button', { name: /save cap/i }));

    expect(
      screen.getByText("Cap can't be lower than the 30 redemptions already made.")
    ).toBeInTheDocument();
    expect(mockUpdateCap).not.toHaveBeenCalled();
  });

  it('updates the cap, toasts, and closes on success', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<EditCapDialog row={makeRow()} onOpenChange={onOpenChange} />);
    const input = screen.getByLabelText(/total redemption cap/i);
    await user.clear(input);
    await user.type(input, '250');
    await user.click(screen.getByRole('button', { name: /save cap/i }));

    await waitFor(() => expect(mockUpdateCap).toHaveBeenCalledWith({ id: 'p-1', newCap: 250 }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows the server error inline and stays open on failure', async () => {
    mockUpdateCap.mockResolvedValue({ success: false, error: 'This code no longer exists.' });
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<EditCapDialog row={makeRow()} onOpenChange={onOpenChange} />);
    const input = screen.getByLabelText(/total redemption cap/i);
    await user.clear(input);
    await user.type(input, '250');
    await user.click(screen.getByRole('button', { name: /save cap/i }));

    await waitFor(() =>
      expect(screen.getByText('This code no longer exists.')).toBeInTheDocument()
    );
    // A non-validation server failure surfaces inline AND toasts (matching mint/deactivate).
    expect(mockToastError).toHaveBeenCalledWith('This code no longer exists.');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('does not toast the client-side below-redeemed-count validation (inline only)', async () => {
    const user = userEvent.setup();
    render(<EditCapDialog row={makeRow()} onOpenChange={vi.fn()} />);
    const input = screen.getByLabelText(/total redemption cap/i);
    await user.clear(input);
    await user.type(input, '10');
    await user.click(screen.getByRole('button', { name: /save cap/i }));

    expect(
      screen.getByText("Cap can't be lower than the 30 redemptions already made.")
    ).toBeInTheDocument();
    expect(mockUpdateCap).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
  });
});
