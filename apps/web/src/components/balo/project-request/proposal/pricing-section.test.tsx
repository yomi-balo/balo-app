import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { PricingSection } from './pricing-section';
import { COMPOSER_TARGET, emptyDraftState, installmentFieldId } from './proposal-composer-state';
import type {
  ProposalCadenceValue,
  ProposalDraftState,
  ProposalInstallmentDraft,
} from './proposal-composer-state';

let keyCounter = 0;
function installment(label: string, pct: number): ProposalInstallmentDraft {
  keyCounter += 1;
  return { key: `i-${keyCounter}`, label, pct };
}

function fixedState(overrides: Partial<ProposalDraftState> = {}): ProposalDraftState {
  return {
    ...emptyDraftState(),
    fixedPriceCents: 1_000_000,
    installments: [installment('Upfront', 30), installment('Final', 70)],
    ...overrides,
  };
}

function tmState(overrides: Partial<ProposalDraftState> = {}): ProposalDraftState {
  return { ...emptyDraftState(), pricingMethod: 'tm', ...overrides };
}

interface Spies {
  onFixedPriceChange: ReturnType<typeof vi.fn<(cents: number | null) => void>>;
  onInstallmentsChange: ReturnType<typeof vi.fn<(next: ProposalInstallmentDraft[]) => void>>;
  onDepositChange: ReturnType<typeof vi.fn<(cents: number | null) => void>>;
  onRateChange: ReturnType<typeof vi.fn<(cents: number | null) => void>>;
  onCadenceChange: ReturnType<typeof vi.fn<(c: ProposalCadenceValue) => void>>;
}

function renderSection(state: ProposalDraftState, totalCents?: number): Spies {
  const spies: Spies = {
    onFixedPriceChange: vi.fn(),
    onInstallmentsChange: vi.fn(),
    onDepositChange: vi.fn(),
    onRateChange: vi.fn(),
    onCadenceChange: vi.fn(),
  };
  render(
    <PricingSection
      state={state}
      totalCents={totalCents ?? state.fixedPriceCents ?? 0}
      companyName="Northwind"
      {...spies}
    />
  );
  return spies;
}

