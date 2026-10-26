import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { ProposalSummaryCard } from './proposal-summary-card';
import {
  emptyDraftState,
  nextDraftKey,
  type ProposalDraftState,
  type ReadinessIssue,
  type ReadinessResult,
} from './proposal-composer-state';

const OVERVIEW_ISSUE: ReadinessIssue = {
  id: 'overview',
  label: 'Add an overview',
  targetId: 'proposal-overview',
};
const PRICE_ISSUE: ReadinessIssue = {
  id: 'price',
  label: 'Set your project price',
  targetId: 'proposal-fixed-price',
};
const NOTE_ISSUE: ReadinessIssue = {
  id: 'change_request',
  label: 'Mark the change note as addressed',
  targetId: 'proposal-change-note',
};

const READY: ReadinessResult = { ready: true, issues: [] };
const NOT_READY: ReadinessResult = { ready: false, issues: [OVERVIEW_ISSUE, PRICE_ISSUE] };

function fixedState(overrides: Partial<ProposalDraftState> = {}): ProposalDraftState {
  return {
    ...emptyDraftState(),
    fixedPriceCents: 500_000,
    installments: [
      { key: nextDraftKey(), label: 'Upfront', pct: 30 },
      { key: nextDraftKey(), label: 'Delivery', pct: 70 },
    ],
    ...overrides,
  };
}

function renderCard(props: Partial<React.ComponentProps<typeof ProposalSummaryCard>> = {}): {
  onJump: ReturnType<typeof vi.fn>;
  onPreview: ReturnType<typeof vi.fn>;
} {
  const onJump = vi.fn();
  const onPreview = vi.fn();
  render(
    <ProposalSummaryCard
      state={fixedState()}
      totalCents={500_000}
      readiness={READY}
      softIssues={[]}
      termsAttached={false}
      reviseMode={false}
      nudgeKey={0}
      onJump={onJump}
      onPreview={onPreview}
      {...props}
    />
  );
  return { onJump, onPreview };
}

