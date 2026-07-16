import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { ProposalReview, presentSections } from './proposal-review';
import type { ProposalReviewDoc } from './proposal-review-types';

/** The proposal switcher is a `role="group"` of plain `aria-pressed` buttons. */
function switcher(): HTMLElement {
  return screen.getByRole('group', { name: 'Choose a proposal to review' });
}

// ProposalDoc renders a ssr:false Tiptap viewer — swap the viewer for a plain div.
vi.mock('@/components/balo/rich-text-editor', () => ({
  RichTextViewer: ({ value }: { value: string }) => <div data-testid="rt-viewer">{value}</div>,
  isDescriptionEmpty: (html: string) => html.replace(/<[^<>]*>/g, '').trim() === '',
}));

// The decision modals import server actions (and next/navigation, sonner) — stub
// all so the review surface mounts in isolation.
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/accept-proposal', () => ({
  acceptProposalAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/request-proposal-changes', () => ({
  requestProposalChangesAction: vi.fn(),
}));
// The share menu + shared-with card import BAL-386 server actions (which pull
// @balo/db + server-only) — stub the module so the review surface mounts client-side.
vi.mock('@/app/(dashboard)/projects/[requestId]/proposal/[relationshipId]/_actions/share', () => ({
  shareProposalWithColleague: vi.fn(),
  revokeProposalShareLink: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

function doc(overrides: Partial<ProposalReviewDoc> = {}): ProposalReviewDoc {
  return {
    id: 'prop-priya',
    relationshipId: 'rel-priya',
    version: 1,
    status: 'submitted',
    pricingMethod: 'fixed',
    overviewHtml: 'Priya overview',
    exclusionsHtml: null,
    priceCents: 5_800_000,
    currency: 'aud',
    timeframeWeeks: 8,
    depositCents: null,
    rateCents: null,
    cadence: null,
    milestones: [],
    installments: [{ id: 'i-1', label: 'Upfront', pct: 40 }],
    attachments: [],
    expert: {
      name: 'Priya Sharma',
      initials: 'PS',
      company: 'Acme',
      headline: 'CPQ',
      rating: 4.9,
    },
    ...overrides,
  };
}

function marcus(overrides: Partial<ProposalReviewDoc> = {}): ProposalReviewDoc {
  return doc({
    id: 'prop-marcus',
    relationshipId: 'rel-marcus',
    overviewHtml: 'Marcus overview',
    priceCents: 6_200_000,
    expert: { name: 'Marcus Lee', initials: 'ML', company: 'Globex', headline: 'Dev', rating: 4.7 },
    ...overrides,
  });
}

function renderReview(proposals: ProposalReviewDoc[], activeRelationshipId = 'rel-priya'): void {
  render(
    <ProposalReview
      requestId="req-1"
      proposals={proposals}
      activeRelationshipId={activeRelationshipId}
      clientCompanyName="Northwind"
      clientFirstName="Dana"
    />
  );
}

describe('presentSections', () => {
  it('always includes overview/milestones/payment/terms', () => {
    const keys = presentSections(doc()).map((s) => s.key);
    expect(keys).toEqual(['overview', 'milestones', 'payment', 'terms']);
  });

  it('hides Attachments when only terms docs are attached', () => {
    const keys = presentSections(
      doc({ attachments: [{ id: 'a', fileName: 'msa.pdf', sizeBytes: 10, kind: 'terms' }] })
    ).map((s) => s.key);
    expect(keys).not.toContain('attachments');
  });

  it('includes Attachments when a non-terms file is attached', () => {
    const keys = presentSections(
      doc({ attachments: [{ id: 'a', fileName: 'spec.pdf', sizeBytes: 10, kind: 'ref' }] })
    ).map((s) => s.key);
    expect(keys).toContain('attachments');
  });
});

describe('ProposalReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows no switcher for a single proposal', () => {
    renderReview([doc()]);
    // The lone expert name still renders (in the summary card), but no switcher chip set.
    expect(screen.queryByText('Marcus')).not.toBeInTheDocument();
  });

  it('shows a switcher with a changes_requested status dot for >1 proposals', () => {
    renderReview([doc(), marcus({ status: 'changes_requested' })]);
    const group = switcher();
    expect(within(group).getByRole('button', { name: /Priya/ })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: /Marcus/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Changes requested')).toBeInTheDocument();
  });

  it('renders an awaiting-revision state (no Accept) when the active proposal has changes requested', () => {
    renderReview([doc({ status: 'changes_requested' })]);
    expect(screen.getByText('Changes requested from Priya')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept this proposal' })).not.toBeInTheDocument();
  });

  it('hides the Share menu while changes are requested (the doc it would hand over is hidden)', () => {
    renderReview([doc({ status: 'changes_requested' })]);
    expect(screen.queryByRole('button', { name: /Share/ })).not.toBeInTheDocument();
  });

  it('shows the Share menu alongside the visible doc (submitted)', () => {
    renderReview([doc()]);
    expect(screen.getByRole('button', { name: /Share/ })).toBeInTheDocument();
  });

  it('switches the active doc when a switcher chip is clicked', async () => {
    const user = userEvent.setup();
    renderReview([doc(), marcus()]);

    // Priya is active first — her overview is shown.
    expect(screen.getAllByText('Priya overview').length).toBeGreaterThan(0);

    await user.click(within(switcher()).getByRole('button', { name: /Marcus/ }));
    expect(screen.getAllByText('Marcus overview').length).toBeGreaterThan(0);
  });

  it('opens the active proposal matching activeRelationshipId', () => {
    renderReview([doc(), marcus()], 'rel-marcus');
    const marcusChip = within(switcher()).getByRole('button', { name: /Marcus/ });
    expect(marcusChip).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByText('Marcus overview').length).toBeGreaterThan(0);
  });

  it('renders the desktop Accept CTA for a submitted proposal', () => {
    renderReview([doc()]);
    // Desktop summary card + mobile rail both carry the Accept CTA.
    const accepts = screen.getAllByRole('button', { name: 'Accept this proposal' });
    expect(accepts.length).toBeGreaterThan(0);
  });

  it('renders enabled "Request changes" actions (no longer "Available soon") for a submitted proposal', () => {
    renderReview([doc()]);
    // Desktop "Request changes" + mobile "Changes" — both enabled now.
    const changeButtons = screen.getAllByRole('button', { name: /Changes/ });
    expect(changeButtons.length).toBeGreaterThan(0);
    for (const button of changeButtons) {
      expect(button).toBeEnabled();
      expect(button).not.toHaveAttribute('aria-disabled');
      expect(button).not.toHaveAttribute('title', 'Available soon');
    }
  });

  it('opens the ChangesModal when "Request changes" is clicked', async () => {
    const user = userEvent.setup();
    renderReview([doc()]);
    // The modal is mounted but closed (dialog hidden) until the action fires.
    expect(screen.queryByText('Request changes from Priya')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Request changes' }));
    expect(screen.getByText('Request changes from Priya')).toBeInTheDocument();
  });

  it('does not render the changes actions when the proposal is not submitted (accepted)', () => {
    renderReview([doc({ status: 'accepted' })]);
    expect(screen.queryByRole('button', { name: /Request changes/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept this proposal' })).not.toBeInTheDocument();
  });
});
