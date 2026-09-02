import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { track, CREDIT_EVENTS } from '@/lib/analytics';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh, push: vi.fn(), back: vi.fn() }),
}));

const mockGetStatus = vi.fn();
vi.mock('@/lib/credit/actions', () => ({
  getTopUpCreditStatusAction: (...a: unknown[]) => mockGetStatus(...a),
}));

import { toast } from 'sonner';
import { TopUpReceipt } from './TopUpReceipt';
import { TOPUP_POLL_FAST_INTERVAL_MS, TOPUP_POLL_WINDOW_MS } from './use-topup-credit-poll';
import type { PurchaseCompletion } from './types';

function completion(overrides: Partial<PurchaseCompletion> = {}): PurchaseCompletion {
  return {
    amountMinor: 100_000,
    promoMinor: 0,
    promoCode: null,
    lowBalanceMode: 'notify_only',
    mandateCaptured: false,
    paymentIntentId: 'pi_3QabcdefGHIJKL99',
    ...overrides,
  };
}

function renderReceipt(overrides: Partial<PurchaseCompletion> = {}, previousBalanceMinor = 50_000) {
  return render(
    <TopUpReceipt
      completion={completion(overrides)}
      previousBalanceMinor={previousBalanceMinor}
      onFindExpert={vi.fn()}
      onDone={vi.fn()}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // The default answer is the HONEST one: the webhook is asynchronous, so a fresh receipt has
  // nothing confirmed yet.
  mockGetStatus.mockResolvedValue({ status: 'pending', balanceMinor: 50_000 });
});