describe('PricingSection — Fixed', () => {
  it('leads with the project price, ahead of the schedule, with company help', () => {
    renderSection(fixedState());
    expect(
      screen.getByRole('heading', { level: 2, name: 'Price and payments' })
    ).toBeInTheDocument();
    expect(
      screen.getByText('One price for the whole project, and how Northwind pays it.')
    ).toBeInTheDocument();
    const price = screen.getByLabelText('Project price');
    expect(price).toHaveAttribute('id', COMPOSER_TARGET.fixedPrice);
    expect(price).toHaveValue(10_000);
    const schedule = screen.getByText('Payment schedule');
    expect(price.compareDocumentPosition(schedule) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('fires onFixedPriceChange (dollars to cents) when the price is edited', async () => {
    const user = userEvent.setup();
    const { onFixedPriceChange } = renderSection(fixedState({ fixedPriceCents: null }));
    await user.type(screen.getByLabelText('Project price'), '5');
    expect(onFixedPriceChange).toHaveBeenLastCalledWith(500);
  });

  it('computes each payment amount from the total', () => {
    renderSection(fixedState());
    expect(screen.getByText('A$3,000')).toBeInTheDocument();
    expect(screen.getByText('A$7,000')).toBeInTheDocument();
  });

  it('shows a dash for each payment amount while the total is 0', () => {
    renderSection(fixedState({ fixedPriceCents: null }), 0);
    expect(screen.getAllByText('—')).toHaveLength(2);
  });

  it('writes a preset to the rows and reflects the active one with aria-pressed', async () => {
    const user = userEvent.setup();
    const { onInstallmentsChange } = renderSection(
      fixedState({ installments: [installment('Upfront', 30), installment('On delivery', 70)] })
    );
    const group = screen.getByRole('group', { name: 'Payment presets' });
    expect(within(group).getByRole('button', { name: '30 / 70' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(within(group).getByRole('button', { name: '50 / 50' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );

    await user.click(within(group).getByRole('button', { name: '50 / 50' }));

    const next = onInstallmentsChange.mock.calls[0]?.[0] ?? [];
    expect(next.map((r) => [r.label, r.pct])).toEqual([
      ['Upfront', 50],
      ['On delivery', 50],
    ]);
  });

  it('marks no preset pressed for a custom schedule', () => {
    renderSection(fixedState());
    const group = screen.getByRole('group', { name: 'Payment presets' });
    for (const button of within(group).getAllByRole('button')) {
      expect(button).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('"Add payment" appends the remaining percentage', async () => {
    const user = userEvent.setup();
    const { onInstallmentsChange } = renderSection(
      fixedState({ installments: [installment('Upfront', 30), installment('Final', 50)] })
    );
    await user.click(screen.getByRole('button', { name: 'Add payment' }));
    const next = onInstallmentsChange.mock.calls[0]?.[0] ?? [];
    expect(next).toHaveLength(3);
    expect(next[2]).toMatchObject({ label: '', pct: 20 });
  });

  it('"Add payment" appends 0% when the schedule is already over 100 and focuses the new label', async () => {
    const user = userEvent.setup();
    function Harness(): React.JSX.Element {
      const [state, setState] = useState(
        fixedState({ installments: [installment('A', 70), installment('B', 70)] })
      );
      return (
        <PricingSection
          state={state}
          totalCents={1_000_000}
          companyName="Northwind"
          onFixedPriceChange={vi.fn()}
          onInstallmentsChange={(installments) => setState((s) => ({ ...s, installments }))}
          onDepositChange={vi.fn()}
          onRateChange={vi.fn()}
          onCadenceChange={vi.fn()}
        />
      );
    }
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Add payment' }));
    expect(screen.getByLabelText('Payment 3 percentage')).toHaveValue(0);
    expect(screen.getByLabelText('Payment 3 name')).toHaveFocus();
  });

  it('gives rows stable field ids for the readiness jump targets', () => {
    const state = fixedState();
    renderSection(state);
    const [first] = state.installments;
    expect(document.getElementById(installmentFieldId('label', first?.key ?? ''))).not.toBeNull();
    expect(document.getElementById(installmentFieldId('pct', first?.key ?? ''))).not.toBeNull();
  });

  it('edits a label and clamps a percentage to 0-100', async () => {
    const user = userEvent.setup();
    const { onInstallmentsChange } = renderSection(fixedState());
    await user.type(screen.getByLabelText('Payment 1 name'), 'x');
    expect(onInstallmentsChange.mock.calls.at(-1)?.[0]?.[0]?.label).toBe('Upfrontx');

    const pct = screen.getByLabelText('Payment 1 percentage');
    await user.clear(pct);
    await user.type(pct, '150');
    expect(onInstallmentsChange.mock.calls.at(-1)?.[0]?.[0]?.pct).toBeLessThanOrEqual(100);
  });

  it('removes a payment, and allows removing the last one', async () => {
    const user = userEvent.setup();
    const { onInstallmentsChange } = renderSection(fixedState());
    await user.click(screen.getByRole('button', { name: 'Remove payment 1' }));
    expect(onInstallmentsChange.mock.calls[0]?.[0]?.map((r) => r.label)).toEqual(['Final']);
    expect(screen.getByRole('button', { name: 'Remove payment 1' })).toBeEnabled();
  });

  it.each([
    [[100], 'Adds up to 100%'],
    [[40], 'Adds up to 40%. 60% left to assign.'],
    [[70, 50], "Adds up to 120%. That's 20% over."],
  ])('shows the sum line for %j', (pcts, copy) => {
    renderSection(fixedState({ installments: pcts.map((pct) => installment('P', pct)) }));
    expect(screen.getByRole('status')).toHaveTextContent(copy);
  });

  it('hides the sum line when there are no payments', () => {
    renderSection(fixedState({ installments: [] }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add payment' })).toHaveAttribute(
      'id',
      COMPOSER_TARGET.addInstallment
    );
  });

  it('no longer renders the method note or any terms uploader', () => {
    renderSection(fixedState());
    expect(screen.queryByText(/change it in the Overview tab/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Balo standard terms')).not.toBeInTheDocument();
    expect(screen.queryByText(/Terms supplement/i)).not.toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});

describe('PricingSection — Time & materials', () => {
  it('renders rate and deposit with their jump ids and a segmented cadence', () => {
    renderSection(tmState({ rateCents: 16_000 }), 0);
    expect(
      screen.getByRole('heading', { level: 2, name: 'Rates and billing' })
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Hourly rate')).toHaveAttribute('id', COMPOSER_TARGET.rate);
    expect(screen.getByLabelText('Deposit')).toHaveAttribute('id', COMPOSER_TARGET.deposit);

    const group = screen.getByRole('group', { name: 'Invoices' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Fortnightly', 'Monthly']);
    expect(within(group).getByRole('button', { name: 'Monthly' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Project price')).not.toBeInTheDocument();
  });

  it('capitalises a sentence-opening company name in the help line', () => {
    render(
      <PricingSection
        state={tmState()}
        totalCents={0}
        companyName="the client"
        onFixedPriceChange={vi.fn()}
        onInstallmentsChange={vi.fn()}
        onDepositChange={vi.fn()}
        onRateChange={vi.fn()}
        onCadenceChange={vi.fn()}
      />
    );
    expect(
      screen.getByText('The client is billed for time worked. Milestones are a guide, not a cap.')
    ).toBeInTheDocument();
  });

  it('changes the cadence from the segmented control', async () => {
    const user = userEvent.setup();
    const { onCadenceChange } = renderSection(tmState());
    await user.click(screen.getByRole('button', { name: 'Fortnightly' }));
    expect(onCadenceChange).toHaveBeenCalledWith('fortnightly');
  });

  it('emits dollars to cents for rate and deposit', async () => {
    const user = userEvent.setup();
    const { onRateChange, onDepositChange } = renderSection(tmState());
    await user.type(screen.getByLabelText('Hourly rate'), '2');
    await user.type(screen.getByLabelText('Deposit'), '5');
    expect(onRateChange).toHaveBeenLastCalledWith(200);
    expect(onDepositChange).toHaveBeenLastCalledWith(500);
  });

  it('shows the derived estimate once there is a rate and effort', () => {
    const state = tmState({ rateCents: 16_000 });
    const [first] = state.milestones;
    renderSection(
      { ...state, milestones: first ? [{ ...first, estimatedMinutes: 300 }] : [] },
      80_000
    );
    expect(screen.getByText('Estimated total')).toBeInTheDocument();
    expect(screen.getByText(/≈ A\$800/)).toBeInTheDocument();
    expect(screen.getByText(/5h at A\$160\/hr/)).toBeInTheDocument();
  });

  it('prompts for a rate and effort when either is missing', () => {
    renderSection(tmState({ rateCents: null }), 0);
    expect(screen.getByText(/Set an hourly rate and per-milestone effort/i)).toBeInTheDocument();
    expect(screen.queryByText('Estimated total')).not.toBeInTheDocument();
  });

  it('shows no payment schedule under T&M', () => {
    renderSection(tmState());
    expect(screen.queryByText('Payment schedule')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add payment' })).not.toBeInTheDocument();
  });
});
