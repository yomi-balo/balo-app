import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { axe } from 'jest-axe';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@/test/utils';
import { CancelConsultationDialog } from './cancel-consultation-dialog';

const mockCancelAction = vi.fn();
vi.mock('@/app/(dashboard)/cases/[engagementId]/_actions/cancel-consultation', () => ({
  cancelConsultationAction: (...a: unknown[]) => mockCancelAction(...a),
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics', () => ({
  track: (...a: unknown[]) => mockTrack(...a),
  BOOKING_EVENTS: {
    CANCELLED: 'booking_cancelled',
    CANCEL_ABANDONED: 'booking_cancel_abandoned',
  },
}));

const mockCaptureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...a: unknown[]) => mockCaptureException(...a),
}));

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => mockToastSuccess(...a),
    error: (...a: unknown[]) => mockToastError(...a),
  },
}));

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';
const MEETING_ID = 'a0000000-0000-4000-8000-000000000002';
/** Two hours ahead of a frozen "now" — so `hours_before_start` is a stable `2`. */
const NOW = new Date('2026-09-01T08:00:00.000Z');
const START_ISO = '2026-09-01T10:00:00.000Z';

function props(over: Record<string, unknown> = {}) {
  return {
    open: true,
    onClose: vi.fn(),
    onCancelled: vi.fn(),
    lens: 'client' as const,
    engagementId: ENGAGEMENT_ID,
    meetingId: MEETING_ID,
    counterpartyLabel: 'CloudPeak',
    scheduledStartIso: START_ISO,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // ⚠ `shouldAdvanceTime: true` IS REQUIRED, not decoration. `hours_before_start` is computed
  // from the real clock, so the assertions need a frozen `now` — but `userEvent` awaits real
  // timers internally, and a fully-frozen clock deadlocks its `wait()` on the first click.
  // Auto-advancing keeps `Date.now()` anchored at NOW while letting those waits resolve.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  mockCancelAction.mockResolvedValue({
    success: true,
    scheduledStart: START_ISO,
    initiatedBy: 'client',
    holdReleased: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ── COPY ──────────────────────────────────────────────────────────────────────

describe('CancelConsultationDialog — copy', () => {
  it('⚠ the CLIENT body states plainly that it is FREE and the hold comes back', async () => {
    render(<CancelConsultationDialog {...props()} />);

    // The AC: "Confirm dialog states plainly that it's free and the hold is released."
    const body = await screen.findByText(/free to cancel any time before the start/i);
    expect(body).toHaveTextContent(/nothing is charged/i);
    expect(body).toHaveTextContent(/goes straight back to your balance/i);
    expect(body).toHaveTextContent(/CloudPeak/);
  });

  it('the CLIENT copy points at Reschedule as the alternative', async () => {
    render(<CancelConsultationDialog {...props()} />);

    expect(
      await screen.findByText(/Changed your mind about the time rather than the call/i)
    ).toBeInTheDocument();
  });

  it('the EXPERT body names the client company and points at Propose a new time', async () => {
    render(
      <CancelConsultationDialog
        {...props({ lens: 'expert', counterpartyLabel: 'Northwind Industrial' })}
      />
    );

    const body = await screen.findByText(/Northwind Industrial will be told/i);
    expect(body).toHaveTextContent(/Nothing is charged either way/i);
    expect(body).toHaveTextContent(/propose a new time instead of cancelling/i);
  });

  /**
   * ⚠⚠ N1 — DO NOT NAME AN ACTION THE READER CANNOT FIND. `case-nudge.tsx` hides BOTH move
   * actions once `nudge.live` turns true (15 minutes before the start), while Cancel itself
   * deliberately stays available ("free until scheduled start"). So inside that window the
   * alternative sentence must drop on both lenses — and the FREE promise must NOT.
   */
  it('⚠ the CLIENT lens drops "Reschedule instead" inside the join window', async () => {
    render(<CancelConsultationDialog {...props({ live: true })} />);
    await screen.findByRole('alertdialog');

    expect(
      screen.queryByText(/Changed your mind about the time rather than the call/i)
    ).not.toBeInTheDocument();
    // The promise the whole dialog exists to make is unconditional.
    expect(screen.getByText(/It's free to cancel any time before the start/i)).toBeInTheDocument();
  });

  it('⚠ the EXPERT lens drops "propose a new time" inside the join window', async () => {
    render(
      <CancelConsultationDialog
        {...props({ lens: 'expert', counterpartyLabel: 'Northwind Industrial', live: true })}
      />
    );

    const body = await screen.findByText(/Northwind Industrial will be told/i);
    expect(body).toHaveTextContent(/Nothing is charged either way/i);
    expect(body).not.toHaveTextContent(/propose a new time instead of cancelling/i);
  });

  it.each(['client', 'expert'] as const)('the %s lens uses no gendered pronouns', async (lens) => {
    const { container } = render(<CancelConsultationDialog {...props({ lens })} />);
    await screen.findByRole('alertdialog');

    expect(container.textContent ?? '').not.toMatch(/\b(he|she|him|her|his|hers)\b/i);
  });

  it('labels the dismiss in the user’s own words, not "Cancel"', async () => {
    render(<CancelConsultationDialog {...props()} />);

    // ⚠ "Cancel" as a DISMISS label beside "Cancel consultation" as a CONFIRM is the classic
    // destructive-dialog ambiguity. "Keep it" cannot be misread.
    expect(await screen.findByRole('button', { name: 'Keep it' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel consultation' })).toBeInTheDocument();
  });
});

// ── LOADING ───────────────────────────────────────────────────────────────────

describe('CancelConsultationDialog — the loading state', () => {
  it('disables both buttons and swaps the confirm label while submitting', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let resolveAction: (value: unknown) => void = () => {};
    mockCancelAction.mockReturnValue(
      new Promise((resolve) => {
        resolveAction = resolve;
      })
    );

    render(<CancelConsultationDialog {...props()} />);
    await user.click(await screen.findByRole('button', { name: 'Cancel consultation' }));

    const submitting = await screen.findByRole('button', { name: 'Cancelling…' });
    expect(submitting).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Keep it' })).toBeDisabled();

    resolveAction({
      success: true,
      scheduledStart: START_ISO,
      initiatedBy: 'client',
      holdReleased: false,
    });
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalled();
    });
  });

  it('a second click while in flight does not fire a second call', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mockCancelAction.mockReturnValue(new Promise(() => {}));

    render(<CancelConsultationDialog {...props()} />);
    const confirm = await screen.findByRole('button', { name: 'Cancel consultation' });
    await user.click(confirm);
    await user.click(screen.getByRole('button', { name: 'Cancelling…' }));

    expect(mockCancelAction).toHaveBeenCalledTimes(1);
  });
});

// ── SUCCESS ───────────────────────────────────────────────────────────────────

describe('CancelConsultationDialog — success', () => {
  it('toasts, notifies the caller, and reports nothing was charged', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onCancelled = vi.fn();

    render(<CancelConsultationDialog {...props({ onCancelled })} />);
    await user.click(await screen.findByRole('button', { name: 'Cancel consultation' }));

    await waitFor(() => {
      expect(onCancelled).toHaveBeenCalledTimes(1);
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Consultation cancelled', {
      description: 'Nothing was charged.',
    });
  });

  /**
   * ⚠ `initiated_by` COMES FROM THE ACTION'S RESPONSE — the API's own arm — and is NEVER
   * re-derived from `lens`. The `admin` case proves it: the dialog is mounted with
   * `lens: 'client'` and still reports `'admin'`.
   */
  it('fires booking_cancelled ONCE, with the API’s arm and the notice given', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mockCancelAction.mockResolvedValue({
      success: true,
      scheduledStart: START_ISO,
      initiatedBy: 'admin',
      holdReleased: true,
    });

    render(<CancelConsultationDialog {...props({ lens: 'client' })} />);
    await user.click(await screen.findByRole('button', { name: 'Cancel consultation' }));

    await waitFor(() => {
      expect(mockTrack).toHaveBeenCalledWith('booking_cancelled', {
        initiated_by: 'admin',
        // ⚠ Computed from the EXISTING start, and the SIGN is load-bearing for the v2 cutoff.
        hours_before_start: 2,
      });
    });
    expect(mockTrack.mock.calls.filter(([event]) => event === 'booking_cancelled')).toHaveLength(1);
  });

  it('⚠ reports a NEGATIVE hours_before_start for a past-start, never-joined meeting', async () => {
    // Not bad data: the server's guard reads no clock, so such a meeting is still cancellable.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(
      <CancelConsultationDialog {...props({ scheduledStartIso: '2026-09-01T05:00:00.000Z' })} />
    );
    await user.click(await screen.findByRole('button', { name: 'Cancel consultation' }));

    await waitFor(() => {
      expect(mockTrack).toHaveBeenCalledWith(
        'booking_cancelled',
        expect.objectContaining({ hours_before_start: -3 })
      );
    });
  });
});

