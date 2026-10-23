import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/utils';

// The board calls two server actions — mock both so it renders + fires in JSDOM.
const mockMarkInvoiceSent = vi.fn();
const mockApproveKickoff = vi.fn();

vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/mark-upfront-invoice-raised', () => ({
  markUpfrontInvoiceRaisedAction: (...args: unknown[]) => mockMarkInvoiceSent(...args),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/approve-kickoff', () => ({
  approveKickoffAction: (...args: unknown[]) => mockApproveKickoff(...args),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const mockRefresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

import { toast } from 'sonner';
import { track, PROJECT_EVENTS, BILLING_EVENTS } from '@/lib/analytics';
import type { KickoffBillingCapture } from '@/lib/billing/billing-capture';
import { KickoffBoard } from './kickoff-board';

const mockToast = vi.mocked(toast);

const REQUEST_ID = 'req-1';
const RELATIONSHIP_ID = 'rel-accepted-1';
const COMPANY_ID = 'company-1';

/** Client billing-capture context — the page passes this for the client lens. */
function billingCapture(overrides: Partial<KickoffBillingCapture> = {}): KickoffBillingCapture {
  return { companyId: COMPANY_ID, canManage: true, details: null, ...overrides };
}

type BoardProps = React.ComponentProps<typeof KickoffBoard>;

/** A$5,220 due upfront — the client's fee-inclusive figure. */
const UPFRONT = { amountCents: 522_000, currency: 'aud' };
/** What the expert lens receives: the steps, never the client-price amount. */
const UPFRONT_WITHHELD = { amountCents: null, currency: 'aud' };

function renderBoard(overrides: Partial<BoardProps> = {}): ReturnType<typeof render> {
  const props: BoardProps = {
    requestId: REQUEST_ID,
    acceptedRelationshipId: RELATIONSHIP_ID,
    lens: 'client',
    clientBillingConfirmed: false,
    upfrontInvoiceRaised: false,
    approved: false,
    expertName: 'Priya Nair',
    clientCompanyName: 'Northwind Industrial',
    upfront: UPFRONT,
    ...overrides,
  };
  return render(<KickoffBoard {...props} />);
}

/** The row labels, in order. */
function rowLabels(): (string | null | undefined)[] {
  return screen.getAllByRole('listitem').map((li) => li.querySelector('p')?.textContent);
}

/** Each step's thread state, in order. */
function stepStates(): (string | null)[] {
  return screen.getAllByRole('listitem').map((li) => li.getAttribute('data-step-state'));
}

/** The label of the single row marked `aria-current="step"`, or null when none is. */
function currentLabel(): string | null {
  const current = document.querySelectorAll('[aria-current="step"]');
  expect(current.length).toBeLessThanOrEqual(1);
  return current[0]?.querySelector('p')?.textContent ?? null;
}

