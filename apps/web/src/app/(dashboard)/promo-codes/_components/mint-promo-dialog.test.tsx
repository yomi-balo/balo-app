import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';

const { mockCreate, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));
vi.mock('../_actions/create-promo-code', () => ({
  createPromoCode: (...a: unknown[]) => mockCreate(...a),
}));
vi.mock('sonner', () => ({ toast: { success: mockToastSuccess, error: mockToastError } }));

import { MintPromoDialog } from './mint-promo-dialog';

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue({ success: true, promoCodeId: 'p-1', code: 'WELCOME50' });
});

async function fillValid(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText('Code'), 'WELCOME50');
  await user.type(screen.getByLabelText(/Grant per redemption/i), '50');
  await user.type(screen.getByLabelText('Redemption cap'), '100');
}

describe('MintPromoDialog', () => {
  it('renders the mint form fields', () => {
    render(<MintPromoDialog open onOpenChange={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /mint a promo code/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Code')).toBeInTheDocument();
    expect(screen.getByLabelText(/Grant per redemption/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Redemption cap')).toBeInTheDocument();
    expect(screen.getByLabelText('Valid from')).toBeInTheDocument();
    expect(screen.getByLabelText('Valid until')).toBeInTheDocument();
  });

  it('blocks submit and shows a field error for a malformed code (no action call)', async () => {
    const user = userEvent.setup();
    render(<MintPromoDialog open onOpenChange={vi.fn()} />);
    await user.type(screen.getByLabelText('Code'), 'no');
    await user.type(screen.getByLabelText(/Grant per redemption/i), '50');
    await user.type(screen.getByLabelText('Redemption cap'), '100');
    await user.click(screen.getByRole('button', { name: /mint code/i }));

    expect(screen.getByText('Use 3–32 letters, numbers, or hyphens.')).toBeInTheDocument();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('converts the dollar grant to minor units and calls the action, then toasts + closes', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<MintPromoDialog open onOpenChange={onOpenChange} />);
    await fillValid(user);
    await user.click(screen.getByRole('button', { name: /mint code/i }));

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'WELCOME50',
          grantMinor: 5000, // $50.00 → 5000 minor units
          perCodeRedemptionCap: 100,
          validFrom: expect.any(String),
          validUntil: expect.any(String),
        })
      )
    );
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('maps a duplicate-code failure to a field-level error (no toast, stays open)', async () => {
    mockCreate.mockResolvedValue({
      success: false,
      error: 'A code with that name already exists.',
      field: 'code',
    });
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<MintPromoDialog open onOpenChange={onOpenChange} />);
    await fillValid(user);
    await user.click(screen.getByRole('button', { name: /mint code/i }));

    await waitFor(() =>
      expect(screen.getByText('A code with that name already exists.')).toBeInTheDocument()
    );
    expect(mockToastError).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
