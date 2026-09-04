import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import type { BillingEmailSnapshot } from '@/lib/credit/wallet-read';

const mockSaveBillingEmailAction = vi.fn();
vi.mock('@/lib/credit/actions', () => ({
  saveBillingEmailAction: (...a: unknown[]) => mockSaveBillingEmailAction(...a),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: mockRefresh, back: vi.fn() }),
}));

import { BillingEmailSection } from './billing-email-section';

function snapshot(overrides: Partial<BillingEmailSnapshot> = {}): BillingEmailSnapshot {
  return {
    email: null,
    source: null,
    setAt: null,
    setByName: null,
    setByIsFormerMember: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BillingEmailSection', () => {
  it('renders the pre-seed empty-state copy as an invitation, never absence-framed', () => {
    render(<BillingEmailSection initial={snapshot()} />);
    expect(
      screen.getByText('Set automatically at your first top-up — or add one now.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/no.*yet/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Billing email')).toHaveValue('');
  });

  it('renders the "seeded" provenance line with the resolved name and date', () => {
    render(
      <BillingEmailSection
        initial={snapshot({
          email: 'dana@northwind.test',
          source: 'seeded',
          setAt: '2026-08-01T00:00:00.000Z',
          setByName: 'Dana Okoro',
        })}
      />
    );
    expect(
      screen.getByText("Seeded from Dana Okoro's first top-up on 1 Aug 2026")
    ).toBeInTheDocument();
  });

  it('renders the "set" provenance line', () => {
    render(
      <BillingEmailSection
        initial={snapshot({
          email: 'billing@northwind.test',
          source: 'set',
          setAt: '2026-08-05T00:00:00.000Z',
          setByName: 'Dana Okoro',
        })}
      />
    );
    expect(screen.getByText('Set by Dana Okoro on 5 Aug 2026')).toBeInTheDocument();
  });

  it('degrades to a date-only provenance line when the name cannot be resolved', () => {
    render(
      <BillingEmailSection
        initial={snapshot({
          email: 'billing@northwind.test',
          source: 'set',
          setAt: '2026-08-05T00:00:00.000Z',
          setByName: null,
        })}
      />
    );
    expect(screen.getByText('Set on 5 Aug 2026')).toBeInTheDocument();
  });

  it('appends "(no longer a member)" when the attributed person has departed', () => {
    render(
      <BillingEmailSection
        initial={snapshot({
          email: 'billing@northwind.test',
          source: 'set',
          setAt: '2026-08-05T00:00:00.000Z',
          setByName: 'Dana Okoro',
          setByIsFormerMember: true,
        })}
      />
    );
    expect(
      screen.getByText('Set by Dana Okoro on 5 Aug 2026 (no longer a member)')
    ).toBeInTheDocument();
  });

  it('disables Save when the field is unchanged, empty, or invalid', async () => {
    const user = userEvent.setup();
    render(<BillingEmailSection initial={snapshot({ email: 'dana@northwind.test' })} />);
    const input = screen.getByLabelText('Billing email');
    const save = screen.getByRole('button', { name: 'Save billing email' });

    // Unchanged.
    expect(save).toBeDisabled();

    // Emptied — not blankable, no clear affordance.
    await user.clear(input);
    expect(save).toBeDisabled();

    // Invalid format.
    await user.type(input, 'not-an-email');
    expect(save).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid email address.');

    // Valid + dirty ⇒ enabled.
    await user.clear(input);
    await user.type(input, 'new@northwind.test');
    expect(save).toBeEnabled();
  });

  it('saves successfully: toasts, repaints provenance from the RESPONSE, and refreshes', async () => {
    mockSaveBillingEmailAction.mockResolvedValue({
      ok: true,
      status: 'updated',
      billingEmail: 'new@northwind.test',
      source: 'set',
      setAt: '2026-08-10T00:00:00.000Z',
      setByName: 'Priya Singh',
    });
    const user = userEvent.setup();
    render(<BillingEmailSection initial={snapshot({ email: 'dana@northwind.test' })} />);

    const input = screen.getByLabelText('Billing email');
    await user.clear(input);
    await user.type(input, 'new@northwind.test');
    await user.click(screen.getByRole('button', { name: 'Save billing email' }));

    await waitFor(() => {
      expect(mockSaveBillingEmailAction).toHaveBeenCalledWith({
        billingEmail: 'new@northwind.test',
      });
    });
    expect(toast.success).toHaveBeenCalledWith('Billing email updated.');
    expect(await screen.findByText('Set by Priya Singh on 10 Aug 2026')).toBeInTheDocument();
    expect(mockRefresh).toHaveBeenCalled();
    // Save is disabled again — the draft now equals the just-committed value.
    expect(screen.getByRole('button', { name: 'Save billing email' })).toBeDisabled();
  });

  it('failure toasts and PRESERVES the typed draft (never reverted)', async () => {
    mockSaveBillingEmailAction.mockResolvedValue({ ok: false, error: 'error' });
    const user = userEvent.setup();
    render(<BillingEmailSection initial={snapshot({ email: 'dana@northwind.test' })} />);

    const input = screen.getByLabelText('Billing email');
    await user.clear(input);
    await user.type(input, 'new@northwind.test');
    await user.click(screen.getByRole('button', { name: 'Save billing email' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("We couldn't save that — please try again.");
    });
    expect(input).toHaveValue('new@northwind.test');
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('an unauthorized failure shows the permission-specific toast', async () => {
    mockSaveBillingEmailAction.mockResolvedValue({ ok: false, error: 'unauthorized' });
    const user = userEvent.setup();
    render(<BillingEmailSection initial={snapshot({ email: 'dana@northwind.test' })} />);

    const input = screen.getByLabelText('Billing email');
    await user.clear(input);
    await user.type(input, 'new@northwind.test');
    await user.click(screen.getByRole('button', { name: 'Save billing email' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'You no longer have permission to change billing settings — ask a company owner or admin to make this change.'
      );
    });
  });

  // UX/REVIEW FIX — `aria-invalid` alone tells a screen-reader user the field is wrong but never
  // why. The error node must be NAMED by `aria-describedby` (the `LowBalanceModePicker` pattern).
  it('associates the error message with the input via aria-describedby', async () => {
    const user = userEvent.setup();
    render(<BillingEmailSection initial={snapshot({ email: 'dana@northwind.test' })} />);
    const input = screen.getByLabelText('Billing email');

    // Valid ⇒ only the help/provenance line is described.
    expect(input).toHaveAttribute('aria-describedby', 'billing-email-help');

    await user.clear(input);
    await user.type(input, 'not-an-email');

    // Invalid ⇒ the error is named FIRST, then the help line.
    expect(input).toHaveAttribute('aria-describedby', 'billing-email-error billing-email-help');
    const error = screen.getByRole('alert');
    expect(error).toHaveAttribute('id', 'billing-email-error');
    expect(error).toHaveTextContent('Enter a valid email address.');
  });

  // REVIEW FIX — an `unchanged` reply wrote nothing, so the stored provenance still belongs to
  // whoever last actually changed it. Repainting "Set by {me}" would be a false claim on the very
  // screen whose job is provenance.
  it('an unchanged reply NEVER repaints the provenance line', async () => {
    mockSaveBillingEmailAction.mockResolvedValue({
      ok: true,
      status: 'unchanged',
      billingEmail: 'dana@northwind.test',
    });
    const user = userEvent.setup();
    render(
      <BillingEmailSection
        initial={snapshot({
          email: 'stale@northwind.test',
          source: 'seeded',
          setAt: '2026-08-01T00:00:00.000Z',
          setByName: 'Dana Okoro',
        })}
      />
    );

    const input = screen.getByLabelText('Billing email');
    await user.clear(input);
    await user.type(input, 'dana@northwind.test');
    await user.click(screen.getByRole('button', { name: 'Save billing email' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Billing email updated.'));
    expect(mockRefresh).toHaveBeenCalled();
    // Still the seeded line naming Dana — not "Set by …" and not the save date.
    expect(
      screen.getByText("Seeded from Dana Okoro's first top-up on 1 Aug 2026")
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Set by /)).not.toBeInTheDocument();
  });

  it('shows a spinner and disables Save while pending', async () => {
    let resolveSave: (value: unknown) => void = () => undefined;
    mockSaveBillingEmailAction.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      })
    );
    const user = userEvent.setup();
    render(<BillingEmailSection initial={snapshot({ email: 'dana@northwind.test' })} />);

    const input = screen.getByLabelText('Billing email');
    await user.clear(input);
    await user.type(input, 'new@northwind.test');
    await user.click(screen.getByRole('button', { name: 'Save billing email' }));

    expect(screen.getByRole('button', { name: 'Save billing email' })).toBeDisabled();
    // The aria-label is stable across states, so the VISIBLE pending label is asserted directly.
    expect(screen.getByText('Saving…')).toBeInTheDocument();
    resolveSave({ ok: false, error: 'error' });
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });
});