describe('TopUpReceipt — ⚠ the defect: it must never assert a balance it did not read', () => {
  it('shows "Payment received" and NO computed balance while the credit is unconfirmed', async () => {
    // ⚠⚠ THE REPLACED TEST. This case previously asserted `A$1,500.00` — the client sum
    // `50,000 + 100,000` — which is exactly the bug: that figure rendered identically whether or
    // not the wallet was ever credited, and in the real incident it sat beside a top-bar chip
    // reading A$0.00. Pinning it would have forced a revert of the fix to get green.
    renderReceipt();

    expect(await screen.findByText(/Payment received/i)).toBeInTheDocument();
    expect(screen.queryByText(/You're topped up/i)).not.toBeInTheDocument();
    expect(screen.queryByText('A$1,500.00')).not.toBeInTheDocument();
    // And no row ever calls an unconfirmed figure the "New balance".
    expect(screen.queryByText('New balance')).not.toBeInTheDocument();
    expect(screen.getByText(/Balance right now/i)).toBeInTheDocument();
  });

  it('⚠ renders the SERVER balance on confirmation, even when it differs from previous + amount + promo', async () => {
    // 50,000 + 100,000 + 5,000 = 155,000. The server says 137,500 — e.g. a concurrent session
    // drawdown, or a promo skipped at settlement. The READ wins. This is the standing guard
    // against arithmetic creeping back in.
    mockGetStatus.mockResolvedValue({ status: 'credited', balanceMinor: 137_500 });
    renderReceipt({ promoMinor: 5_000, promoCode: 'WELCOME50' });

    expect(await screen.findByText(/You're topped up/i)).toBeInTheDocument();
    expect(screen.getAllByText('A$1,375.00').length).toBeGreaterThan(0);
    expect(screen.queryByText('A$1,550.00')).not.toBeInTheDocument();
    expect(screen.getByText('New balance')).toBeInTheDocument();
  });

  it('uses the previous balance ONLY as the placeholder for "Balance right now", never as an addend', async () => {
    mockGetStatus.mockResolvedValue({ status: 'pending', balanceMinor: 50_000 });
    renderReceipt({}, 50_000);

    expect(await screen.findByText(/Payment received/i)).toBeInTheDocument();
    // The placeholder shows the buyer's CURRENT balance, marked as still moving.
    expect(screen.getByText(/A\$500\.00 · updating/)).toBeInTheDocument();
  });
});

describe('TopUpReceipt — ⚠⚠ the chip fix: router.refresh on the confirmation transition', () => {
  it('does NOT refresh on mount (the webhook has not even begun then)', async () => {
    renderReceipt();

    expect(await screen.findByText(/Payment received/i)).toBeInTheDocument();
    // A blind refresh here reads the wallet milliseconds after confirmPayment and
    // authoritatively repaints A$0.00 beside the receipt. That is the rejected fix.
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('refreshes EXACTLY ONCE, on the pending → credited transition', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockGetStatus
        .mockResolvedValueOnce({ status: 'pending', balanceMinor: 50_000 })
        .mockResolvedValue({ status: 'credited', balanceMinor: 150_000 });
      renderReceipt();

      // First read lands: still pending, and still no refresh.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(screen.getByText(/Payment received/i)).toBeInTheDocument();
      expect(mockRefresh).not.toHaveBeenCalled();

      // Second read confirms. Re-running the `(dashboard)` layout is the whole chip fix:
      // `loadTopBarWalletData` is an uncached DB read, so the chip repaints from the same
      // truth the receipt just confirmed against.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TOPUP_POLL_FAST_INTERVAL_MS);
      });
      expect(screen.getByText(/You're topped up/i)).toBeInTheDocument();
      expect(mockRefresh).toHaveBeenCalledTimes(1);

      // The poll is terminal on `credited`, and the latch means no second refresh either way.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TOPUP_POLL_WINDOW_MS);
      });
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('TopUpReceipt — the unconfirmed (window-closed) state', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tells the buyer the money is safe, claims NO new balance, and stops calling the action', async () => {
    mockGetStatus.mockResolvedValue({ status: 'pending', balanceMinor: 0 });
    render(
      <TopUpReceipt
        completion={completion({ promoMinor: 5_000, promoCode: 'WELCOME50' })}
        previousBalanceMinor={0}
        onFindExpert={vi.fn()}
        onDone={vi.fn()}
      />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOPUP_POLL_WINDOW_MS + 5_000);
    });

    expect(screen.getByText(/your balance is still catching up/i)).toBeInTheDocument();
    expect(screen.getByText(/it's safe with us/i)).toBeInTheDocument();
    expect(screen.getByText(/No need to pay again/i)).toBeInTheDocument();
    // ⚠ NO NUMBER LABELLED "New balance", EVER, IN THIS STATE.
    expect(screen.queryByText('New balance')).not.toBeInTheDocument();
    expect(screen.queryByText(/You're topped up/i)).not.toBeInTheDocument();
    // A bonus we never saw land is not advertised here either.
    expect(screen.queryByText(/Promo bonus/i)).not.toBeInTheDocument();
    // And it never claimed the credit, so the chip is never refreshed on a lie.
    expect(mockRefresh).not.toHaveBeenCalled();

    const callsAtCap = mockGetStatus.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOPUP_POLL_WINDOW_MS);
    });
    expect(mockGetStatus.mock.calls).toHaveLength(callsAtCap);
  });

  it('offers a support reference — the last 8 of the PaymentIntent id', async () => {
    render(
      <TopUpReceipt
        completion={completion({ paymentIntentId: 'pi_3QabcdefGHIJKL99' })}
        previousBalanceMinor={0}
        onFindExpert={vi.fn()}
        onDone={vi.fn()}
      />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOPUP_POLL_WINDOW_MS + 5_000);
    });

    expect(screen.getByText('efGHIJKL99'.slice(-8))).toBeInTheDocument();
  });
});

describe('TopUpReceipt — analytics', () => {
  it('fires PURCHASE_COMPLETED on mount, tagged credit_status: pending', async () => {
    renderReceipt();

    // ⚠ ON MOUNT AND UNRENAMED, deliberately: delaying it would drop the funnel step whenever a
    // tab closes. The money truth is the SERVER event; the gap between them is the alarm.
    expect(track).toHaveBeenCalledWith(
      CREDIT_EVENTS.PURCHASE_COMPLETED,
      expect.objectContaining({
        amount_minor: 100_000,
        promo_applied: false,
        credit_status: 'pending',
      })
    );
    await screen.findByText(/Payment received/i);
  });

  it('⚠ holds PROMO_REDEEMED until the credit is CONFIRMED (undercount beats overcount)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockGetStatus
        .mockResolvedValueOnce({ status: 'pending', balanceMinor: 0 })
        .mockResolvedValue({ status: 'credited', balanceMinor: 105_000 });
      renderReceipt({ promoMinor: 5_000, promoCode: 'WELCOME50' });

      // The bonus is re-validated at settlement and can be SKIPPED while the base purchase still
      // credits, so firing on mount overstated promo cost.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(track).not.toHaveBeenCalledWith(CREDIT_EVENTS.PROMO_REDEEMED, expect.anything());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(TOPUP_POLL_FAST_INTERVAL_MS);
      });
      expect(track).toHaveBeenCalledWith(CREDIT_EVENTS.PROMO_REDEEMED, {
        code: 'WELCOME50',
        bonus_minor: 5_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('never fires PROMO_REDEEMED when the credit is never confirmed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockGetStatus.mockResolvedValue({ status: 'pending', balanceMinor: 0 });
    renderReceipt({ promoMinor: 5_000, promoCode: 'WELCOME50' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOPUP_POLL_WINDOW_MS + 5_000);
    });

    expect(track).not.toHaveBeenCalledWith(CREDIT_EVENTS.PROMO_REDEEMED, expect.anything());
    vi.useRealTimers();
  });

  it('fires MANDATE_CAPTURED on mount when a card-backed mode captured its mandate', async () => {
    // A different axis from the credit: it is about FUTURE automatic charging, and the browser
    // genuinely observed it, so it stays on mount.
    renderReceipt({ lowBalanceMode: 'keep_going', mandateCaptured: true });

    expect(track).toHaveBeenCalledWith(CREDIT_EVENTS.MANDATE_CAPTURED, {
      low_balance_mode: 'keep_going',
    });
    await screen.findByText(/Payment received/i);
  });
});

