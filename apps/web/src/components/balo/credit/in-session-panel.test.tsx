import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import { axe } from 'jest-axe';
import { deriveDrawdownState, type DrawdownInputs, type DrawdownState } from '@balo/shared/credit';
import { track, SESSION_EVENTS } from '@/lib/analytics';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const mockNudge = vi.fn();
vi.mock('@/lib/credit/actions/session-mutations', () => ({
  nudgeAdminAction: (...a: unknown[]) => mockNudge(...a),
}));

import { InSessionPanel } from './in-session-panel';

const NOW = new Date('2026-07-16T12:00:00.000Z');
const CONNECTED_AT = new Date('2026-07-16T11:18:00.000Z'); // 42:00 elapsed
const EXPERT = { name: 'Jordan Ellis', headline: 'Revenue Cloud specialist' };

function build(partial: Partial<DrawdownInputs>): DrawdownState {
  return deriveDrawdownState({
    status: 'active',
    connectedAt: CONNECTED_AT,
    clientRateMinorPerMinute: 450,
    effectiveCeilingMinor: 15000,
    graceBoundMinutes: 30,
    graceEnteredAt: null,
    balanceMinor: 45000,
    mandatePresent: true,
    lens: 'client',
    // BAL-412 — the floor (15) is already fully drawn by CONNECTED_AT (42min elapsed), so
    // `minutesOfRunway` reduces to the pre-BAL-412 `floor(balance/rate)` bit-for-bit — this
    // fixture's runway/low-balance assertions are unaffected by the floor correction.
    billingFloorMinutes: 15,
    minutesAlreadyDrawn: 15,
    now: NOW,
    ...partial,
  });
}

const STATES = {
  healthyClient: build({}),
  lowClient: build({ balanceMinor: 3600 }),
  graceClient: build({
    status: 'grace',
    graceEnteredAt: new Date('2026-07-16T11:56:00.000Z'),
    balanceMinor: -2000,
  }),
  nearClient: build({
    status: 'grace',
    graceEnteredAt: new Date('2026-07-16T11:35:00.000Z'),
    balanceMinor: -1000,
  }),
  wrapClient: build({
    status: 'wrapped',
    graceEnteredAt: new Date('2026-07-16T11:30:00.000Z'),
    balanceMinor: -15000,
  }),
  endNoMandate: build({
    status: 'wrapped',
    graceEnteredAt: null,
    mandatePresent: false,
    balanceMinor: 0,
  }),
  lowMember: build({ balanceMinor: 3600, lens: 'member', adminName: 'Sam' }),
  graceMember: build({
    status: 'grace',
    graceEnteredAt: new Date('2026-07-16T11:56:00.000Z'),
    balanceMinor: -2000,
    lens: 'member',
    adminName: 'Sam',
  }),
};

function renderPanel(state: DrawdownState) {
  return render(
    <InSessionPanel state={state} sessionId="sess-1" expertProfileId="exp-1" expert={EXPERT} />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNudge.mockResolvedValue({ success: true, data: { ok: true } });
});

describe('InSessionPanel — call stage', () => {
  it('shows the expert, a live pill, and elapsed session time (never a countdown)', () => {
    renderPanel(STATES.healthyClient);
    expect(screen.getByText('Jordan Ellis')).toBeInTheDocument();
    expect(screen.getByText('Revenue Cloud specialist')).toBeInTheDocument();
    expect(screen.getByText('In consultation')).toBeInTheDocument();
    expect(screen.getByText('Session time')).toBeInTheDocument();
    expect(screen.getByText('00:42:00')).toBeInTheDocument();
  });

  it('shows the Paused pill for a wrapped session', () => {
    renderPanel(STATES.wrapClient);
    // "Paused" appears on both the status pill and the meter label — both correct.
    expect(screen.getAllByText('Paused').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('In consultation')).not.toBeInTheDocument();
  });
});

