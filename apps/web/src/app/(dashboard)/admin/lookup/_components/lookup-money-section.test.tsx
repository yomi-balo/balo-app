import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import type { AdminMoneyBlock } from '@balo/shared/credit';
import { LookupMoneySection } from './lookup-money-section';

const { mockAction } = vi.hoisted(() => ({ mockAction: vi.fn() }));

vi.mock('../_actions/fetch-lookup-money-block', () => ({
  fetchLookupMoneyBlockAction: mockAction,
}));

function block(overrides: Partial<AdminMoneyBlock> = {}): AdminMoneyBlock {
  return {
    lens: 'admin',
    state: 'finalized',
    sessionId: 'session-1',
    durationMinutes: 45,
    clientChargeAudMinor: 16875,
    expertEarningsAudMinor: 13500,
    marginAudMinor: 3375,
    baloFeeBps: 2500,
    overdraftSettledMinor: 0,
    actualMinutes: 45,
    billingFloorApplied: false,
    billingFloorMinutes: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LookupMoneySection', () => {
  it('renders a loading skeleton while the action is in flight', () => {
    mockAction.mockReturnValue(new Promise(() => {})); // never resolves
    render(<LookupMoneySection sessionId="session-1" />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('ok: renders the money grid with all figures, no per-row lock', async () => {
    mockAction.mockResolvedValue({ ok: true, block: block() });
    render(<LookupMoneySection sessionId="session-1" />);

    await waitFor(() => expect(screen.getByText('A$168.75')).toBeInTheDocument());
    expect(screen.getByText('A$135.00')).toBeInTheDocument();
    expect(screen.getByText('A$33.75 (25% markup)')).toBeInTheDocument();
    expect(screen.getByText('45 min')).toBeInTheDocument();
    expect(screen.queryByText(/overdraft settled/i)).not.toBeInTheDocument();
  });

  it('ok, pending state: renders "Not settled yet" instead of a row of zeros', async () => {
    mockAction.mockResolvedValue({
      ok: true,
      block: block({ state: 'pending', clientChargeAudMinor: 0, expertEarningsAudMinor: 0 }),
    });
    render(<LookupMoneySection sessionId="session-1" />);
    await waitFor(() => expect(screen.getByText('Not settled yet')).toBeInTheDocument());
    expect(screen.queryByText('Client all-in')).not.toBeInTheDocument();
  });

  it('shows the overdraft row only when non-zero', async () => {
    mockAction.mockResolvedValue({
      ok: true,
      block: block({ overdraftSettledMinor: 6240 }),
    });
    render(<LookupMoneySection sessionId="session-1" />);
    await waitFor(() => expect(screen.getByText('Overdraft settled')).toBeInTheDocument());
    expect(screen.getByText('A$62.40')).toBeInTheDocument();
  });

  it('forbidden: renders the copy with NO figures rendered', async () => {
    mockAction.mockResolvedValue({ ok: false, reason: 'forbidden' });
    render(<LookupMoneySection sessionId="session-1" />);
    await waitFor(() => expect(screen.getByText(/need fee visibility/i)).toBeInTheDocument());
    expect(screen.queryByText(/A\$/)).not.toBeInTheDocument();
  });

  it('not_found: renders the not-found copy', async () => {
    mockAction.mockResolvedValue({ ok: false, reason: 'not_found' });
    render(<LookupMoneySection sessionId="session-1" />);
    await waitFor(() =>
      expect(screen.getByText(/money record isn.t available/i)).toBeInTheDocument()
    );
  });

  it('unavailable: renders the unavailable copy', async () => {
    mockAction.mockResolvedValue({ ok: false, reason: 'unavailable' });
    render(<LookupMoneySection sessionId="session-1" />);
    await waitFor(() => expect(screen.getByText(/nothing was changed/i)).toBeInTheDocument());
  });

  it('ignores a stale response when the session id changes before the first fetch resolves', async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    mockAction.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
    );
    mockAction.mockResolvedValueOnce({ ok: true, block: block({ sessionId: 'session-2' }) });

    const { rerender } = render(<LookupMoneySection sessionId="session-1" />);
    rerender(<LookupMoneySection sessionId="session-2" />);

    await waitFor(() => expect(screen.getByText('A$168.75')).toBeInTheDocument());

    // The stale first response resolves late — it must not overwrite the current session's view.
    resolveFirst?.({ ok: true, block: block({ sessionId: 'session-1', clientChargeAudMinor: 1 }) });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText('A$168.75')).toBeInTheDocument();
  });
});
