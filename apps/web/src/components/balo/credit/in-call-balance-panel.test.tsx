import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { deriveDrawdownState, type DrawdownInputs, type DrawdownState } from '@balo/shared/credit';
import { track, SESSION_EVENTS } from '@/lib/analytics';

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const mockNudge = vi.fn();
vi.mock('@/lib/credit/actions/session-mutations', () => ({
  nudgeAdminAction: (...a: unknown[]) => mockNudge(...a),
}));

import { InCallBalancePanel } from './in-call-balance-panel';

const NOW = new Date('2026-07-16T12:00:00.000Z');
const CONNECTED_AT = new Date('2026-07-16T11:18:00.000Z');

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

const STATES: Record<string, DrawdownState> = {
  healthy: build({}),
  low: build({ balanceMinor: 3600 }),
  grace: build({
    status: 'grace',
    graceEnteredAt: new Date('2026-07-16T11:56:00.000Z'),
    balanceMinor: -2000,
  }),
  near: build({
    status: 'grace',
    graceEnteredAt: new Date('2026-07-16T11:35:00.000Z'),
    balanceMinor: -1000,
  }),
  wrap: build({
    status: 'wrapped',
    graceEnteredAt: new Date('2026-07-16T11:30:00.000Z'),
    balanceMinor: -15000,
  }),
  end: build({
    status: 'wrapped',
    graceEnteredAt: null,
    mandatePresent: false,
    balanceMinor: 0,
  }),
};

const MEMBER_LOW = build({ balanceMinor: 3600, lens: 'member', adminName: 'Sam' });

beforeEach(() => {
  vi.clearAllMocks();
  mockNudge.mockResolvedValue({ success: true, data: { ok: true } });
});

function renderPanel(
  state: DrawdownState | null,
  overrides: Partial<{
    status: 'idle' | 'loading' | 'ready' | 'error';
    sessionId: string | null;
    onRetry: () => void;
    autoOpened: boolean;
  }> = {}
) {
  return render(
    <InCallBalancePanel
      state={state}
      sessionId={overrides.sessionId ?? (state === null ? null : 'sess-1')}
      status={overrides.status ?? 'ready'}
      onClose={vi.fn()}
      onRetry={overrides.onRetry ?? vi.fn()}
      autoOpened={overrides.autoOpened ?? false}
    />
  );
}

