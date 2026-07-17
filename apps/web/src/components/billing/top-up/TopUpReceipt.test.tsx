import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { track, CREDIT_EVENTS } from '@/lib/analytics';
import { TopUpReceipt } from './TopUpReceipt';
import type { PurchaseCompletion } from './PaymentSection';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function completion(overrides: Partial<PurchaseCompletion> = {}): PurchaseCompletion {
  return {
    amountMinor: 100_000,
    promoMinor: 0,
    promoCode: null,
    lowBalanceMode: 'notify_only',
    mandateCaptured: false,
    ...overrides,
  };
}

describe('TopUpReceipt', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the optimistic new balance and fires PURCHASE_COMPLETED', () => {
    render(
      <TopUpReceipt
        completion={completion()}
        previousBalanceMinor={50_000}
        onFindExpert={vi.fn()}
        onDone={vi.fn()}
      />
    );
    expect(screen.getByText(/You're topped up/i)).toBeInTheDocument();
    // 50,000 + 100,000 = 150,000 minor → A$1,500.00
    expect(screen.getAllByText('A$1,500.00').length).toBeGreaterThan(0);
    expect(track).toHaveBeenCalledWith(
      CREDIT_EVENTS.PURCHASE_COMPLETED,
      expect.objectContaining({ amount_minor: 100_000, promo_applied: false })
    );
  });

  it('fires PROMO_REDEEMED and MANDATE_CAPTURED when applicable', () => {
    render(
      <TopUpReceipt
        completion={completion({
          promoMinor: 5_000,
          promoCode: 'WELCOME50',
          lowBalanceMode: 'keep_going',
          mandateCaptured: true,
        })}
        previousBalanceMinor={0}
        onFindExpert={vi.fn()}
        onDone={vi.fn()}
      />
    );
    expect(track).toHaveBeenCalledWith(CREDIT_EVENTS.PROMO_REDEEMED, {
      code: 'WELCOME50',
      bonus_minor: 5_000,
    });
    expect(track).toHaveBeenCalledWith(CREDIT_EVENTS.MANDATE_CAPTURED, {
      low_balance_mode: 'keep_going',
    });
  });

  it('shows a gentle note when a card-backed mode was chosen but the mandate did not complete', () => {
    render(
      <TopUpReceipt
        completion={completion({ lowBalanceMode: 'keep_going', mandateCaptured: false })}
        previousBalanceMinor={0}
        onFindExpert={vi.fn()}
        onDone={vi.fn()}
      />
    );
    expect(screen.getByText(/couldn't finish setting up automatic charging/i)).toBeInTheDocument();
  });

  it('omits the mandate note when the mandate completed', () => {
    render(
      <TopUpReceipt
        completion={completion({ lowBalanceMode: 'keep_going', mandateCaptured: true })}
        previousBalanceMinor={0}
        onFindExpert={vi.fn()}
        onDone={vi.fn()}
      />
    );
    expect(
      screen.queryByText(/couldn't finish setting up automatic charging/i)
    ).not.toBeInTheDocument();
  });

  it('omits the mandate note for notify_only (no mandate was ever intended)', () => {
    render(
      <TopUpReceipt
        completion={completion({ lowBalanceMode: 'notify_only', mandateCaptured: false })}
        previousBalanceMinor={0}
        onFindExpert={vi.fn()}
        onDone={vi.fn()}
      />
    );
    expect(
      screen.queryByText(/couldn't finish setting up automatic charging/i)
    ).not.toBeInTheDocument();
  });

  it('routes the next-best-actions', async () => {
    const onFindExpert = vi.fn();
    const onDone = vi.fn();
    render(
      <TopUpReceipt
        completion={completion()}
        previousBalanceMinor={0}
        onFindExpert={onFindExpert}
        onDone={onDone}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /Find an expert/i }));
    expect(onFindExpert).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /Done/i }));
    expect(onDone).toHaveBeenCalled();
  });
});
