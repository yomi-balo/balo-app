import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import type { AcceptProposalResult } from '@/app/(dashboard)/projects/[requestId]/_actions/accept-proposal';
import type { ProposalReviewDoc } from './proposal-review-types';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const acceptProposalAction = vi.fn<(input: unknown) => Promise<AcceptProposalResult>>();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/accept-proposal', () => ({
  acceptProposalAction: (input: unknown) => acceptProposalAction(input),
}));

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
}));

import { AcceptConfirmModal } from './accept-confirm-modal';
import { BALO_TERMS_PRECEDENCE_SENTENCE } from './proposal-standard-terms';

const REQUEST_ID = '11111111-1111-1111-1111-111111111111';
const RELATIONSHIP_ID = '22222222-2222-2222-2222-222222222222';
const PROPOSAL_ID = '33333333-3333-3333-3333-333333333333';

const mockToast = vi.mocked(toast);
const mockTrack = vi.mocked(track);

function fixedDoc(overrides: Partial<ProposalReviewDoc> = {}): ProposalReviewDoc {
  return {
    id: PROPOSAL_ID,
    relationshipId: RELATIONSHIP_ID,
    version: 1,
    status: 'submitted',
    pricingMethod: 'fixed',
    overviewHtml: '<p>Overview</p>',
    assumptions: [],
    exclusions: [],
    additionalTerms: [],
    clientCompanyName: 'Northwind',
    priceCents: 1_000_000, // A$10,000
    currency: 'aud',
    timeframeWeeks: 6,
    depositCents: null,
    rateCents: null,
    cadence: null,
    milestones: [],
    installments: [
      { id: 'i-1', label: 'Upfront', pct: 40 },
      { id: 'i-2', label: 'On delivery', pct: 60 },
    ],
    attachments: [],
    expert: {
      name: 'Priya Sharma',
      initials: 'PS',
      company: 'Acme',
      headline: 'CPQ Specialist',
      profileHref: null,
      rating: 4.9,
      ratingCount: 12,
    },
    ...overrides,
  };
}

function tmDoc(overrides: Partial<ProposalReviewDoc> = {}): ProposalReviewDoc {
  return fixedDoc({
    pricingMethod: 'tm',
    priceCents: 5_000_000,
    depositCents: 500_000, // A$5,000 deposit
    rateCents: 25_000, // A$250/hr
    cadence: 'monthly',
    installments: [],
    ...overrides,
  });
}

const SUCCESS: AcceptProposalResult = {
  success: true,
  proposalId: PROPOSAL_ID,
  expertProfileId: 'exp-7',
  transitioned: true,
};

function renderModal(doc: ProposalReviewDoc = fixedDoc()): {
  onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;
} {
  const onOpenChange = vi.fn<(open: boolean) => void>();
  render(
    <AcceptConfirmModal
      open
      onOpenChange={onOpenChange}
      requestId={REQUEST_ID}
      doc={doc}
      clientCompanyName="Northwind"
    />
  );
  return { onOpenChange };
}

