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
  // BAL-412 — a live_capture session: no presence settlement, no floor.
  actualMinutes: 45,
  billingFloorApplied: false,
  billingFloorMinutes: 0,
};

const EXPERT_FINALIZED: SessionMoneyBlock = {
  lens: 'expert',
  state: 'finalized',
  sessionId: 'session_1',
  durationMinutes: 45,
  earningsAudMinor: 11_250,
  payoutStatus: 'recorded',
  finalizationPath: 'live_capture',
  actualMinutes: 45,
  billingFloorApplied: false,
  billingFloorMinutes: 0,
};

const CLIENT_PENDING: SessionMoneyBlock = {
  lens: 'client',
  state: 'pending',
  sessionId: 'session_1',
  durationMinutes: 0,
  amountAudMinor: 0,
  ratePerMinuteMinor: 333,
  settlementStatus: 'not_required',
  actualMinutes: 0,
  billingFloorApplied: false,
  billingFloorMinutes: 0,
};

const EXPERT_PENDING: SessionMoneyBlock = {
  lens: 'expert',
  state: 'pending',
  sessionId: 'session_1',
  durationMinutes: 0,
  earningsAudMinor: 0,
  actualMinutes: 0,
  billingFloorApplied: false,
  billingFloorMinutes: 0,
};

// ── BAL-412 (D13, plan §7.3) — the finalized duration line's four extra branches ──────────

const CLIENT_FLOOR_APPLIED: SessionMoneyBlock = {
  ...CLIENT_FINALIZED,
  durationMinutes: 15,
  amountAudMinor: 5_000,
  actualMinutes: 6,
  billingFloorApplied: true,
  billingFloorMinutes: 15,
  finalizationPath: 'presence',
  settlementShape: 'held',
};

const CLIENT_NO_SHOW: SessionMoneyBlock = {
  ...CLIENT_FINALIZED,
  durationMinutes: 15,
  amountAudMinor: 5_000,
  actualMinutes: 18,
  billingFloorApplied: false,
  billingFloorMinutes: 15,
  finalizationPath: 'presence',
  settlementShape: 'no_show_client',
};

const CLIENT_MISSED_CALL: SessionMoneyBlock = {
  ...CLIENT_FINALIZED,
  durationMinutes: 0,
  amountAudMinor: 0,
  actualMinutes: 0,
  billingFloorApplied: false,
  billingFloorMinutes: 15,
  finalizationPath: 'presence',
  settlementShape: 'missed_call',
};

const EXPERT_MISSED_CALL: SessionMoneyBlock = {
  ...EXPERT_FINALIZED,
  durationMinutes: 0,
  earningsAudMinor: 0,
  actualMinutes: 0,
  billingFloorApplied: false,
  billingFloorMinutes: 15,
  finalizationPath: 'presence',
  settlementShape: 'missed_call',
};

const CLIENT_ABANDONED_WAIT: SessionMoneyBlock = {
  ...CLIENT_FINALIZED,
  durationMinutes: 0,
  amountAudMinor: 0,
  actualMinutes: 8,
  billingFloorApplied: false,
  billingFloorMinutes: 15,
  finalizationPath: 'presence',
  settlementShape: 'abandoned_wait',
};

// ── UX review round 1, F8 — the missing EXPERT_* counterparts. Only CLIENT_* fixtures existed
// for these three shapes, which is exactly why the lens-leakage bug (client-coded "charged"/
// "billed" copy rendering on the expert's own earnings recap) went untested. ─────────────────

const EXPERT_FLOOR_APPLIED: SessionMoneyBlock = {
  ...EXPERT_FINALIZED,
  durationMinutes: 15,
  earningsAudMinor: 3_750,
  actualMinutes: 6,
  billingFloorApplied: true,
  billingFloorMinutes: 15,
  finalizationPath: 'presence',
  settlementShape: 'held',
};