describe('KickoffBoard — structure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders billing → invoice → payment when money is due upfront', () => {
    renderBoard();
    expect(screen.getByRole('heading', { name: 'Before kickoff' })).toBeInTheDocument();
    expect(rowLabels()).toEqual([
      'Add billing details',
      'Raise the upfront invoice',
      'Pay the upfront invoice',
    ]);
    expect(screen.getByText('0 of 3 done')).toBeInTheDocument();
  });

  it('drops the invoice steps for a single Balo approval when nothing is due upfront', () => {
    renderBoard({ upfront: null });
    expect(rowLabels()).toEqual(['Add billing details', 'Approve kickoff']);
    expect(screen.getByText('0 of 2 done')).toBeInTheDocument();
    expect(stepStates()).toEqual(['current', 'future']);
    expect(screen.getByText('Available once billing details are in')).toBeInTheDocument();
    expect(
      screen.queryByText('Nothing is due upfront — waiting on Balo to approve kickoff')
    ).not.toBeInTheDocument();
  });

  it('shows the approval line once billing is in and nothing is due upfront', () => {
    renderBoard({ upfront: null, clientBillingConfirmed: true });
    expect(stepStates()).toEqual(['done', 'current']);
    expect(
      screen.getByText('Nothing is due upfront — waiting on Balo to approve kickoff')
    ).toBeInTheDocument();
  });

  it('counts finished steps towards the ready tally', () => {
    renderBoard({ clientBillingConfirmed: true, upfrontInvoiceRaised: true });
    expect(screen.getByText('2 of 3 done')).toBeInTheDocument();
    expect(stepStates()).toEqual(['done', 'done', 'current']);
  });

  it.each(['client', 'expert', 'admin'] as const)(
    '%s lens: aria-current marks the first not-done step only',
    (lens) => {
      renderBoard({
        lens,
        upfront: lens === 'expert' ? UPFRONT_WITHHELD : UPFRONT,
        clientBillingConfirmed: true,
        billing: lens === 'client' ? billingCapture() : null,
      });
      expect(currentLabel()).toBe('Raise the upfront invoice');
    }
  );

  it('styles steps by state: future label muted, current client owner in primary', () => {
    renderBoard({ lens: 'client', billing: billingCapture() });
    const labelOf = (text: string): HTMLElement => screen.getByText(text);
    expect(labelOf('Add billing details').className).toContain('text-foreground');
    expect(labelOf('Raise the upfront invoice').className).toContain('text-muted-foreground');
    expect(labelOf('Raise the upfront invoice').className).not.toContain('text-foreground');
    const [billingOwner, paymentOwner] = screen.getAllByText('You');
    expect(billingOwner?.className).toContain('text-primary');
    expect(paymentOwner?.className).not.toContain('text-primary');
  });

  it('has no aria-current step once approved, and the counter reads "All done"', () => {
    renderBoard({ clientBillingConfirmed: true, upfrontInvoiceRaised: true, approved: true });
    expect(currentLabel()).toBeNull();
    expect(screen.getByText('All done')).toBeInTheDocument();
  });
});

describe('KickoffBoard — who each row is waiting on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('client: billing is theirs; the invoice waits on Balo; payment is due once it is sent', () => {
    renderBoard({ lens: 'client', billing: billingCapture() });
    expect(screen.getByText('Add your billing details')).toBeInTheDocument();
    expect(screen.getByText('Available once billing details are in')).toBeInTheDocument();
    expect(screen.getByText('Due once Balo sends the A$5,220 upfront invoice')).toBeInTheDocument();
    // Billing and payment are both the client's — two "You" owner labels.
    expect(screen.getAllByText('You')).toHaveLength(2);
    expect(screen.getByText('Balo')).toBeInTheDocument();
  });

  it('client: once billing is in, the invoice step waits on Balo', () => {
    renderBoard({ lens: 'client', billing: billingCapture(), clientBillingConfirmed: true });
    expect(
      screen.getByText('Waiting on Balo to send the A$5,220 upfront invoice')
    ).toBeInTheDocument();
  });

  it('client: once the invoice is sent, the payment row is theirs to pay', () => {
    renderBoard({
      lens: 'client',
      billing: billingCapture(),
      clientBillingConfirmed: true,
      upfrontInvoiceRaised: true,
    });
    expect(screen.getByText('Invoice for A$5,220 sent')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Pay the A$5,220 upfront invoice Balo sent — kickoff follows as soon as it lands'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText('To pay')).not.toBeInTheDocument();
    const paymentRow = screen.getByText('Pay the upfront invoice').closest('li');
    expect(paymentRow).toHaveAttribute('aria-current', 'step');
  });

  it('expert: names the client and Balo, never shows the client-price amount', () => {
    renderBoard({ lens: 'expert', upfront: UPFRONT_WITHHELD });
    expect(
      screen.getByText('Waiting on Northwind Industrial to add billing details')
    ).toBeInTheDocument();
    expect(screen.getByText('Available once billing details are in')).toBeInTheDocument();
    expect(screen.getByText('Due once Balo sends the upfront invoice')).toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
    expect(screen.queryByText('You')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText('Waiting')).not.toBeInTheDocument();
    expect(screen.getByText('Balo')).toBeInTheDocument();
    expect(screen.getAllByText('Northwind Industrial')).toHaveLength(2);
  });

  it('expert: shows the waiting copy once each step is current', () => {
    const { unmount } = renderBoard({
      lens: 'expert',
      upfront: UPFRONT_WITHHELD,
      clientBillingConfirmed: true,
    });
    expect(screen.getByText('Waiting on Balo to send the upfront invoice')).toBeInTheDocument();
    unmount();
    renderBoard({
      lens: 'expert',
      upfront: UPFRONT_WITHHELD,
      clientBillingConfirmed: true,
      upfrontInvoiceRaised: true,
    });
    expect(
      screen.getByText('Waiting on Northwind Industrial to pay the upfront invoice')
    ).toBeInTheDocument();
  });
});

