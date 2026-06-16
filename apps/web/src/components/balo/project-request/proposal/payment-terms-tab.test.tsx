import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { PaymentTermsTab } from './payment-terms-tab';
import type { ProposalDocumentView } from '@/app/(dashboard)/projects/[requestId]/_actions/confirm-proposal-document-upload';
import type {
  ProposalCadenceValue,
  ProposalInstallmentDraft,
  ProposalPricingMethod,
} from './proposal-composer-state';

// Stub the uploader — assert PaymentTermsTab wires the single terms slot, not the
// uploader's own upload internals.
vi.mock('./proposal-document-uploader', () => ({
  ProposalDocumentUploader: (props: { kind: string; single?: boolean }) => (
    <div data-testid="terms-uploader" data-kind={props.kind} data-single={String(!!props.single)} />
  ),
}));

const REQUEST_ID = 'req-1';
const RELATIONSHIP_ID = 'rel-1';

let keyCounter = 0;
function installment(label: string, pct: number): ProposalInstallmentDraft {
  keyCounter += 1;
  return { key: `i-${keyCounter}`, label, pct };
}

interface Overrides {
  pricingMethod?: ProposalPricingMethod;
  totalCents?: number;
  currency?: string;
  fixedPriceCents?: number | null;
  totalEstimatedMinutes?: number;
  installments?: ProposalInstallmentDraft[];
  installmentSum?: number;
  depositCents?: number | null;
  rateCents?: number | null;
  cadence?: ProposalCadenceValue;
  termsDocuments?: ProposalDocumentView[];
}

function renderTab(overrides: Overrides = {}): {
  onInstallmentsChange: ReturnType<typeof vi.fn>;
  onAddInstallment: ReturnType<typeof vi.fn>;
  onDepositChange: ReturnType<typeof vi.fn>;
  onRateChange: ReturnType<typeof vi.fn>;
  onFixedPriceChange: ReturnType<typeof vi.fn>;
} {
  const onInstallmentsChange = vi.fn();
  const onAddInstallment = vi.fn();
  const onDepositChange = vi.fn();
  const onRateChange = vi.fn();
  const onCadenceChange = vi.fn();
  const onFixedPriceChange = vi.fn();
  const installments = overrides.installments ?? [
    installment('Upfront', 30),
    installment('Final', 70),
  ];
  render(
    <PaymentTermsTab
      pricingMethod={overrides.pricingMethod ?? 'fixed'}
      totalCents={overrides.totalCents ?? 1_000_000}
      currency={overrides.currency ?? 'aud'}
      // `?? 1_000_000` would coerce an explicit `null` to the default — distinguish
      // "not provided" (default) from an explicit null (an untyped Fixed price).
      fixedPriceCents={
        'fixedPriceCents' in overrides ? (overrides.fixedPriceCents ?? null) : 1_000_000
      }
      onFixedPriceChange={onFixedPriceChange}
      totalEstimatedMinutes={overrides.totalEstimatedMinutes ?? 0}
      installments={installments}
      installmentSum={overrides.installmentSum ?? installments.reduce((s, i) => s + i.pct, 0)}
      onInstallmentsChange={onInstallmentsChange}
      onAddInstallment={onAddInstallment}
      depositCents={overrides.depositCents ?? null}
      onDepositChange={onDepositChange}
      rateCents={overrides.rateCents ?? null}
      onRateChange={onRateChange}
      cadence={overrides.cadence ?? 'monthly'}
      onCadenceChange={onCadenceChange}
      requestId={REQUEST_ID}
      relationshipId={RELATIONSHIP_ID}
      termsDocuments={overrides.termsDocuments ?? []}
      ensureProposalId={() => Promise.resolve('prop-1')}
      onDocumentAdded={vi.fn()}
      onDocumentRemoved={vi.fn()}
    />
  );
  return {
    onInstallmentsChange,
    onAddInstallment,
    onDepositChange,
    onRateChange,
    onFixedPriceChange,
  };
}