describe('AcceptConfirmModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('frames the commit with the expert name and binding copy', () => {
    renderModal();
    expect(screen.getByText("Accept Priya Sharma's proposal?")).toBeInTheDocument();
    expect(screen.getByText('This starts the engagement and is binding.')).toBeInTheDocument();
    expect(screen.getByText(/understand accepting commits Northwind to them/)).toBeInTheDocument();
  });

  describe('What you’re agreeing to', () => {
    const FIVE_TERMS = ['Term one', 'Term two', 'Term three', 'Term four', 'Term five'];

    function ackCopy(): string {
      return document.getElementById('accept-ack-copy')?.textContent ?? '';
    }

    it('shows Balo’s Project T&Cs and the pricing rule, but no expert terms block, with 0 terms', () => {
      renderModal(fixedDoc());
      expect(screen.getByRole('heading', { name: 'What you’re agreeing to' })).toBeInTheDocument();
      expect(screen.getByText('Balo Project T&Cs')).toBeInTheDocument();
      expect(
        screen.getByText(
          'This is a fixed-price project. Any increase in cost is only charged if Northwind approves it.'
        )
      ).toBeInTheDocument();
      expect(screen.queryByText(/additional terms/)).not.toBeInTheDocument();
      expect(screen.queryByText(BALO_TERMS_PRECEDENCE_SENTENCE)).not.toBeInTheDocument();
      expect(ackCopy()).not.toContain('additional terms');
      expect(ackCopy()).toContain('I agree to Balo’s Project T&Cs, and understand accepting');
    });

    it('uses the time-and-materials rule for a T&M proposal', () => {
      renderModal(tmDoc());
      expect(
        screen.getByText(
          "This is a time and materials project. Northwind is billed for the hours logged each billing period. If a milestone goes over its estimate, Northwind is told, and raising an estimate needs Northwind's approval."
        )
      ).toBeInTheDocument();
    });

    it('lists 2 terms with a count and no Show all toggle', () => {
      renderModal(fixedDoc({ additionalTerms: ['Term one', 'Term two'] }));
      expect(screen.getByText('Priya Sharma’s additional terms (2)')).toBeInTheDocument();
      expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(
        expect.arrayContaining(['Term one', 'Term two'])
      );
      expect(screen.queryByRole('button', { name: /Show all|Show fewer/ })).not.toBeInTheDocument();
      expect(ackCopy()).toContain('and Priya Sharma’s additional terms above, and understand');
    });

    it('shows the first 3 of 5 terms, then all on Show all, then 3 again on Show fewer', async () => {
      const user = userEvent.setup();
      renderModal(fixedDoc({ additionalTerms: FIVE_TERMS }));
      expect(screen.getByText('Priya Sharma’s additional terms (5)')).toBeInTheDocument();
      expect(screen.getByText('Term three')).toBeInTheDocument();
      expect(screen.queryByText('Term four')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Show all 5' }));
      expect(screen.getByText('Term four')).toBeInTheDocument();
      expect(screen.getByText('Term five')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Show fewer' }));
      expect(screen.queryByText('Term four')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Show all 5' })).toBeInTheDocument();
    });

    it('does not collapse exactly 3 terms', () => {
      renderModal(fixedDoc({ additionalTerms: FIVE_TERMS.slice(0, 3) }));
      expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument();
    });

    it('collapses again when the dialog is closed and reopened', async () => {
      const user = userEvent.setup();
      const { onOpenChange } = renderModal(fixedDoc({ additionalTerms: FIVE_TERMS }));
      await user.click(screen.getByRole('button', { name: 'Show all 5' }));
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(screen.getByRole('button', { name: 'Show all 5' })).toBeInTheDocument();
    });

    it('renders markup in a term literally', () => {
      renderModal(fixedDoc({ additionalTerms: ['<b>bold</b> claim'] }));
      expect(screen.getByText('<b>bold</b> claim')).toBeInTheDocument();
    });

    it.each([
      [['A1', 'A2', 'A3'], ['E1', 'E2'], 'The proposal’s 3 assumptions and 2 exclusions are'],
      [['A1'], ['E1'], 'The proposal’s 1 assumption and 1 exclusion are'],
      [['A1', 'A2'], [], 'The proposal’s 2 assumptions are'],
      [[], ['E1'], 'The proposal’s 1 exclusion '],
    ])('states the scope counts: %j / %j', (assumptions, exclusions, expected) => {
      renderModal(fixedDoc({ assumptions, exclusions }));
      expect(screen.getByText(new RegExp(expected))).toBeInTheDocument();
    });

    it('omits the count line when there are no assumptions or exclusions', () => {
      renderModal(fixedDoc());
      expect(screen.queryByText(/are part of what you’re accepting/)).not.toBeInTheDocument();
    });

    it('scrolls the body between a fixed header and footer', () => {
      renderModal();
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveClass('flex', 'max-h-[90dvh]', 'flex-col');
      const body = screen.getByRole('heading', { name: 'What you’re agreeing to' }).parentElement
        ?.parentElement;
      expect(body).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto');
      expect(screen.getByRole('button', { name: 'Cancel' }).parentElement).toHaveClass('shrink-0');
    });
  });

  it('keeps Confirm disabled until the acknowledgement is ticked', async () => {
    const user = userEvent.setup();
    renderModal();
    const confirm = screen.getByRole('button', { name: /Confirm acceptance/ });
    expect(confirm).toBeDisabled();

    await user.click(screen.getByRole('checkbox'));
    expect(confirm).toBeEnabled();
  });

  it('computes the Fixed money summary (Total / Due now / Then) from the first installment', () => {
    renderModal(fixedDoc());
    // Total A$10,000; Due now = 40% = A$4,000; Then = A$6,000.
    expect(screen.getByText('A$10,000')).toBeInTheDocument();
    expect(screen.getByText('A$4,000')).toBeInTheDocument();
    expect(screen.getByText('A$6,000')).toBeInTheDocument();
    expect(screen.getByText('40% upfront')).toBeInTheDocument();
    expect(screen.getByText('on delivery')).toBeInTheDocument();
    expect(screen.getByText('Fixed price')).toBeInTheDocument();
  });

  it('computes the T&M money summary (deposit now, billed against time)', () => {
    renderModal(tmDoc());
    // Total A$50,000 estimate, Due now = A$5,000 deposit.
    expect(screen.getByText('A$50,000')).toBeInTheDocument();
    expect(screen.getByText('A$5,000')).toBeInTheDocument();
    expect(screen.getByText('deposit')).toBeInTheDocument();
    expect(screen.getByText(/billed against time at A\$250\/hr/)).toBeInTheDocument();
  });

  /**
   * ⚠ BAL-392 F2 — the Total row's sub-label is `pricingMethodLabel`, not a hardcoded arm.
   * This modal sits on the SAME accept surface as the summary grid, and used to read
   * capital-M `Time & Materials` against the grid's canonical lower-case cell.
   *
   * The negative assertion stayed true and got STRONGER: capital-M is now retired on the
   * proposal header pills too, so `Time & Materials` is no longer rendered anywhere a
   * client can see. The modal renders neither pill, so this query needs no scoping.
   */
  it('labels the Total row with the canonical lower-case "Time & materials" for T&M', () => {
    renderModal(tmDoc());
    expect(screen.getByText('Time & materials')).toBeInTheDocument();
    expect(screen.queryByText('Time & Materials')).not.toBeInTheDocument();
  });

  it('falls back to the full amount with nothing outstanding when a Fixed doc has no installments', () => {
    renderModal(fixedDoc({ installments: [] }));
    // Total A$10,000 → Due now reads the full amount, Then is nothing outstanding.
    expect(screen.getAllByText('A$10,000')).toHaveLength(2); // Total + Due now
    expect(screen.getByText('full amount')).toBeInTheDocument();
    expect(screen.getByText('nothing outstanding')).toBeInTheDocument();
  });

  it('reads "billed against time" with no /hr (and a A$0 deposit) when a T&M doc has a null rate and deposit', () => {
    // depositCents null exercises the `?? 0` fallback for the Due-now row.
    renderModal(tmDoc({ rateCents: null, depositCents: null }));
    expect(screen.getByText('billed against time')).toBeInTheDocument();
    expect(screen.queryByText(/\/hr/)).not.toBeInTheDocument();
    expect(screen.getByText('A$0')).toBeInTheDocument(); // Due now deposit fell back to 0
  });

  it('toasts and stays open when acceptProposalAction throws (catch path)', async () => {
    const user = userEvent.setup();
    acceptProposalAction.mockRejectedValue(new Error('boom'));
    const { onOpenChange } = renderModal();

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Confirm acceptance/ }));

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        'Could not accept this proposal. Please try again.'
      )
    );
    // Modal stays open (no close), nothing routed.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(push).not.toHaveBeenCalled();
  });

  it('does nothing on confirm while the acknowledgement is unticked (Confirm stays disabled)', async () => {
    const user = userEvent.setup();
    renderModal();
    // Confirm is disabled until ack — clicking it is a no-op (handler never runs).
    await user.click(screen.getByRole('button', { name: /Confirm acceptance/ }));
    expect(acceptProposalAction).not.toHaveBeenCalled();
  });

  it('Cancel closes the modal and resets the acknowledgement (handleOpenChange)', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderModal();
    // Tick the ack so the close-reset branch (setAck(false)) is observable.
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(acceptProposalAction).not.toHaveBeenCalled();
  });

  it('does not close on Escape while an accept is in flight (pending guard)', async () => {
    const user = userEvent.setup();
    // A never-settling action keeps the modal in the pending state.
    let release: () => void = () => {};
    acceptProposalAction.mockReturnValue(
      new Promise<AcceptProposalResult>((resolve) => {
        release = () => resolve(SUCCESS);
      })
    );
    const { onOpenChange } = renderModal();

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Confirm acceptance/ }));

    // Mid-flight: Escape must be swallowed by the `pending && !next` guard.
    await user.keyboard('{Escape}');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    // Let the action settle so the test doesn't leak a pending promise.
    release();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('on confirm calls acceptProposalAction with the doc identifiers, fires the transition analytics, toasts, routes', async () => {
    const user = userEvent.setup();
    acceptProposalAction.mockResolvedValue(SUCCESS);
    const { onOpenChange } = renderModal();

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Confirm acceptance/ }));

    await waitFor(() =>
      expect(acceptProposalAction).toHaveBeenCalledWith({
        requestId: REQUEST_ID,
        relationshipId: RELATIONSHIP_ID,
        proposalId: PROPOSAL_ID,
      })
    );
    // BAL-357: PROJECT_PROPOSAL_ACCEPTED is emitted SERVER-SIDE by the action — the
    // client must NEVER fire it (the fee + client price would leak to the browser).
    expect(mockTrack).not.toHaveBeenCalledWith('project_proposal_accepted', expect.anything());
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_REQUEST_STATUS_TRANSITIONED, {
      request_id: REQUEST_ID,
      from: 'proposal_submitted',
      to: 'accepted',
      actor: 'client',
    });
    expect(mockToast.success).toHaveBeenCalledWith('Proposal accepted');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(push).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
  });

  it('does NOT fire the transition event when transitioned is false', async () => {
    const user = userEvent.setup();
    acceptProposalAction.mockResolvedValue({ ...SUCCESS, transitioned: false });
    renderModal();

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Confirm acceptance/ }));

    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Proposal accepted'));
    expect(mockTrack).not.toHaveBeenCalledWith(
      PROJECT_EVENTS.PROJECT_REQUEST_STATUS_TRANSITIONED,
      expect.anything()
    );
  });

  it('stale-UI error closes and refreshes (nothing to retry)', async () => {
    const user = userEvent.setup();
    acceptProposalAction.mockResolvedValue({
      success: false,
      error: 'This proposal can no longer be accepted.',
    });
    const { onOpenChange } = renderModal();

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Confirm acceptance/ }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(refresh).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('generic error toasts and stays open to retry', async () => {
    const user = userEvent.setup();
    acceptProposalAction.mockResolvedValue({
      success: false,
      error: 'Could not accept this proposal. Please try again.',
    });
    const { onOpenChange } = renderModal();

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Confirm acceptance/ }));

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        'Could not accept this proposal. Please try again.'
      )
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(push).not.toHaveBeenCalled();
  });

  it('fires PROPOSAL_COHERENCE_REJECTED on a coherence failure, toasts generic copy, stays open', async () => {
    const user = userEvent.setup();
    acceptProposalAction.mockResolvedValue({
      success: false,
      error:
        "This proposal's pricing is incomplete or inconsistent. Refresh and ask the expert to re-check the pricing before accepting.",
      coherence: {
        rule: 'fixed_milestone_values_exceed_price',
        pricingMethod: 'fixed',
        proposalId: PROPOSAL_ID,
        relationshipId: RELATIONSHIP_ID,
      },
    });
    const { onOpenChange } = renderModal();

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Confirm acceptance/ }));

    await waitFor(() =>
      expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROPOSAL_COHERENCE_REJECTED, {
        rule: 'fixed_milestone_values_exceed_price',
        pricing_method: 'fixed',
        entry_point: 'web',
        proposal_id: PROPOSAL_ID,
        relationship_id: RELATIONSHIP_ID,
      })
    );
    // No success events on a coherence failure (the accepted event is server-only).
    expect(mockTrack).not.toHaveBeenCalledWith(
      PROJECT_EVENTS.PROJECT_REQUEST_STATUS_TRANSITIONED,
      expect.anything()
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(push).not.toHaveBeenCalled();
  });
});