describe('ProposalSummaryCard', () => {
  it('lists each outstanding issue and jumps to the one clicked', async () => {
    const user = userEvent.setup();
    const { onJump } = renderCard({ readiness: NOT_READY });

    expect(screen.getByText('2 things left before you can send')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Set your project price' }));

    expect(onJump).toHaveBeenCalledWith(PRICE_ISSUE);
  });

  it('uses the singular heading for a single issue', () => {
    renderCard({ readiness: { ready: false, issues: [OVERVIEW_ISSUE] } });
    expect(screen.getByText('1 thing left before you can send')).toBeInTheDocument();
  });

  it('keeps the CTA enabled while issues remain and previews on click', async () => {
    const user = userEvent.setup();
    const { onPreview } = renderCard({ readiness: NOT_READY });

    const cta = screen.getByRole('button', { name: 'Preview and send' });
    expect(cta).toBeEnabled();
    await user.click(cta);

    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Nothing is sent until you confirm in the preview.')).toBeVisible();
  });

  it('relabels the CTA in revise mode', () => {
    renderCard({ reviseMode: true });
    expect(screen.getByRole('button', { name: 'Preview and resend' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Preview and send' })).not.toBeInTheDocument();
  });

  it('shows Ready to send with soft items that still jump', async () => {
    const user = userEvent.setup();
    const { onJump } = renderCard({ softIssues: [NOTE_ISSUE] });

    expect(screen.getByText('Ready to send')).toBeInTheDocument();
    expect(screen.queryByText(/left before you can send/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mark the change note as addressed' }));

    expect(onJump).toHaveBeenCalledWith(NOTE_ISSUE);
  });

  it('shows the fixed total, payment count and property rows', () => {
    renderCard({ state: fixedState({ timeframeWeeks: 6 }) });

    expect(screen.getByText('A$5,000')).toBeInTheDocument();
    expect(screen.getByText('Paid in 2 payments')).toBeInTheDocument();
    expect(screen.getByText('Fixed price')).toBeInTheDocument();
    expect(screen.getByText('About 6 weeks')).toBeInTheDocument();
    expect(screen.getByText('30% / 70%')).toBeInTheDocument();
    expect(screen.getByText('Balo standard')).toBeInTheDocument();
  });

  it('prompts for a price and shows unset rows when nothing is filled in', () => {
    renderCard({
      state: fixedState({ fixedPriceCents: null, installments: [] }),
      totalCents: 0,
    });

    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('Set your project price')).toBeInTheDocument();
    expect(screen.getAllByText('Not set')).toHaveLength(2);
  });

  it('names the expert terms when a terms document is attached', () => {
    renderCard({ termsAttached: true });
    expect(screen.getByText('Balo and yours')).toBeInTheDocument();
  });

  it('shows the hourly rate, hours and estimate for time and materials', () => {
    const milestone = {
      key: nextDraftKey(),
      title: 'Build',
      descriptionHtml: '',
      acceptanceCriteria: '',
      valueCents: null,
      estimatedMinutes: 600,
    };
    renderCard({
      state: fixedState({
        pricingMethod: 'tm',
        rateCents: 20_000,
        cadence: 'fortnightly',
        milestones: [milestone],
      }),
      totalCents: 200_000,
    });

    expect(screen.getByText('A$200')).toBeInTheDocument();
    expect(screen.getByText('/hr')).toBeInTheDocument();
    expect(screen.getByText('About 10 hours, estimated A$2,000')).toBeInTheDocument();
    expect(screen.getByText('Time & materials')).toBeInTheDocument();
    expect(screen.getByText('Fortnightly invoices')).toBeInTheDocument();
  });

  it('asks for hour estimates and a rate when time and materials is empty', () => {
    renderCard({
      state: fixedState({ pricingMethod: 'tm', rateCents: null }),
      totalCents: 0,
    });

    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('Add hour estimates to see an estimate')).toBeInTheDocument();
    expect(screen.getByText('Monthly invoices')).toBeInTheDocument();
  });

  it('replays the nudge only after the CTA has bumped the key', () => {
    const { rerender } = render(
      <ProposalSummaryCard
        state={fixedState()}
        totalCents={500_000}
        readiness={NOT_READY}
        softIssues={[]}
        termsAttached={false}
        reviseMode={false}
        nudgeKey={0}
        onJump={vi.fn()}
        onPreview={vi.fn()}
      />
    );
    const heading = (): HTMLElement | null =>
      screen.getByText('2 things left before you can send').closest('div');
    expect(heading()).not.toHaveClass('animate-shake');

    rerender(
      <ProposalSummaryCard
        state={fixedState()}
        totalCents={500_000}
        readiness={NOT_READY}
        softIssues={[]}
        termsAttached={false}
        reviseMode={false}
        nudgeKey={1}
        onJump={vi.fn()}
        onPreview={vi.fn()}
      />
    );
    expect(heading()).toHaveClass('animate-shake', 'motion-reduce:animate-none');
  });

  it('never renders the client-facing (marked-up) figure', () => {
    const { container } = render(
      <ProposalSummaryCard
        state={fixedState()}
        totalCents={500_000}
        readiness={READY}
        softIssues={[]}
        termsAttached={false}
        reviseMode={false}
        nudgeKey={0}
        onJump={vi.fn()}
        onPreview={vi.fn()}
      />
    );
    expect(container).toHaveTextContent('A$5,000');
    expect(container).not.toHaveTextContent('A$6,250');
  });
});

describe('ProposalSummaryCard — AI draft', () => {
  it('reads Milestones as a dash and the checklist head as drafting', () => {
    renderCard({ readiness: NOT_READY, drafting: true, clientFirstName: 'Dana' });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    const head = screen.getByText("Drafting from Dana's request…");
    expect(head).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('Milestones').nextElementSibling).toHaveTextContent('—');
    expect(screen.queryByText(/left before you can send/)).not.toBeInTheDocument();
    expect(screen.queryByText('Ready to send')).not.toBeInTheDocument();
    expect(screen.queryByText('Add an overview')).not.toBeInTheDocument();
  });

  it('keeps the issue count and milestone total when not drafting', () => {
    renderCard({ readiness: NOT_READY });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('Milestones').nextElementSibling).toHaveTextContent('1');
    expect(screen.getByText('2 things left before you can send')).toBeInTheDocument();
  });
});