describe('PaymentTermsTab — Fixed', () => {
  it('renders the method note, typed total input, and grouped per-installment amounts', () => {
    renderTab({
      totalCents: 1_000_000,
      fixedPriceCents: 1_000_000,
      installments: [installment('Upfront', 30), installment('Final', 70)],
    });
    // Read-only method note pointing back to Overview.
    expect(screen.getByText(/change it in the Overview tab/i)).toBeInTheDocument();
    expect(screen.getByText('Fixed price')).toBeInTheDocument();
    // Typed total input (BAL-294) seeded from fixedPriceCents (A$10,000 = 10000 dollars).
    const totalInput = screen.getByLabelText('Total fixed price');
    expect(totalInput).toHaveValue(10_000);
    // Derived per-installment amounts compute against the typed total:
    // 30% of A$10,000 = A$3,000; 70% = A$7,000.
    expect(screen.getByText('A$3,000')).toBeInTheDocument();
    expect(screen.getByText('A$7,000')).toBeInTheDocument();
  });

  it('fires onFixedPriceChange (dollars→cents) when the typed total is edited', async () => {
    const user = userEvent.setup();
    const { onFixedPriceChange } = renderTab({ fixedPriceCents: null });
    await user.type(screen.getByLabelText('Total fixed price'), '5');
    // Empty (null) → "5" → A$5 → 500 cents.
    expect(onFixedPriceChange).toHaveBeenLastCalledWith(500);
  });

  it('installment amounts follow the typed total, not the milestone valueCents sum', () => {
    // totalCents reflects the typed total (the composer passes computeTotalCents).
    renderTab({
      totalCents: 2_000_000,
      fixedPriceCents: 2_000_000,
      installments: [installment('Upfront', 25), installment('Final', 75)],
    });
    expect(screen.getByText('A$5,000')).toBeInTheDocument(); // 25% of A$20,000
    expect(screen.getByText('A$15,000')).toBeInTheDocument(); // 75% of A$20,000
  });

  it('shows the default (success) badge variant when installments sum to 100', () => {
    renderTab({ installmentSum: 100 });
    const badge = screen.getByText('100%');
    expect(badge).toBeInTheDocument();
    // default variant → bg-primary; the destructive variant uses bg-destructive.
    expect(badge.className).toContain('bg-primary');
    expect(badge.className).not.toContain('bg-destructive');
  });

  it('shows the destructive badge variant when installments do not sum to 100', () => {
    renderTab({
      installments: [installment('Upfront', 50)],
      installmentSum: 50,
    });
    const badge = screen.getByText('50%');
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain('bg-destructive');
  });

  it('adds an installment via the Add installment button', async () => {
    const user = userEvent.setup();
    const { onAddInstallment } = renderTab();
    await user.click(screen.getByRole('button', { name: /add installment/i }));
    expect(onAddInstallment).toHaveBeenCalledTimes(1);
  });

  it('removes an installment (and disables removal at a single row)', async () => {
    const user = userEvent.setup();
    const { onInstallmentsChange } = renderTab({
      installments: [installment('Upfront', 40), installment('Final', 60)],
    });
    await user.click(screen.getByRole('button', { name: /remove installment 1/i }));
    expect(onInstallmentsChange).toHaveBeenCalledTimes(1);
    // The resulting list drops index 0.
    const next = onInstallmentsChange.mock.calls[0]?.[0] as ProposalInstallmentDraft[];
    expect(next).toHaveLength(1);
    expect(next[0]?.label).toBe('Final');
  });

  it('disables the remove button when only one installment remains', () => {
    renderTab({ installments: [installment('Full', 100)] });
    expect(screen.getByRole('button', { name: /remove installment 1/i })).toBeDisabled();
  });

  it('edits an installment percentage (clamped to 0-100)', async () => {
    const user = userEvent.setup();
    const { onInstallmentsChange } = renderTab({
      installments: [installment('Upfront', 30), installment('Final', 70)],
    });
    const pctInputs = screen.getAllByLabelText('%');
    const [firstPct] = pctInputs;
    if (firstPct === undefined) throw new Error('expected a percent input');
    await user.clear(firstPct);
    await user.type(firstPct, '150');
    expect(onInstallmentsChange).toHaveBeenCalled();
    // The last change reflects a clamped value <= 100.
    const lastCall = onInstallmentsChange.mock.calls.at(-1)?.[0] as ProposalInstallmentDraft[];
    expect(lastCall[0]?.pct).toBeLessThanOrEqual(100);
  });
});