describe('KickoffBoard — admin actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows no admin action until the step is current', () => {
    renderBoard({ lens: 'admin' });
    expect(screen.queryByRole('button', { name: /^Mark sent/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Confirm payment/ })).not.toBeInTheDocument();
    expect(screen.getAllByText('Available once billing details are in')).toHaveLength(1);
    expect(screen.getAllByText('You')).toHaveLength(1);
    expect(screen.getAllByText('Northwind Industrial')).toHaveLength(2);
  });

  it('offers Mark sent once billing is in, with the invoice instruction', () => {
    renderBoard({ lens: 'admin', clientBillingConfirmed: true });
    expect(screen.getByRole('button', { name: /^Mark sent/ })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /^Confirm payment/ })).not.toBeInTheDocument();
    expect(
      screen.getByText('Invoice Northwind Industrial for A$5,220, then mark it sent')
    ).toBeInTheDocument();
  });

  it('Mark sent records the invoice, fires the gate event, toasts, and refreshes', async () => {
    mockMarkInvoiceSent.mockResolvedValue({ success: true, changed: true });
    renderBoard({ lens: 'admin', clientBillingConfirmed: true });

    fireEvent.click(screen.getByRole('button', { name: /^Mark sent/ }));

    await waitFor(() => {
      expect(mockMarkInvoiceSent).toHaveBeenCalledWith({
        requestId: REQUEST_ID,
        relationshipId: RELATIONSHIP_ID,
      });
    });
    expect(track).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_UPFRONT_INVOICE_RAISED, {
      request_id: REQUEST_ID,
      relationship_id: RELATIONSHIP_ID,
      actor: 'admin',
    });
    expect(mockToast.success).toHaveBeenCalledWith('Invoice marked as sent');
    expect(mockRefresh).toHaveBeenCalled();
    expect(mockApproveKickoff).not.toHaveBeenCalled();
  });

  it('a repeat raise (already recorded) refreshes without firing the event again', async () => {
    mockMarkInvoiceSent.mockResolvedValue({ success: true, changed: false });
    renderBoard({ lens: 'admin', clientBillingConfirmed: true });

    fireEvent.click(screen.getByRole('button', { name: /^Mark sent/ }));

    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    expect(track).not.toHaveBeenCalled();
  });

  it('shows the invoice amount to the cent — it is what the admin types into the invoice', () => {
    renderBoard({
      lens: 'admin',
      clientBillingConfirmed: true,
      upfront: { amountCents: 462_938, currency: 'aud' },
    });
    expect(
      screen.getByText('Invoice Northwind Industrial for A$4,629.38, then mark it sent')
    ).toBeInTheDocument();
  });

  it('toasts the error and does not refresh when Mark sent fails', async () => {
    mockMarkInvoiceSent.mockResolvedValue({ success: false, error: 'Could not record it.' });
    renderBoard({ lens: 'admin', clientBillingConfirmed: true });

    fireEvent.click(screen.getByRole('button', { name: /^Mark sent/ }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('Could not record it.'));
    expect(track).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('Confirm payment approves the kickoff, fires BOTH analytics events, toasts, and refreshes', async () => {
    mockApproveKickoff.mockResolvedValue({ success: true, engagementId: 'eng-1' });
    renderBoard({ lens: 'admin', clientBillingConfirmed: true, upfrontInvoiceRaised: true });

    fireEvent.click(screen.getByRole('button', { name: /^Confirm payment/ }));

    await waitFor(() => {
      expect(mockApproveKickoff).toHaveBeenCalledWith({
        requestId: REQUEST_ID,
        relationshipId: RELATIONSHIP_ID,
      });
    });
    expect(track).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_KICKOFF_APPROVED, {
      request_id: REQUEST_ID,
      actor: 'admin',
    });
    expect(track).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_REQUEST_STATUS_TRANSITIONED, {
      request_id: REQUEST_ID,
      from: 'accepted',
      to: 'kickoff_approved',
      actor: 'admin',
    });
    expect(mockToast.success).toHaveBeenCalledWith('Kickoff approved — engagement created');
    expect(mockRefresh).toHaveBeenCalled();
    expect(mockMarkInvoiceSent).not.toHaveBeenCalled();
  });

  it('with nothing due upfront, Approve is enabled once billing is in', () => {
    renderBoard({ lens: 'admin', upfront: null, clientBillingConfirmed: true });
    expect(screen.getByRole('button', { name: /^Approve/ })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /^Mark sent/ })).not.toBeInTheDocument();
  });

  it('toasts the error and fires no analytics when approval fails', async () => {
    mockApproveKickoff.mockResolvedValue({ success: false, error: 'Not yet.' });
    renderBoard({ lens: 'admin', clientBillingConfirmed: true, upfrontInvoiceRaised: true });

    fireEvent.click(screen.getByRole('button', { name: /^Confirm payment/ }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('Not yet.'));
    expect(track).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe('KickoffBoard — client billing capture (BAL-323)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the client billing row opens the capture form', async () => {
    renderBoard({ lens: 'client', billing: billingCapture({ canManage: true }) });

    fireEvent.click(screen.getByRole('button', { name: /Add details/i }));

    await waitFor(() => expect(screen.getByText('Legal / entity name')).toBeInTheDocument());
  });

  it('shows a View affordance and no "Done" chip on the confirmed billing step (owner/admin)', () => {
    renderBoard({
      lens: 'client',
      clientBillingConfirmed: true,
      billing: billingCapture({
        details: {
          legalName: 'Acme Pty Ltd',
          countryCode: 'AU',
          taxId: '51 824 753 556',
          address: null,
          billingEmail: 'ap@acme.example',
        },
      }),
    });
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View billing details' })).toBeInTheDocument();
  });

  it('a member on a confirmed billing step gets no View button', () => {
    renderBoard({
      lens: 'client',
      clientBillingConfirmed: true,
      billing: billingCapture({ canManage: false, details: null }),
    });
    expect(screen.queryByRole('button', { name: 'View billing details' })).not.toBeInTheDocument();
  });

  it('a plain member sees the "what happens next" notice, not a capture button', () => {
    renderBoard({ lens: 'client', billing: billingCapture({ canManage: false }) });
    expect(
      screen.getByText(/A company owner or admin needs to add these billing details/i)
    ).toBeInTheDocument();
    expect(screen.queryByText('Owner/admin only')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add details/i })).not.toBeInTheDocument();
  });

  it('shows the member notice on the mobile board too', () => {
    renderBoard({ lens: 'client', billing: billingCapture({ canManage: false }), mobile: true });
    expect(
      screen.getByText(/A company owner or admin needs to add these billing details/i)
    ).toBeInTheDocument();
  });

  it('the board itself never fires blocked_view analytics — the shell owns that (dedup)', () => {
    // The board mounts twice per client (desktop + mobile sheet); the blocked-view
    // event is fired once from the single-mount shell tracker instead.
    renderBoard({ lens: 'client', billing: billingCapture({ canManage: false }) });
    expect(track).not.toHaveBeenCalledWith(BILLING_EVENTS.DETAILS_BLOCKED_VIEW, expect.anything());
  });
});

describe('KickoffBoard — terminal (approved) state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the celebratory banner with every step done and no action buttons', () => {
    renderBoard({
      lens: 'admin',
      clientBillingConfirmed: true,
      upfrontInvoiceRaised: true,
      approved: true,
    });
    expect(screen.getByText('Project kicked off 🎉')).toBeInTheDocument();
    expect(screen.getByText(/left the request pipeline and entered delivery/i)).toBeInTheDocument();
    expect(stepStates()).toEqual(['done', 'done', 'done']);
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
    expect(screen.getByText('All done')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