describe('InCallBalancePanel — renders for every key', () => {
  it.each(Object.entries(STATES))('renders the meter for %s', (name, state) => {
    // ⚠⚠ S5 — GUARDS THE FIXTURE ITSELF. Without this, a mis-built `STATES` entry (e.g. the
    // wrong `balanceMinor` for its label) silently collapses distinct cases into fewer real keys
    // and every assertion below still passes, having tested less than it claims to.
    expect(state.key).toBe(name);
    renderPanel(state);
    // The `SessionMeter` progressbar is always present once data has loaded.
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('healthy renders NO notice card and no countdown', () => {
    renderPanel(STATES.healthy ?? null);
    expect(
      screen.getByText("You're all set — time draws from your balance as you talk.")
    ).toBeInTheDocument();
    // No title/body copy from a notice card.
    expect(screen.queryByRole('button', { name: /top up/i })).not.toBeInTheDocument();
  });
});

describe('InCallBalancePanel — loading and error states', () => {
  it('shows a loading skeleton before the first poll resolves', () => {
    renderPanel(null, { status: 'loading', sessionId: null });
    expect(screen.getByTestId('balance-panel-skeleton')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('shows an error card when the poll never got a first answer', () => {
    renderPanel(null, { status: 'error', sessionId: null });
    expect(screen.getByTestId('panel-error')).toBeInTheDocument();
  });

  it('⚠⚠ C2 — the "Try again" button calls onRetry, and the copy no longer claims closing helps', async () => {
    const onRetry = vi.fn();
    renderPanel(null, { status: 'error', sessionId: null, onRetry });

    expect(screen.queryByText(/close this and reopen/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows a degraded footnote (not a toast) when a last-known state survives a failure', () => {
    renderPanel(STATES.low ?? null, { status: 'error' });
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.getByText(/showing the last balance we had/i)).toBeInTheDocument();
  });

  it('⚠⚠ R4 — the degraded footnote carries a working "Try again", the failure-cap arm C2 missed', async () => {
    const onRetry = vi.fn();
    renderPanel(STATES.low ?? null, { status: 'error', onRetry });

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('⚠⚠ R2 — a denial / vanished session (state null, status ready) is a TERMINAL card, never an eternal skeleton', () => {
    renderPanel(null, { status: 'ready', sessionId: null });

    expect(screen.queryByTestId('balance-panel-skeleton')).not.toBeInTheDocument();
    expect(screen.queryByTestId('panel-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('balance-panel-unavailable')).toBeInTheDocument();
    expect(screen.getByText("This call isn't drawing from a balance")).toBeInTheDocument();
    // ⚠ NO retry here — the poll already stopped correctly; there is nothing more to fetch.
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});

describe('InCallBalancePanel — the client lens suppresses the primary CTA (OQ1)', () => {
  it('renders the notice body but no top-up button for low', () => {
    renderPanel(STATES.low ?? null);
    expect(screen.getByText('About 8 minutes of balance left')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /top up/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep going' })).not.toBeInTheDocument();
  });

  it('renders the notice body but no top-up button for wrap', () => {
    renderPanel(STATES.wrap ?? null);
    expect(screen.getByText("Let's pause here for now")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /top up/i })).not.toBeInTheDocument();
  });
});

describe('InCallBalancePanel — the member lens keeps its NudgeButton unchanged', () => {
  it('renders the nudge CTA, team-framed', () => {
    renderPanel(MEMBER_LOW);
    expect(screen.getByText("Your team's balance is running low")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Let Sam know' })).toBeInTheDocument();
  });
});

describe('InCallBalancePanel — tone discipline', () => {
  it.each(Object.entries(STATES))(
    'never renders the word "overdraft" (%s, client)',
    (_name, state) => {
      renderPanel(state);
      expect(document.body.textContent?.toLowerCase()).not.toContain('overdraft');
    }
  );

  it('never renders "overdraft" for the member lens either', () => {
    renderPanel(MEMBER_LOW);
    expect(document.body.textContent?.toLowerCase()).not.toContain('overdraft');
  });
});

describe('InCallBalancePanel — analytics', () => {
  it('fires in_session_panel_viewed exactly once per mount', () => {
    const { rerender } = renderPanel(STATES.healthy ?? null);
    expect(track).toHaveBeenCalledWith(SESSION_EVENTS.IN_SESSION_PANEL_VIEWED, {
      session_id: 'sess-1',
      lens: 'client',
      state: 'healthy',
    });
    expect(track).toHaveBeenCalledTimes(1);

    // A state change WITHIN the same mount must not fire it again.
    rerender(
      <InCallBalancePanel
        state={STATES.low ?? null}
        sessionId="sess-1"
        status="ready"
        onClose={vi.fn()}
        onRetry={vi.fn()}
        autoOpened={false}
      />
    );
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('fires it AGAIN on a re-mount (close then reopen)', () => {
    const { unmount } = renderPanel(STATES.healthy ?? null);
    unmount();
    vi.clearAllMocks();

    renderPanel(STATES.healthy ?? null);
    expect(track).toHaveBeenCalledWith(SESSION_EVENTS.IN_SESSION_PANEL_VIEWED, {
      session_id: 'sess-1',
      lens: 'client',
      state: 'healthy',
    });
  });

  it('does NOT fire before the first successful poll (loading)', () => {
    renderPanel(null, { status: 'loading', sessionId: null });
    expect(track).not.toHaveBeenCalledWith(
      SESSION_EVENTS.IN_SESSION_PANEL_VIEWED,
      expect.anything()
    );
  });

  it('does NOT fire session_started or low_balance_warning_shown', () => {
    renderPanel(STATES.low ?? null);
    // ⚠ BAL-466 (D7) — `session_started` is now a SERVER event with no client producer at all,
    // so it is asserted by its raw wire string rather than a (now nonexistent) client constant.
    expect(track).not.toHaveBeenCalledWith('session_started', expect.anything());
    expect(track).not.toHaveBeenCalledWith(
      SESSION_EVENTS.LOW_BALANCE_WARNING_SHOWN,
      expect.anything()
    );
  });
});

describe('InCallBalancePanel — accessibility', () => {
  it('has no violations, client grace', async () => {
    const { container } = renderPanel(STATES.grace ?? null);
    expect(await axe(container)).toHaveNoViolations();
  }, 15000);

  // The three no-state arms differ only by `status`, but each renders a DIFFERENT card, so axe
  // has to run once per arm rather than once for `state === null`:
  //   loading → the skeleton · error → PanelErrorCard · ready → BalanceUnavailableCard.
  // ⚠⚠ The `ready` row is R2's denied/vanished arm — the one that used to render an empty
  // landmark. Do not collapse this table to a single case.
  it.each([
    { status: 'loading', arm: 'first-load skeleton' },
    { status: 'error', arm: 'error card, no last-known state' },
    { status: 'ready', arm: 'R2 denied/vanished — BalanceUnavailableCard' },
  ] as const)(
    'has no violations with no state ($arm)',
    async ({ status }) => {
      const { container } = renderPanel(null, { status, sessionId: null });
      expect(await axe(container)).toHaveNoViolations();
    },
    15000
  );
});
