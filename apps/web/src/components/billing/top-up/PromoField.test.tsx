import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockValidate = vi.fn();
vi.mock('@/lib/credit/actions', () => ({
  validatePromoAction: (...a: unknown[]) => mockValidate(...a),
}));

import { PromoField } from './PromoField';

/** Open the disclosure, which starts collapsed to a quiet link. */
async function expand(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: /have a promo code/i }));
}

describe('PromoField', () => {
  beforeEach(() => vi.clearAllMocks());

  it('applies a valid code and reports the bonus to the parent', async () => {
    mockValidate.mockResolvedValue({ ok: true, grantMinor: 5_000, promoCodeId: 'promo-1' });
    const onApplied = vi.fn();
    render(<PromoField promo={null} onApplied={onApplied} onRemoved={vi.fn()} />);

    await expand();
    await userEvent.type(screen.getByLabelText(/promo code/i), 'welcome50');
    await userEvent.click(screen.getByRole('button', { name: /apply/i }));

    expect(mockValidate).toHaveBeenCalledWith('WELCOME50');
    expect(onApplied).toHaveBeenCalledWith({
      code: 'WELCOME50',
      minor: 5_000,
      promoCodeId: 'promo-1',
    });
  });

  it('shows a per-reason error line on a failed code without blocking', async () => {
    mockValidate.mockResolvedValue({ ok: false, reason: 'expired' });
    render(<PromoField promo={null} onApplied={vi.fn()} onRemoved={vi.fn()} />);

    await expand();
    await userEvent.type(screen.getByLabelText(/promo code/i), 'OLD');
    await userEvent.click(screen.getByRole('button', { name: /apply/i }));

    expect(await screen.findByText(/that code has expired/i)).toBeInTheDocument();
  });

  // ── Disclosure (top-up redesign) ─────────────────────────────────────────

  it('starts COLLAPSED as a quiet link — no codes are advertised on-screen', () => {
    render(<PromoField promo={null} onApplied={vi.fn()} onRemoved={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: /have a promo code/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('aria-controls', 'promo-disclosure');
    // Present in the DOM but hidden — the region is never unmounted.
    expect(document.getElementById('promo-disclosure')).toHaveAttribute('hidden');
  });

  it('focuses the input on expand (autoFocus cannot fire — the input never remounts)', async () => {
    render(<PromoField promo={null} onApplied={vi.fn()} onRemoved={vi.fn()} />);
    await expand();
    expect(document.getElementById('promo-disclosure')).not.toHaveAttribute('hidden');
    expect(screen.getByLabelText(/promo code/i)).toHaveFocus();
  });

  it('PRESERVES a typed value across collapse and re-expand', async () => {
    render(<PromoField promo={null} onApplied={vi.fn()} onRemoved={vi.fn()} />);

    await expand();
    await userEvent.type(screen.getByLabelText(/promo code/i), 'HALFTYPED');
    await userEvent.click(screen.getByRole('button', { name: /close promo field/i }));
    await expand();

    // The prototype's close handler clears the value; deliberately not copied.
    expect(screen.getByLabelText(/promo code/i)).toHaveValue('HALFTYPED');
  });

  it('force-opens on a failure and STAYS open — a collapsed field can never hide a problem', async () => {
    mockValidate.mockResolvedValue({ ok: false, reason: 'invalid' });
    render(<PromoField promo={null} onApplied={vi.fn()} onRemoved={vi.fn()} />);

    await expand();
    await userEvent.type(screen.getByLabelText(/promo code/i), 'NOPE');
    await userEvent.click(screen.getByRole('button', { name: /apply/i }));

    expect(await screen.findByText(/isn't valid/i)).toBeInTheDocument();
    expect(document.getElementById('promo-disclosure')).not.toHaveAttribute('hidden');
    // The collapse trigger is gone while the section is open.
    expect(screen.queryByRole('button', { name: /have a promo code/i })).not.toBeInTheDocument();
  });

  it('clears the error but not the value when closed', async () => {
    mockValidate.mockResolvedValue({ ok: false, reason: 'invalid' });
    render(<PromoField promo={null} onApplied={vi.fn()} onRemoved={vi.fn()} />);

    await expand();
    await userEvent.type(screen.getByLabelText(/promo code/i), 'NOPE');
    await userEvent.click(screen.getByRole('button', { name: /apply/i }));
    await screen.findByText(/isn't valid/i);

    await userEvent.click(screen.getByRole('button', { name: /close promo field/i }));

    expect(screen.queryByText(/isn't valid/i)).not.toBeInTheDocument();
    await expand();
    expect(screen.getByLabelText(/promo code/i)).toHaveValue('NOPE');
  });

  it('never collapses the applied green row', () => {
    render(
      <PromoField
        promo={{ code: 'WELCOME50', minor: 5_000, promoCodeId: 'promo-1' }}
        onApplied={vi.fn()}
        onRemoved={vi.fn()}
      />
    );
    expect(screen.getByText(/WELCOME50 applied/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /have a promo code/i })).not.toBeInTheDocument();
  });

  it('renders the applied success row with a remove control', async () => {
    const onRemoved = vi.fn();
    render(
      <PromoField
        promo={{ code: 'WELCOME50', minor: 5_000, promoCodeId: 'promo-1' }}
        onApplied={vi.fn()}
        onRemoved={onRemoved}
      />
    );
    expect(screen.getByText(/WELCOME50 applied/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /remove promo/i }));
    expect(onRemoved).toHaveBeenCalled();
  });
});