// ── ERROR ─────────────────────────────────────────────────────────────────────

describe('CancelConsultationDialog — failure codes', () => {
  const NON_TERMINAL = [
    ['rate_limited', 'Too many changes just now — try again shortly.'],
    ['unknown', 'Something went wrong. Please try again.'],
  ] as const;

  const TERMINAL = [
    ['meeting_not_cancellable', /already started or was already cancelled/i],
    ['meeting_not_found', /couldn't find that consultation/i],
    ['not_permitted', /don't have permission/i],
    ['unauthenticated', /not signed in/i],
    ['invalid_request', /wasn't valid/i],
  ] as const;

  it.each(NON_TERMINAL)('%s toasts its copy and leaves the dialog open', async (code, message) => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onClose = vi.fn();
    const onTerminalFailure = vi.fn();
    mockCancelAction.mockResolvedValue({ success: false, code, error: 'server literal' });

    render(<CancelConsultationDialog {...props({ onClose, onTerminalFailure })} />);
    await user.click(await screen.findByRole('button', { name: 'Cancel consultation' }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(message);
    });
    expect(onTerminalFailure).not.toHaveBeenCalled();
    // ⚠ NEVER echoes the server's own literal.
    expect(mockToastError).not.toHaveBeenCalledWith('server literal');
  });

  /**
   * ⚠⚠ TERMINAL FAILURES MUST CLOSE **AND REFRESH**, for a sharper reason than in reschedule:
   * `caseConsultationIsUpcoming` excludes `'cancelled'`, so the `'upcoming'` nudge that mounts
   * this dialog is about to disappear. Leaving it open attaches a dialog to a node that is
   * unmounting, and leaves a CTA that would fail again with the identical error.
   */
  it.each(TERMINAL)('%s closes via onTerminalFailure', async (code, pattern) => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onClose = vi.fn();
    const onTerminalFailure = vi.fn();
    mockCancelAction.mockResolvedValue({ success: false, code, error: 'server literal' });

    render(<CancelConsultationDialog {...props({ onClose, onTerminalFailure })} />);
    await user.click(await screen.findByRole('button', { name: 'Cancel consultation' }));

    await waitFor(() => {
      expect(onTerminalFailure).toHaveBeenCalledTimes(1);
    });
    expect(mockToastError).toHaveBeenCalledWith(expect.stringMatching(pattern));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('falls back to onClose when onTerminalFailure is not supplied', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onClose = vi.fn();
    mockCancelAction.mockResolvedValue({ success: false, code: 'meeting_not_found', error: 'x' });

    render(<CancelConsultationDialog {...props({ onClose })} />);
    await user.click(await screen.findByRole('button', { name: 'Cancel consultation' }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('captures ONLY `unknown` to Sentry — a mapped refusal is not an exception', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mockCancelAction.mockResolvedValue({ success: false, code: 'rate_limited', error: 'x' });

    const { unmount } = render(<CancelConsultationDialog {...props()} />);
    await user.click(await screen.findByRole('button', { name: 'Cancel consultation' }));
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled();
    });
    expect(mockCaptureException).not.toHaveBeenCalled();
    unmount();

    mockCancelAction.mockResolvedValue({ success: false, code: 'unknown', error: 'x' });
    render(<CancelConsultationDialog {...props()} />);
    await user.click(await screen.findByRole('button', { name: 'Cancel consultation' }));
    await waitFor(() => {
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
    });
  });
});

// ── ABANDON — the per-decision latch ──────────────────────────────────────────

describe('CancelConsultationDialog — booking_cancel_abandoned', () => {
  function abandons(): number {
    return mockTrack.mock.calls.filter(([event]) => event === 'booking_cancel_abandoned').length;
  }

  it('does NOT fire on a dialog that was never opened', () => {
    render(<CancelConsultationDialog {...props({ open: false })} />);

    expect(abandons()).toBe(0);
  });

  it('fires EXACTLY ONCE on an open → close cycle with no confirm', () => {
    const { rerender } = render(<CancelConsultationDialog {...props({ open: true })} />);
    rerender(<CancelConsultationDialog {...props({ open: false })} />);

    expect(abandons()).toBe(1);
  });

  /**
   * ⚠⚠ N2 — THE TWO **REAL** DISMISS PATHS, EXERCISED AS GESTURES RATHER THAN ASSUMED. A Radix
   * `AlertDialog` cannot be dismissed by an overlay click (`onInteractOutside` is hardcoded to
   * `preventDefault`) and renders no X button, so ESC and "Keep it" are the ONLY two — and the
   * rest of this suite drives `open` from the parent, which would stay green even if neither
   * gesture reached `onClose`. These pin the real chain: gesture → `onOpenChange(false)` →
   * `onClose()` → the parent closes → exactly one abandon.
   */
  it.each([
    [
      'the "Keep it" button',
      async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(await screen.findByRole('button', { name: 'Keep it' }));
      },
    ],
    [
      'the ESC key',
      async (user: ReturnType<typeof userEvent.setup>) => {
        await screen.findByRole('alertdialog');
        await user.keyboard('{Escape}');
      },
    ],
  ])('%s dismisses through onClose and reports ONE abandon', async (_label, dismiss) => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onClose = vi.fn();
    const { rerender } = render(<CancelConsultationDialog {...props({ open: true, onClose })} />);

    await dismiss(user);

    expect(onClose).toHaveBeenCalledTimes(1);
    // The parent owns `open`; mirror what it does in response.
    rerender(<CancelConsultationDialog {...props({ open: false, onClose })} />);
    expect(abandons()).toBe(1);
    expect(mockCancelAction).not.toHaveBeenCalled();
  });

  /** ⚠ Per DECISION, not per render — a re-render of a closed dialog must add nothing. */
  it('does not fire again on a re-render while still closed', () => {
    const { rerender } = render(<CancelConsultationDialog {...props({ open: true })} />);
    rerender(<CancelConsultationDialog {...props({ open: false })} />);
    rerender(<CancelConsultationDialog {...props({ open: false })} />);

    expect(abandons()).toBe(1);
  });

  it('fires once per open → close CYCLE, twice over two cycles', () => {
    const { rerender } = render(<CancelConsultationDialog {...props({ open: true })} />);
    rerender(<CancelConsultationDialog {...props({ open: false })} />);
    rerender(<CancelConsultationDialog {...props({ open: true })} />);
    rerender(<CancelConsultationDialog {...props({ open: false })} />);

    expect(abandons()).toBe(2);
  });

  it('does NOT fire when the opening ended in a successful cancel', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { rerender } = render(<CancelConsultationDialog {...props({ open: true })} />);

    await user.click(await screen.findByRole('button', { name: 'Cancel consultation' }));
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalled();
    });
    rerender(<CancelConsultationDialog {...props({ open: false })} />);

    expect(abandons()).toBe(0);
  });

  it('does NOT fire when the opening ended in a TERMINAL refusal', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mockCancelAction.mockResolvedValue({
      success: false,
      code: 'meeting_not_cancellable',
      error: 'x',
    });
    const { rerender } = render(<CancelConsultationDialog {...props({ open: true })} />);

    await user.click(await screen.findByRole('button', { name: 'Cancel consultation' }));
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled();
    });
    rerender(<CancelConsultationDialog {...props({ open: false })} />);

    // The decision WAS resolved — the meeting is already gone. Reporting it as an abandon
    // would inflate the "backed out" arm of the funnel with server refusals.
    expect(abandons()).toBe(0);
  });
});

// ── A11Y ──────────────────────────────────────────────────────────────────────

describe('CancelConsultationDialog — accessibility', () => {
  it('has no axe violations while open', async () => {
    const { baseElement } = render(<CancelConsultationDialog {...props()} />);
    await screen.findByRole('alertdialog');

    expect(await axe(baseElement)).toHaveNoViolations();
  });
});
