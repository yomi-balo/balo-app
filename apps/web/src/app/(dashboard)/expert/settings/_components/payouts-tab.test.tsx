import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PayoutsTab, type PayoutDetailsSummary } from './payouts-tab';
import type { NormalizedField } from '../_types/payout-schema';

const mockGetSchema = vi.fn();

vi.mock('../_actions/save-payout-details', () => ({ savePayoutDetailsAction: vi.fn() }));
vi.mock('../_actions/get-payout-form-schema', () => ({
  getPayoutFormSchemaAction: (...args: unknown[]) => mockGetSchema(...args),
}));

const SAVED: PayoutDetailsSummary = {
  countryCode: 'AU',
  currency: 'AUD',
  transferMethod: 'LOCAL',
  entityType: 'PERSONAL',
  tradingName: null,
  formValues: {},
  verifiedAt: null,
  beneficiaryStatus: null,
};

/** The header row: the shared settings header that holds the h1. */
function headerFor(heading: HTMLElement): Element | null {
  return heading.closest('.items-start');
}

describe('PayoutsTab — header', () => {
  it('uses the shared settings header in the empty/form state', () => {
    render(<PayoutsTab initialPayoutDetails={null} />);

    const heading = screen.getByRole('heading', { level: 1, name: 'Payout Details' });
    const header = headerFor(heading);
    expect(header?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(header).toContainElement(screen.getByText(/Where you want to receive your earnings/));
  });

  it('uses the same shared header in the saved state', () => {
    render(<PayoutsTab initialPayoutDetails={SAVED} />);

    const heading = screen.getByRole('heading', { level: 1, name: 'Payout Details' });
    const header = headerFor(heading);
    expect(header?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(header).toContainElement(
      screen.getByText('Your bank details are saved and will be used for payout disbursements.')
    );
  });
});

const ROUTING_TYPE = 'beneficiary.bank_details.account_routing_type1';
const ROUTING_VALUE = 'beneficiary.bank_details.account_routing_value1';

const SAVED_US: PayoutDetailsSummary = {
  ...SAVED,
  countryCode: 'US',
  currency: 'USD',
  entityType: 'COMPANY',
  formValues: { [ROUTING_TYPE]: 'aba', [ROUTING_VALUE]: '*****6789' },
};

function field(overrides: Partial<NormalizedField> & Pick<NormalizedField, 'path' | 'label'>) {
  return {
    required: true,
    type: 'text' as const,
    refresh: false,
    ...overrides,
  };
}

const US_FIELDS: NormalizedField[] = [
  field({ path: ROUTING_VALUE, label: 'Routing code value' }),
  field({
    path: 'beneficiary.address.street_address',
    label: 'Address',
    description: 'Should not be a PO or GPO box address',
    wide: true,
  }),
  field({ path: 'beneficiary.address.postcode', label: 'ZIP code', refresh: true }),
];

const US_RESULT = { ok: true, fields: US_FIELDS, hiddenDefaults: { [ROUTING_TYPE]: 'aba' } };

async function openUsForm(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(<PayoutsTab initialPayoutDetails={SAVED_US} />);
  await user.click(screen.getByRole('button', { name: /edit payout details/i }));
  await screen.findByLabelText(/ACH routing number/);
  return user;
}

describe('PayoutsTab — schema loading and copy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    mockGetSchema.mockReset();
    mockGetSchema.mockResolvedValue(US_RESULT);
  });

  it('labels the routing code by its saved routing type in the saved view', () => {
    render(<PayoutsTab initialPayoutDetails={SAVED_US} />);
    expect(screen.getByText('ACH routing number')).toBeInTheDocument();
  });

  it('loads the form through the Server Action, not a browser fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await openUsForm();

    expect(mockGetSchema).toHaveBeenCalledWith({
      country: 'US',
      currency: 'USD',
      method: 'LOCAL',
      entityType: 'COMPANY',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows the Balo routing label and the address hint', async () => {
    await openUsForm();
    expect(screen.getByLabelText(/ACH routing number/)).toBeInTheDocument();
    expect(screen.getByText('Must not be a PO box')).toBeInTheDocument();
    expect(screen.queryByText(/PO or GPO/)).not.toBeInTheDocument();
  });

  it('uses a placeholder without a Pty Ltd suffix for the business name', async () => {
    await openUsForm();
    const input = screen.getByLabelText('Business Name');
    expect(input).toHaveAttribute('placeholder', 'e.g. Acme Consulting');
  });

  it('renders no refresh icon inside the form grid, even on a refresh field', async () => {
    await openUsForm();
    const zip = screen.getByLabelText(/ZIP code/);
    const grid = zip.closest('.grid');
    expect(grid?.querySelector('.lucide-refresh-cw')).toBeNull();
  });

  it('renders the three section headings as muted eyebrows with no icon', async () => {
    await openUsForm();
    for (const name of ['Country', 'Business details', 'Bank details']) {
      const heading = screen.getByRole('heading', { name });
      expect(heading).toHaveClass('text-muted-foreground');
      expect(heading.querySelector('svg')).toBeNull();
    }
  });

  it('never reloads the schema while typing in a refresh field', async () => {
    const user = await openUsForm();
    expect(mockGetSchema).toHaveBeenCalledTimes(1);

    await user.type(screen.getByLabelText(/ZIP code/), '90210');

    expect(mockGetSchema).toHaveBeenCalledTimes(1);
  });

  it('shows the action error and no Try again button on a non-retryable failure', async () => {
    mockGetSchema.mockResolvedValue({
      ok: false,
      code: 'unsupported',
      error: "Payouts aren't available for this country and currency yet.",
    });
    const user = userEvent.setup();
    render(<PayoutsTab initialPayoutDetails={SAVED_US} />);
    await user.click(screen.getByRole('button', { name: /edit payout details/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Payouts aren't available/);
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('offers Try again when the failure is retryable', async () => {
    mockGetSchema.mockResolvedValue({
      ok: false,
      code: 'request_failed',
      error: "We couldn't load the bank details form. Please try again.",
    });
    const user = userEvent.setup();
    render(<PayoutsTab initialPayoutDetails={SAVED_US} />);
    await user.click(screen.getByRole('button', { name: /edit payout details/i }));

    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('shows a fixed message when the action itself throws', async () => {
    mockGetSchema.mockRejectedValue(new Error('Unauthorized'));
    const user = userEvent.setup();
    render(<PayoutsTab initialPayoutDetails={SAVED_US} />);
    await user.click(screen.getByRole('button', { name: /edit payout details/i }));

    await waitFor(() =>
      expect(
        screen.getByText("We couldn't load the bank details form. Please try again.")
      ).toBeInTheDocument()
    );
  });
});