describe('TopUpReceipt — toasts', () => {
  it('confirms only the PAYMENT on mount — it does not claim the money was "added"', async () => {
    renderReceipt();

    expect(toast.success).toHaveBeenCalledWith('Payment confirmed — A$1,000.00.');
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringMatching(/added/i));
    await screen.findByText(/Payment received/i);
  });

  it('adds a second toast on the confirmation transition, and no tick ever toasts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockGetStatus
        .mockResolvedValueOnce({ status: 'pending', balanceMinor: 0 })
        .mockResolvedValueOnce({ status: 'pending', balanceMinor: 0 })
        .mockResolvedValue({ status: 'credited', balanceMinor: 100_000 });
      renderReceipt();

      // Two pending ticks pass in silence — a poll must never narrate itself.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TOPUP_POLL_FAST_INTERVAL_MS);
      });
      expect(vi.mocked(toast.success).mock.calls).toHaveLength(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(TOPUP_POLL_FAST_INTERVAL_MS);
      });
      expect(toast.success).toHaveBeenCalledWith('A$1,000.00 is in your balance.');
      // Exactly two overall: the mount confirmation and the credited transition.
      expect(vi.mocked(toast.success).mock.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('TopUpReceipt — state-independent chrome', () => {
  it('keeps the rolling-expiry reassurance in every state', async () => {
    renderReceipt();
    expect(
      screen.getByText(/Any consultation or top-up keeps your balance going/i)
    ).toBeInTheDocument();
    await screen.findByText(/Payment received/i);
  });

  it('shows a gentle note when a card-backed mode was chosen but the mandate did not complete', async () => {
    renderReceipt({ lowBalanceMode: 'keep_going', mandateCaptured: false });
    expect(screen.getByText(/couldn't finish setting up automatic charging/i)).toBeInTheDocument();
    await screen.findByText(/Payment received/i);
  });

  it('omits the mandate note when the mandate completed', async () => {
    renderReceipt({ lowBalanceMode: 'keep_going', mandateCaptured: true });
    expect(
      screen.queryByText(/couldn't finish setting up automatic charging/i)
    ).not.toBeInTheDocument();
    await screen.findByText(/Payment received/i);
  });

  it('omits the mandate note for notify_only (no mandate was ever intended)', async () => {
    renderReceipt({ lowBalanceMode: 'notify_only', mandateCaptured: false });
    expect(
      screen.queryByText(/couldn't finish setting up automatic charging/i)
    ).not.toBeInTheDocument();
    await screen.findByText(/Payment received/i);
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