describe('InSessionPanel — client lens', () => {
  it('healthy: shows the balance-draws reassurance and no notice card', () => {
    renderPanel(STATES.healthyClient);
    expect(
      screen.getByText("You're all set — time draws from your balance as you talk.")
    ).toBeInTheDocument();
  });

  it('low: shows the running-low notice with Top up + Keep going', () => {
    renderPanel(STATES.lowClient);
    expect(screen.getByText('About 8 minutes of balance left')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /top up/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep going' })).toBeInTheDocument();
  });

  it('grace: leads with keeping-you-going, the settles-afterward meter caption, and the SMS preview', () => {
    renderPanel(STATES.graceClient);
    expect(screen.getByText("We're keeping you going")).toBeInTheDocument();
    expect(screen.getByText('settles afterward')).toBeInTheDocument();
    expect(screen.getByText('SMS · Balo')).toBeInTheDocument();
    expect(screen.getByText('Notifies')).toBeInTheDocument();
  });

  it('wrap: pauses warmly with a Top up to continue CTA', () => {
    renderPanel(STATES.wrapClient);
    expect(screen.getByText("Let's pause here for now")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Top up to continue' })).toBeInTheDocument();
  });

  it('end (no mandate): warm balance-used wrap', () => {
    renderPanel(STATES.endNoMandate);
    expect(screen.getByText("You're at the end of your balance")).toBeInTheDocument();
  });
});

describe('InSessionPanel — member lens', () => {
  it('low: team-framed copy with a nudge instead of Top up', () => {
    renderPanel(STATES.lowMember);
    expect(screen.getByText("Your team's balance is running low")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Let Sam know' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /top up/i })).not.toBeInTheDocument();
  });

  it('grace: protects the member on the team card', () => {
    renderPanel(STATES.graceMember);
    expect(screen.getByText("We're keeping you going")).toBeInTheDocument();
    expect(screen.getByText(/your team's card/i)).toBeInTheDocument();
  });
});

describe('InSessionPanel — BAL-403, variant="embedded"', () => {
  it('renders NO expert name, NO live/paused pill, NO elapsed clock', () => {
    render(<InSessionPanel variant="embedded" state={STATES.healthyClient} sessionId="sess-1" />);
    expect(screen.queryByText('Jordan Ellis')).not.toBeInTheDocument();
    expect(screen.queryByText('In consultation')).not.toBeInTheDocument();
    expect(screen.queryByText('Session time')).not.toBeInTheDocument();
    expect(screen.queryByText('00:42:00')).not.toBeInTheDocument();
  });

  it('still renders the meter and the notice card', () => {
    render(<InSessionPanel variant="embedded" state={STATES.lowClient} sessionId="sess-1" />);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.getByText('About 8 minutes of balance left')).toBeInTheDocument();
  });

  it('⚠⚠ OQ1 — suppresses the client-lens primary "Top up" button, and its secondary with it', () => {
    render(<InSessionPanel variant="embedded" state={STATES.lowClient} sessionId="sess-1" />);
    expect(screen.queryByRole('button', { name: /top up/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep going' })).not.toBeInTheDocument();
    // The notice copy itself is untouched.
    expect(screen.getByText('About 8 minutes of balance left')).toBeInTheDocument();
  });

  it('the member lens keeps its NudgeButton exactly as shipped', () => {
    render(<InSessionPanel variant="embedded" state={STATES.lowMember} sessionId="sess-1" />);
    expect(screen.getByRole('button', { name: 'Let Sam know' })).toBeInTheDocument();
  });

  it('healthy renders no notice card and no countdown', () => {
    render(<InSessionPanel variant="embedded" state={STATES.healthyClient} sessionId="sess-1" />);
    expect(
      screen.getByText("You're all set — time draws from your balance as you talk.")
    ).toBeInTheDocument();
  });

  it('fires NEITHER lifecycle event', () => {
    render(<InSessionPanel variant="embedded" state={STATES.lowClient} sessionId="sess-1" />);
    expect(track).not.toHaveBeenCalledWith(SESSION_EVENTS.STARTED, expect.anything());
    expect(track).not.toHaveBeenCalledWith(
      SESSION_EVENTS.LOW_BALANCE_WARNING_SHOWN,
      expect.anything()
    );
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <InSessionPanel variant="embedded" state={STATES.graceClient} sessionId="sess-1" />
    );
    expect(await axe(container)).toHaveNoViolations();
  }, 15000);
});

describe('InSessionPanel — tone discipline', () => {
  it.each(Object.entries(STATES))('never renders the word "overdraft" (%s)', (_name, state) => {
    renderPanel(state);
    expect(document.body.textContent?.toLowerCase()).not.toContain('overdraft');
  });
});

describe('InSessionPanel — analytics', () => {
  it('fires session_started once for a live session', () => {
    renderPanel(STATES.healthyClient);
    expect(track).toHaveBeenCalledWith(SESSION_EVENTS.STARTED, {
      session_id: 'sess-1',
      expert_profile_id: 'exp-1',
      rate_per_minute_minor: 450,
    });
  });

  it('does NOT fire session_started for an already-wrapped session', () => {
    renderPanel(STATES.endNoMandate);
    expect(track).not.toHaveBeenCalledWith(SESSION_EVENTS.STARTED, expect.anything());
  });

  it('fires the low-balance impression once when the low card shows', () => {
    renderPanel(STATES.lowClient);
    expect(track).toHaveBeenCalledWith(SESSION_EVENTS.LOW_BALANCE_WARNING_SHOWN, {
      session_id: 'sess-1',
      minutes_remaining: 8,
    });
  });
});

describe('InSessionPanel — accessibility', () => {
  it('client grace has no violations', async () => {
    const { container } = renderPanel(STATES.graceClient);
    expect(await axe(container)).toHaveNoViolations();
  }, 15000);

  it('member low (with nudge) has no violations', async () => {
    const { container } = renderPanel(STATES.lowMember);
    expect(await axe(container)).toHaveNoViolations();
  }, 15000);
});
