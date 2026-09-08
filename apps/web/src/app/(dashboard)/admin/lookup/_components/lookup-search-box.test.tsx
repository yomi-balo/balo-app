import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { LookupSearchBox } from './lookup-search-box';

const mockReplace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

describe('LookupSearchBox', () => {
  beforeEach(() => {
    mockReplace.mockClear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the current query and hint copy', () => {
    render(<LookupSearchBox initialQuery="northwind" onPendingChange={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: /search lookup/i })).toHaveValue('northwind');
    expect(screen.getByText(/paste a session id or a stripe paymentintent/i)).toBeInTheDocument();
  });

  it('debounces typing and writes ?q= via router.replace', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<LookupSearchBox initialQuery="" onPendingChange={vi.fn()} />);

    await user.type(screen.getByRole('textbox', { name: /search lookup/i }), 'dana');
    expect(mockReplace).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mockReplace).toHaveBeenCalledWith('/admin/lookup?q=dana', { scroll: false });
  });

  it('clearing the value replaces to the bare route with no query string', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<LookupSearchBox initialQuery="dana" onPendingChange={vi.fn()} />);

    await user.clear(screen.getByRole('textbox', { name: /search lookup/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(mockReplace).toHaveBeenCalledWith('/admin/lookup', { scroll: false });
  });

  it('does NOT render a too-short hint (F6: the results list owns that copy, not the box)', () => {
    // The identical sentence used to render here AND in `LookupResultsList`'s
    // `TooShortNotice` — BAL-551 fix round F6 keeps only the list's copy.
    render(<LookupSearchBox initialQuery="d" onPendingChange={vi.fn()} />);
    expect(screen.queryByText(/needs at least two characters/i)).not.toBeInTheDocument();
  });

  it('does not discard keystrokes typed during the server echo re-render (F3 regression)', async () => {
    // Reproduces the reviewer-verified bug: type "north" → the debounce pushes `?q=north` →
    // keep typing "wind" (input reads "northwind") → the App Router re-render echoes the push
    // back down as `initialQuery="north"`. Before the fix, the unconditional sync effect
    // reset BOTH `value` and `lastPushedRef` to "north", so "northwind" was clobbered back to
    // "north" and "wind" never reached the URL at all.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { rerender } = render(<LookupSearchBox initialQuery="" onPendingChange={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: /search lookup/i });

    await user.type(input, 'north');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mockReplace).toHaveBeenCalledWith('/admin/lookup?q=north', { scroll: false });

    await user.type(input, 'wind');
    expect(input).toHaveValue('northwind');

    // The stale echo of our own push arrives as a new `initialQuery` prop.
    rerender(<LookupSearchBox initialQuery="north" onPendingChange={vi.fn()} />);

    expect(input).toHaveValue('northwind');

    // The keystrokes typed during the echo must still reach the URL.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mockReplace).toHaveBeenCalledWith('/admin/lookup?q=northwind', { scroll: false });
  });

  it('BAL-551 R8 — the input meets the 44px touch target, matching the chip/link precedent', () => {
    render(<LookupSearchBox initialQuery="" onPendingChange={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: /search lookup/i })).toHaveClass('min-h-[44px]');
  });

  it('reports pending state to the parent via onPendingChange', async () => {
    const onPendingChange = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<LookupSearchBox initialQuery="" onPendingChange={onPendingChange} />);

    expect(onPendingChange).toHaveBeenCalledWith(false);

    await user.type(screen.getByRole('textbox', { name: /search lookup/i }), 'x');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(onPendingChange).toHaveBeenCalledWith(true);
  });
});
