import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

import { StatementPending } from './statement-pending';

describe('StatementPending (D-B)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the client "Charge pending" pill and body copy', () => {
    render(<StatementPending lens="client" />);
    expect(screen.getByText('Charge pending')).toBeInTheDocument();
    expect(screen.getByText(/finalizing the charge/)).toBeInTheDocument();
  });

  it('shows the expert "Payout pending" pill and body copy', () => {
    render(<StatementPending lens="expert" />);
    expect(screen.getByText('Payout pending')).toBeInTheDocument();
    expect(screen.getByText(/finalizing your earnings/)).toBeInTheDocument();
  });

  it('auto-polls at most 3 times, then stops permanently', () => {
    render(<StatementPending lens="client" />);
    vi.advanceTimersByTime(15_000);
    vi.advanceTimersByTime(15_000);
    vi.advanceTimersByTime(15_000);
    expect(mockRefresh).toHaveBeenCalledTimes(3);
    // A 4th, 5th tick must NOT re-arm.
    vi.advanceTimersByTime(15_000);
    vi.advanceTimersByTime(15_000);
    expect(mockRefresh).toHaveBeenCalledTimes(3);
  });

  // ⚠ THIS TEST MUST ACTUALLY ELAPSE THE WINDOW. It previously called `useRealTimers()` and
  // clicked immediately, so it never passed the polling window at all and would have passed
  // identically if the button were disabled after attempt 3 — the exact thing its title claims
  // to rule out. Advance past the hard stop FIRST, then click.
  it('the manual Refresh button still works AFTER the polling window has elapsed', async () => {
    render(<StatementPending lens="client" />);

    // 3 attempts × 15s, plus the half-interval of deadline slack, plus margin — the window is
    // genuinely over before the click, which is the whole point of this test.
    vi.advanceTimersByTime(15_000 * 5);
    expect(mockRefresh).toHaveBeenCalledTimes(3);

    // Swap to real timers only for the interaction: `userEvent` driving a `useTransition` under
    // fake timers deadlocks (it waits on a tick the fake clock never advances).
    vi.useRealTimers();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(mockRefresh).toHaveBeenCalledTimes(4);
  });

  // D-B requires the timer to clear on unmount. Real code does it (`return () => clearInterval`),
  // but nothing asserted it — an abandoned tab must not keep refreshing a page that is gone.
  it('clears the timer on unmount — no refresh fires after the component is gone', () => {
    const { unmount } = render(<StatementPending lens="client" />);
    vi.advanceTimersByTime(15_000);
    expect(mockRefresh).toHaveBeenCalledTimes(1);

    unmount();
    vi.advanceTimersByTime(60_000);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});
