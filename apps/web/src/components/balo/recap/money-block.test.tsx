import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axe } from 'jest-axe';
import { render, screen } from '@/test/utils';
import { track, CASE_BILLING_EVENTS } from '@/lib/analytics';
import { MoneyBlock, type SessionMoneyBlock } from './money-block';

const CLIENT_FINALIZED: SessionMoneyBlock = {
  lens: 'client',
  state: 'finalized',
  sessionId: 'session_1',
  durationMinutes: 45,
  amountAudMinor: 15_000,
  ratePerMinuteMinor: 333,
  settlementStatus: 'not_required',
  finalizationPath: 'live_capture',
};

const EXPERT_FINALIZED: SessionMoneyBlock = {
  lens: 'expert',
  state: 'finalized',
  sessionId: 'session_1',
  durationMinutes: 45,
  earningsAudMinor: 11_250,
  payoutStatus: 'recorded',
  finalizationPath: 'live_capture',
};

const CLIENT_PENDING: SessionMoneyBlock = {
  lens: 'client',
  state: 'pending',
  sessionId: 'session_1',
  durationMinutes: 0,
  amountAudMinor: 0,
  ratePerMinuteMinor: 333,
  settlementStatus: 'not_required',
};

const EXPERT_PENDING: SessionMoneyBlock = {
  lens: 'expert',
  state: 'pending',
  sessionId: 'session_1',
  durationMinutes: 0,
  earningsAudMinor: 0,
};

describe('MoneyBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a skeleton while loading', () => {
    render(<MoneyBlock block={null} loading />);
    expect(screen.getByLabelText(/Loading receipt/)).toBeInTheDocument();
  });

  it('renders a LENS-NEUTRAL muted fallback (no raw error) when the block is null', () => {
    render(<MoneyBlock block={null} />);
    // `block` is null so the lens is unknown - and BAL-388's recap is the first surface that
    // shows this fragment to an EXPERT, who has no receipt.
    expect(screen.getByText(/these details will be ready shortly/i)).toBeInTheDocument();
    expect(screen.queryByText(/receipt will be ready/i)).not.toBeInTheDocument();
  });

  it('LABELS the finalized figure per lens, so the amount is never a bare number', () => {
    // Suppressing the receipt/payout ANCHOR (D-C) removed the only text attached to the
    // number: a screen reader announced the single most consequential fact on the recap with
    // no context at all. D-C required dropping the LINK, not the MEANING.
    const { unmount } = render(<MoneyBlock block={CLIENT_FINALIZED} />);
    expect(screen.getByText('Charged')).toBeInTheDocument();
    unmount();

    render(<MoneyBlock block={EXPERT_FINALIZED} />);
    expect(screen.getByText('Your payout')).toBeInTheDocument();
    expect(screen.queryByText('Charged')).not.toBeInTheDocument();
  });

  it('renders NO receipt/payout anchor at all (the /sessions routes do not exist)', () => {
    const { container } = render(<MoneyBlock block={CLIENT_FINALIZED} />);
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });

  it('renders the client all-in charge when finalized', () => {
    render(<MoneyBlock block={CLIENT_FINALIZED} />);
    expect(screen.getByText(/^A\$150\.00$/)).toBeInTheDocument();
    // Fee concealment at the surface: the expert earnings figure is nowhere.
    expect(screen.queryByText(/^A\$112\.50$/)).not.toBeInTheDocument();
  });

  it('renders the expert own earnings when finalized', () => {
    render(<MoneyBlock block={EXPERT_FINALIZED} />);
    expect(screen.getByText(/^A\$112\.50$/)).toBeInTheDocument();
    expect(screen.queryByText(/^A\$150\.00$/)).not.toBeInTheDocument();
  });

  // ── BAL-388, D-C — the dead receipt/payout anchor is SUPPRESSED ────────────────────────
  //
  // No `/sessions` route exists anywhere under `apps/web/src/app`, and the recap page is the
  // first surface that would put this link in front of a user. The FIGURE stays; the ANCHOR
  // goes. These two assertions are what stop it silently coming back.
  it('renders NO anchor at all in the finalized state (client lens)', () => {
    const { container } = render(<MoneyBlock block={CLIENT_FINALIZED} />);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });

  it('emits no /sessions/ href on either lens', () => {
    const client = render(<MoneyBlock block={CLIENT_FINALIZED} />);
    expect(client.container.innerHTML).not.toContain('/sessions/');
    client.unmount();
    const expert = render(<MoneyBlock block={EXPERT_FINALIZED} />);
    expect(expert.container.innerHTML).not.toContain('/sessions/');
  });

  it('formats the currency with font-mono tabular-nums (aligned columns, both themes)', () => {
    render(<MoneyBlock block={CLIENT_FINALIZED} />);
    const amount = screen.getByText(/^A\$150\.00$/);
    expect(amount).toHaveClass('font-mono');
    expect(amount).toHaveClass('tabular-nums');
  });

  it('shows the pending pill and fires PENDING_SHOWN once on mount (client)', () => {
    render(<MoneyBlock block={CLIENT_PENDING} elapsedMinutes={12} />);
    expect(screen.getByText(/Charge pending/)).toBeInTheDocument();
    expect(screen.getByText(/12 min elapsed/i)).toBeInTheDocument();
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(CASE_BILLING_EVENTS.PENDING_SHOWN, {
      session_id: 'session_1',
      elapsed_min: 12,
    });
    // Pending never leaks a finalized figure.
    expect(screen.queryByText(/A\$/)).not.toBeInTheDocument();
  });

  it('shows the expert pending pill copy', () => {
    render(<MoneyBlock block={EXPERT_PENDING} elapsedMinutes={5} />);
    expect(screen.getByText(/Payout pending/)).toBeInTheDocument();
  });

  it('renders inside a dark container without crashing (semantic tokens)', () => {
    const { container } = render(
      <div className="dark">
        <MoneyBlock block={CLIENT_FINALIZED} />
      </div>
    );
    expect(container.querySelector('.dark')).not.toBeNull();
    expect(screen.getByText(/^A\$150\.00$/)).toBeInTheDocument();
  });

  it('has no accessibility violations when finalized', async () => {
    const { container } = render(<MoneyBlock block={CLIENT_FINALIZED} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no accessibility violations in the PENDING render (exercises the <output> live region)', async () => {
    const { container } = render(<MoneyBlock block={CLIENT_PENDING} elapsedMinutes={12} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no accessibility violations in the ERROR fallback render', async () => {
    const { container } = render(<MoneyBlock block={null} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