const EXPERT_NO_SHOW: SessionMoneyBlock = {
  ...EXPERT_FINALIZED,
  durationMinutes: 15,
  earningsAudMinor: 3_750,
  actualMinutes: 18,
  billingFloorApplied: false,
  billingFloorMinutes: 15,
  finalizationPath: 'presence',
  settlementShape: 'no_show_client',
};

const EXPERT_ABANDONED_WAIT: SessionMoneyBlock = {
  ...EXPERT_FINALIZED,
  durationMinutes: 0,
  earningsAudMinor: 0,
  actualMinutes: 8,
  billingFloorApplied: false,
  billingFloorMinutes: 15,
  finalizationPath: 'presence',
  settlementShape: 'abandoned_wait',
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

  // ── BAL-412 (D13) — the finalized duration line ─────────────────────────────────────────

  it('renders a bare duration line when finalized with no floor and no settlement shape', () => {
    render(<MoneyBlock block={CLIENT_FINALIZED} />);
    expect(screen.getByText('45 min')).toBeInTheDocument();
  });

  it('renders the split "actual · billed at the floor" line when the floor bound (client)', () => {
    render(<MoneyBlock block={CLIENT_FLOOR_APPLIED} />);
    expect(screen.getByText('6 min · billed at the 15-minute minimum')).toBeInTheDocument();
    // The bare pre-floor number alone must not render — only the split.
    expect(screen.queryByText('6 min')).not.toBeInTheDocument();
  });

  // UX review round 1, F8 — the expert side must say "paid", never "billed"/"charged".
  it('renders the split "actual · paid the floor" line when the floor bound (expert)', () => {
    render(<MoneyBlock block={EXPERT_FLOOR_APPLIED} />);
    expect(screen.getByText('6 min · paid the 15-minute minimum')).toBeInTheDocument();
    expect(screen.queryByText(/billed/)).not.toBeInTheDocument();
  });

  // UX review round 1, F9 — must read `actualMinutes` (18), not `durationMinutes` (15), or the
  // real held time the expert waited is silently discarded.
  it('renders the no-show line keyed on shape, using actualMinutes not durationMinutes (client)', () => {
    render(<MoneyBlock block={CLIENT_NO_SHOW} />);
    expect(screen.getByText('18 min held · billed at the 15-minute minimum')).toBeInTheDocument();
    expect(screen.queryByText(/^15 min held/)).not.toBeInTheDocument();
  });

  // UX review round 1, F8 — expert lens for the same shape must say "paid", never "billed".
  it('renders the no-show line for the expert lens', () => {
    render(<MoneyBlock block={EXPERT_NO_SHOW} />);
    expect(screen.getByText('18 min held · paid the 15-minute minimum')).toBeInTheDocument();
    expect(screen.queryByText(/billed/)).not.toBeInTheDocument();
  });

  // UX review round 1, F11 — names the responsible party (the consultant), never neutral.
  it('renders the apologetic missed-call line for the client lens', () => {
    render(<MoneyBlock block={CLIENT_MISSED_CALL} />);
    expect(
      screen.getByText("Not charged — your consultant didn't join this time")
    ).toBeInTheDocument();
  });

  it('renders the distinct missed-call line for the expert lens', () => {
    render(<MoneyBlock block={EXPERT_MISSED_CALL} />);
    expect(
      screen.getByText("No earnings recorded — the call didn't take place")
    ).toBeInTheDocument();
  });

  it('renders "Not charged" for an abandoned wait, factually, never punitive (client)', () => {
    render(<MoneyBlock block={CLIENT_ABANDONED_WAIT} />);
    expect(screen.getByText('Not charged')).toBeInTheDocument();
  });

  // UX review round 1, F8 — expert lens must never see client-coded "charged" copy.
  it('renders "No earnings recorded" for an abandoned wait (expert)', () => {
    render(<MoneyBlock block={EXPERT_ABANDONED_WAIT} />);
    expect(screen.getByText('No earnings recorded')).toBeInTheDocument();
    expect(screen.queryByText(/charged/i)).not.toBeInTheDocument();
  });
});