describe('PaymentTermsTab — Time & materials', () => {
  it('renders deposit / rate / cadence inputs and a read-only derived total', () => {
    // 300 min = 5h × A$160/hr (16_000 cents) = A$800 (totalCents 80_000).
    renderTab({
      pricingMethod: 'tm',
      totalCents: 80_000,
      rateCents: 16_000,
      totalEstimatedMinutes: 300,
    });
    expect(screen.getByText('Time & materials')).toBeInTheDocument();
    expect(screen.getByLabelText(/deposit/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/hourly rate/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/invoicing cadence/i)).toBeInTheDocument();
    // The read-only derived total + the "Nh at $rate/hr" cross-check.
    expect(screen.getByText('Estimated total')).toBeInTheDocument();
    expect(screen.getByText(/≈ A\$800/)).toBeInTheDocument();
    expect(screen.getByText(/5h at A\$160\/hr/)).toBeInTheDocument();
    // The typed total input is NOT shown under T&M.
    expect(screen.queryByLabelText('Total fixed price')).not.toBeInTheDocument();
    // No installment editor in T&M.
    expect(screen.queryByText('Payment installments')).not.toBeInTheDocument();
  });

  it('shows the set-rate-and-effort prompt when the rate is null', () => {
    renderTab({ pricingMethod: 'tm', rateCents: null, totalEstimatedMinutes: 300 });
    expect(screen.getByText(/Set an hourly rate and per-milestone effort/i)).toBeInTheDocument();
    expect(screen.queryByText('Estimated total')).not.toBeInTheDocument();
  });

  it('shows the set-rate-and-effort prompt when there is no effort yet', () => {
    renderTab({ pricingMethod: 'tm', rateCents: 16_000, totalEstimatedMinutes: 0 });
    expect(screen.getByText(/Set an hourly rate and per-milestone effort/i)).toBeInTheDocument();
  });

  it('emits dollar→cents on deposit + rate input', async () => {
    const user = userEvent.setup();
    const { onDepositChange, onRateChange } = renderTab({ pricingMethod: 'tm' });
    await user.type(screen.getByLabelText(/deposit/i), '500');
    await user.type(screen.getByLabelText(/hourly rate/i), '200');
    // dollarsToCents: 500 -> 50000, 200 -> 20000 (each keystroke fires; assert it ran).
    expect(onDepositChange).toHaveBeenCalled();
    expect(onRateChange).toHaveBeenCalled();
    expect(onDepositChange.mock.calls.at(-1)?.[0]).toBeTypeOf('number');
  });
});

describe('PaymentTermsTab — standard terms + supplement', () => {
  it('locks the standard terms and exposes a View popover trigger', async () => {
    const user = userEvent.setup();
    renderTab();
    expect(screen.getByText('Balo standard terms')).toBeInTheDocument();
    expect(screen.getByText(/can't be edited/i)).toBeInTheDocument();

    const view = screen.getByRole('button', { name: 'View' });
    await user.click(view);
    // Popover content reveals the locked terms list.
    expect(
      await screen.findByText(/Work is delivered against the milestones/i)
    ).toBeInTheDocument();
  });

  it('renders a single terms-supplement uploader slot', () => {
    renderTab();
    expect(screen.getByText(/Terms supplement \(optional\)/i)).toBeInTheDocument();
    const uploader = screen.getByTestId('terms-uploader');
    expect(uploader).toHaveAttribute('data-kind', 'terms');
    expect(uploader).toHaveAttribute('data-single', 'true');
  });
});
