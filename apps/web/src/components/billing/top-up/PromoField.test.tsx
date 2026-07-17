import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockValidate = vi.fn();
vi.mock('@/lib/credit/actions', () => ({
  validatePromoAction: (...a: unknown[]) => mockValidate(...a),
}));

import { PromoField } from './PromoField';

describe('PromoField', () => {
  beforeEach(() => vi.clearAllMocks());

  it('applies a valid code and reports the bonus to the parent', async () => {
    mockValidate.mockResolvedValue({ ok: true, grantMinor: 5_000 });
    const onApplied = vi.fn();
    render(<PromoField promo={null} onApplied={onApplied} onRemoved={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/promo code/i), 'welcome50');
    await userEvent.click(screen.getByRole('button', { name: /apply/i }));

    expect(mockValidate).toHaveBeenCalledWith('WELCOME50');
    expect(onApplied).toHaveBeenCalledWith({ code: 'WELCOME50', minor: 5_000 });
  });

  it('shows a per-reason error line on a failed code without blocking', async () => {
    mockValidate.mockResolvedValue({ ok: false, reason: 'expired' });
    render(<PromoField promo={null} onApplied={vi.fn()} onRemoved={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/promo code/i), 'OLD');
    await userEvent.click(screen.getByRole('button', { name: /apply/i }));

    expect(await screen.findByText(/that code has expired/i)).toBeInTheDocument();
  });

  it('renders the applied success row with a remove control', async () => {
    const onRemoved = vi.fn();
    render(
      <PromoField
        promo={{ code: 'WELCOME50', minor: 5_000 }}
        onApplied={vi.fn()}
        onRemoved={onRemoved}
      />
    );
    expect(screen.getByText(/WELCOME50 applied/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /remove promo/i }));
    expect(onRemoved).toHaveBeenCalled();
  });
});
