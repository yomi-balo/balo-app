import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

const mockRemind = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/remind-client-billing', () => ({
  remindClientBilling: (...args: unknown[]) => mockRemind(...args),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import { toast } from 'sonner';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import { AdminKickoffBillingPanel } from './admin-kickoff-billing-panel';
import type { AdminKickoffBillingView } from '@/lib/project-request/admin-kickoff-billing-view';

const mockToast = vi.mocked(toast);
const mockTrack = vi.mocked(track);

const REQUEST_ID = 'req-1';
const RELATIONSHIP_ID = 'rel-accepted-1';

const BILLING: NonNullable<AdminKickoffBillingView['billing']> = {
  legalName: 'Acme Pty Ltd',
  countryCode: 'AU',
  taxId: '12345678901',
  address: '1 King St, Sydney',
  billingEmail: 'billing@acme.test',
};

const FIXED_TERMS: NonNullable<AdminKickoffBillingView['terms']> = {
  pricingMethod: 'fixed',
  currency: 'aud',
  priceCents: 7_800_000,
  depositCents: null,
  rateCents: null,
  cadence: null,
  installments: [
    { id: 'i1', label: 'Upfront', pct: 30, amountCents: 2_340_000 },
    { id: 'i2', label: 'On delivery', pct: 70, amountCents: 5_460_000 },
  ],
  milestones: [{ id: 'm1', title: 'Discovery', valueCents: 2_000_000, estimatedMinutes: null }],
};

const TM_TERMS: NonNullable<AdminKickoffBillingView['terms']> = {
  pricingMethod: 'tm',
  currency: 'aud',
  priceCents: 5_000_000,
  depositCents: 1_000_000,
  rateCents: 25_000,
  cadence: 'monthly',
  installments: [],
  milestones: [{ id: 'm1', title: 'Build phase', valueCents: null, estimatedMinutes: 480 }],
};

type PanelProps = React.ComponentProps<typeof AdminKickoffBillingPanel>;

function renderPanel(overrides: Partial<PanelProps> = {}): void {
  const props: PanelProps = {
    view: { billing: BILLING, terms: FIXED_TERMS },
    requestId: REQUEST_ID,
    acceptedRelationshipId: RELATIONSHIP_ID,
    clientBillingConfirmed: true,
    ...overrides,
  };
  render(<AdminKickoffBillingPanel {...props} />);
}

