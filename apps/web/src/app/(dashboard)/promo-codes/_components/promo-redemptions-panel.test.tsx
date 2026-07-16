import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import {
  makePromoRow as makeRow,
  makePromoRedemptionRow as makeRedemption,
} from '@/test/fixtures/promo-codes';
import { PromoRedemptionsPanel } from './promo-redemptions-panel';

describe('PromoRedemptionsPanel', () => {
  it('shows an informative empty state (remaining = full cap) when there are no redemptions', () => {
    render(
      <PromoRedemptionsPanel
        row={makeRow({ redeemedCount: 0, remaining: 100, usedPct: 0 })}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText('No redemptions yet')).toBeInTheDocument();
    expect(screen.getByText('All 100 redemptions are still available.')).toBeInTheDocument();
    // The header still states the remaining cap.
    expect(screen.getByText(/Remaining:/)).toHaveTextContent('100 of 100');
  });

  it('lists redemptions with company, actor, grant, and remaining cap', () => {
    const row = makeRow({
      redeemedCount: 1,
      remaining: 99,
      redemptions: [makeRedemption()],
    });
    render(<PromoRedemptionsPanel row={row} onClose={vi.fn()} />);
    expect(screen.getByText('Northwind Industrial')).toBeInTheDocument();
    expect(screen.getByText('Dana Whitfield')).toBeInTheDocument();
    expect(screen.getByText('A$50.00')).toBeInTheDocument();
    expect(screen.getByText(/Remaining:/)).toHaveTextContent('99 of 100');
    expect(screen.queryByText('No redemptions yet')).not.toBeInTheDocument();
  });

  it('renders "System" when there is no human actor on a redemption', () => {
    const row = makeRow({
      redeemedCount: 1,
      remaining: 99,
      redemptions: [makeRedemption({ actorLabel: null })],
    });
    render(<PromoRedemptionsPanel row={row} onClose={vi.fn()} />);
    expect(screen.getByText('System')).toBeInTheDocument();
  });

  it('fires onClose when the close control is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<PromoRedemptionsPanel row={makeRow()} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: /close redemptions/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