describe('AdminKickoffBillingPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRemind.mockResolvedValue({
      success: true,
      companyId: 'comp-1',
      recipientCount: 2,
      adminUserId: 'admin-1',
      daysSinceAcceptance: 3,
    });
  });

  afterEach(() => {
    document.documentElement.classList.remove('dark');
  });

  it('renders the client billing details when present', () => {
    renderPanel();
    expect(screen.getByText('Acme Pty Ltd')).toBeInTheDocument();
    expect(screen.getByText('billing@acme.test')).toBeInTheDocument();
    expect(screen.getByText('12345678901')).toBeInTheDocument();
    expect(screen.getByText('AU')).toBeInTheDocument();
    expect(screen.getByText('1 King St, Sydney')).toBeInTheDocument();
    // No reminder affordance once the gate is confirmed.
    expect(screen.queryByRole('button', { name: /remind client/i })).not.toBeInTheDocument();
  });

  it('shows the invitation empty state + Remind button when billing is null and the gate is outstanding', () => {
    renderPanel({ view: { billing: null, terms: null }, clientBillingConfirmed: false });
    expect(screen.getByText(/hasn't added their company billing details/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remind client/i })).toBeInTheDocument();
  });

  it('shows the settled note without a Remind button when billing is null but the gate is confirmed', () => {
    renderPanel({ view: { billing: null, terms: null }, clientBillingConfirmed: true });
    expect(screen.getByText(/billing gate confirmed/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remind client/i })).not.toBeInTheDocument();
  });

  it('renders Fixed payment terms — total, installments (label, %, derived amount), milestone value', () => {
    renderPanel();
    expect(screen.getByText('Fixed price')).toBeInTheDocument();
    expect(screen.getByText('A$78,000')).toBeInTheDocument();
    expect(screen.getByText('Upfront')).toBeInTheDocument();
    expect(screen.getByText('(30%)')).toBeInTheDocument();
    expect(screen.getByText('A$23,400')).toBeInTheDocument();
    expect(screen.getByText('A$54,600')).toBeInTheDocument();
    expect(screen.getByText('Discovery')).toBeInTheDocument();
    expect(screen.getByText('A$20,000')).toBeInTheDocument();
  });

  it('renders T&M payment terms — estimate, rate, deposit, cadence, effort minutes', () => {
    renderPanel({ view: { billing: BILLING, terms: TM_TERMS } });
    expect(screen.getByText('Time & materials')).toBeInTheDocument();
    // Estimate label is present and marked non-binding.
    expect(screen.getByText('Estimate')).toBeInTheDocument();
    expect(screen.getByText(/non-binding/i)).toBeInTheDocument();
    expect(screen.getByText('Monthly')).toBeInTheDocument();
    // Milestone effort rendered as hours.
    expect(screen.getByText('Build phase')).toBeInTheDocument();
    expect(screen.getByText('8h')).toBeInTheDocument();
  });

  it('shows a placeholder when there is no accepted proposal', () => {
    renderPanel({ view: { billing: BILLING, terms: null } });
    expect(screen.getByText(/no accepted proposal/i)).toBeInTheDocument();
  });

  it('renders T&M milestone effort as mixed hours + minutes (90 → 1h 30m)', () => {
    renderPanel({
      view: {
        billing: BILLING,
        terms: {
          ...TM_TERMS,
          milestones: [{ id: 'm1', title: 'Build phase', valueCents: null, estimatedMinutes: 90 }],
        },
      },
    });
    expect(screen.getByText('1h 30m')).toBeInTheDocument();
  });

  it('renders T&M milestone effort as minutes only (45 → 45m)', () => {
    renderPanel({
      view: {
        billing: BILLING,
        terms: {
          ...TM_TERMS,
          milestones: [{ id: 'm1', title: 'Build phase', valueCents: null, estimatedMinutes: 45 }],
        },
      },
    });
    expect(screen.getByText('45m')).toBeInTheDocument();
  });

  it('omits the milestones section when there are no milestones', () => {
    renderPanel({ view: { billing: BILLING, terms: { ...FIXED_TERMS, milestones: [] } } });
    expect(screen.queryByText('Milestones')).not.toBeInTheDocument();
  });

  it('omits the installments list when there are no installments', () => {
    renderPanel({ view: { billing: BILLING, terms: { ...FIXED_TERMS, installments: [] } } });
    expect(screen.queryByText('Installments')).not.toBeInTheDocument();
  });

  it('renders the — fallback for a Fixed milestone with no line value', () => {
    renderPanel({
      view: {
        billing: BILLING,
        terms: {
          ...FIXED_TERMS,
          milestones: [{ id: 'm1', title: 'Discovery', valueCents: null, estimatedMinutes: null }],
        },
      },
    });
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders the — fallback for a T&M milestone with no effort estimate', () => {
    renderPanel({
      view: {
        billing: BILLING,
        terms: {
          ...TM_TERMS,
          milestones: [
            { id: 'm1', title: 'Build phase', valueCents: null, estimatedMinutes: null },
          ],
        },
      },
    });
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('fires the reminder action + analytics + success toast on click', async () => {
    const user = userEvent.setup();
    renderPanel({ view: { billing: null, terms: null }, clientBillingConfirmed: false });

    await user.click(screen.getByRole('button', { name: /remind client/i }));

    await waitFor(() => {
      expect(mockRemind).toHaveBeenCalledWith({
        requestId: REQUEST_ID,
        relationshipId: RELATIONSHIP_ID,
      });
    });
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.BILLING_REMINDER_SENT, {
      request_id: REQUEST_ID,
      company_id: 'comp-1',
      admin_user_id: 'admin-1',
      recipient_count: 2,
      days_since_acceptance: 3,
    });
    expect(mockToast.success).toHaveBeenCalledWith('Reminder sent');
  });

  it('surfaces an error toast + does not fire analytics when the action fails', async () => {
    mockRemind.mockResolvedValue({ success: false, error: 'Nope' });
    const user = userEvent.setup();
    renderPanel({ view: { billing: null, terms: null }, clientBillingConfirmed: false });

    await user.click(screen.getByRole('button', { name: /remind client/i }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('Nope'));
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('disables the button while the reminder is in flight', async () => {
    let resolveRemind: (value: unknown) => void = () => {};
    mockRemind.mockReturnValue(
      new Promise((resolve) => {
        resolveRemind = resolve;
      })
    );
    const user = userEvent.setup();
    renderPanel({ view: { billing: null, terms: null }, clientBillingConfirmed: false });

    const button = screen.getByRole('button', { name: /remind client/i });
    await user.click(button);

    await waitFor(() => expect(button).toBeDisabled());

    resolveRemind({
      success: true,
      companyId: 'comp-1',
      recipientCount: 1,
      adminUserId: 'admin-1',
      daysSinceAcceptance: null,
    });
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  it('has no accessibility violations (light)', async () => {
    const { container } = render(
      <AdminKickoffBillingPanel
        view={{ billing: null, terms: FIXED_TERMS }}
        requestId={REQUEST_ID}
        acceptedRelationshipId={RELATIONSHIP_ID}
        clientBillingConfirmed={false}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('renders and stays accessible in dark mode', async () => {
    document.documentElement.classList.add('dark');
    const { container } = render(
      <AdminKickoffBillingPanel
        view={{ billing: BILLING, terms: TM_TERMS }}
        requestId={REQUEST_ID}
        acceptedRelationshipId={RELATIONSHIP_ID}
        clientBillingConfirmed
      />
    );
    expect(screen.getByText('Acme Pty Ltd')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});
