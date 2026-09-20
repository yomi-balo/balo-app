import { useRef, useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { axe } from 'jest-axe';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within } from '@/test/utils';
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
    onMoveInstead: vi.fn(),
    lens: 'client' as const,
    engagementId: ENGAGEMENT_ID,
    meetingId: MEETING_ID,
    counterpartyLabel: 'CloudPeak',
    counterpartyFirstName: 'Sandy',
    scheduledStartIso: START_ISO,
    ordinal: 2,
    scheduledMinutes: 30,
    source: 'nudge' as const,
    // The common case; tests that need a different shape override explicitly.
    canReschedule: true,
    canProposeReschedule: false,
    isPendingReschedule: false,
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
  it('⚠ the CLIENT body, with a move available, leads with the alternative then the facts', async () => {
    render(<CancelConsultationDialog {...props()} />);

    const lead = await screen.findByText(/you can move this consultation/i);
    expect(lead).toHaveTextContent("If it's the time that doesn't work");
    expect(lead).toHaveTextContent("CloudPeak's open times");
    expect(
      screen.getByText(
        /If you do cancel, nothing is charged and any credit held for the call goes back to your balance\./
      )
    ).toBeInTheDocument();
  });

  it('the EXPERT body, with a move available, leads with proposing then the facts', async () => {
    render(
      <CancelConsultationDialog
        {...props({
          lens: 'expert',
          counterpartyLabel: 'Northwind Industrial',
          canReschedule: false,
          canProposeReschedule: true,
        })}
      />
    );

    const lead = await screen.findByText(/propose one instead/i);
    expect(lead).toHaveTextContent('Northwind Industrial picks a new time, or keeps this one.');
    expect(
      screen.getByText(
        /If you do cancel, Northwind Industrial is told and the slot reopens on your calendar\. Nothing is charged either way\./
      )
    ).toBeInTheDocument();
  });

  it('⚠ drops the lead and switches to "If you cancel" when no move is possible and nothing is pending', async () => {
    render(
      <CancelConsultationDialog {...props({ canReschedule: false, canProposeReschedule: false })} />
    );
    await screen.findByRole('alertdialog');

    expect(screen.queryByText(/you can move this consultation/i)).not.toBeInTheDocument();
    // The promise the whole dialog exists to make is unconditional.
    expect(
      screen.getByText(
        /^If you cancel, nothing is charged and any credit held for the call goes back to your balance\.$/
      )
    ).toBeInTheDocument();
  });

  it('the CLIENT lens on a pending_reschedule row references the proposal by the counterparty’s first name', async () => {
    render(
      <CancelConsultationDialog
        {...props({
          canReschedule: false,
          canProposeReschedule: false,
          isPendingReschedule: true,
          counterpartyFirstName: 'Sandy',
        })}
      />
    );

    expect(
      await screen.findByText(
        'Sandy has suggested some new times above — picking one of those keeps the call.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/^If you do cancel, nothing is charged/)).toBeInTheDocument();
  });

  it('the EXPERT lens on a pending_reschedule row says cancelling withdraws the suggested times, unattributed', async () => {
    render(
      <CancelConsultationDialog
        {...props({
          lens: 'expert',
          counterpartyLabel: 'Northwind Industrial',
          canReschedule: false,
          canProposeReschedule: false,
          isPendingReschedule: true,
        })}
      />
    );

    expect(
      await screen.findByText('Cancelling also withdraws the suggested times.')
    ).toBeInTheDocument();
    expect(screen.getByText(/^If you do cancel, Northwind Industrial is told/)).toBeInTheDocument();
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

// ── Button hierarchy / layout ────────────────────────────────────────────────

function classTokens(element: HTMLElement): string[] {
  return element.className.split(/\s+/).filter(Boolean);
}

describe('CancelConsultationDialog — the button hierarchy and footer layout', () => {
  it('⚠ orders the footer Cancel consultation → Keep it → Reschedule instead, destructive FIRST', async () => {
    render(<CancelConsultationDialog {...props()} />);
    const dialog = await screen.findByRole('alertdialog');

    const labels = within(dialog)
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(labels).toEqual(['Cancel consultation', 'Keep it', 'Reschedule instead']);
  });

  it('gives Cancel consultation a ghost, destructive-text treatment — NOT the solid primary', async () => {
    render(<CancelConsultationDialog {...props()} />);
    const tokens = classTokens(await screen.findByRole('button', { name: 'Cancel consultation' }));
    expect(tokens).toContain('text-destructive');
    expect(tokens).toContain('bg-transparent');
    expect(tokens).not.toContain('bg-primary');
  });

  it('trims the destructive button with the wide-width optical margin', async () => {
    render(<CancelConsultationDialog {...props()} />);
    const tokens = classTokens(await screen.findByRole('button', { name: 'Cancel consultation' }));
    expect(tokens).toContain('sm:-ml-3.5');
  });

  it('keeps Keep it outline, unchanged', async () => {
    render(<CancelConsultationDialog {...props()} />);
    const tokens = classTokens(await screen.findByRole('button', { name: 'Keep it' }));
    expect(tokens).toContain('bg-background');
    expect(tokens).not.toContain('text-destructive');
  });

  it('gives the move button the solid/primary variant', async () => {
    render(<CancelConsultationDialog {...props()} />);
    const tokens = classTokens(await screen.findByRole('button', { name: 'Reschedule instead' }));
    expect(tokens).toContain('bg-primary');
    expect(tokens).not.toContain('text-destructive');
  });

  it('⚠ the outer footer stacks column-reverse narrow (destructive last) and is a row, justify-between, at sm', async () => {
    render(<CancelConsultationDialog {...props()} />);
    const dialog = await screen.findByRole('alertdialog');
    const footer = dialog.querySelector('[data-slot="alert-dialog-footer"]');
    expect(footer).not.toBeNull();
    const tokens = classTokens(footer as HTMLElement);
    expect(tokens).toEqual(
      expect.arrayContaining(['flex-col-reverse', 'sm:flex-row', 'sm:justify-between'])
    );
  });

  it('the safe group (Keep it, then the move button) is its own column-reverse-to-row unit', async () => {
    render(<CancelConsultationDialog {...props()} />);
    const keepIt = await screen.findByRole('button', { name: 'Keep it' });
    const safeGroup = keepIt.parentElement;
    expect(safeGroup).not.toBeNull();
    const tokens = classTokens(safeGroup as HTMLElement);
    expect(tokens).toEqual(expect.arrayContaining(['flex-col-reverse', 'sm:flex-row']));
    // Keep it precedes the move button in the DOM (so it renders FIRST at sm width).
    const buttons = within(safeGroup as HTMLElement).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Keep it', 'Reschedule instead']);
  });

  it('renders NO move button when neither canReschedule nor canProposeReschedule is true', async () => {
    render(
      <CancelConsultationDialog {...props({ canReschedule: false, canProposeReschedule: false })} />
    );
    await screen.findByRole('alertdialog');
    expect(screen.queryByRole('button', { name: 'Reschedule instead' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Propose a new time' })).not.toBeInTheDocument();
  });

  it('renders "Propose a new time" — filled — for the EXPERT lens', async () => {
    render(
      <CancelConsultationDialog
        {...props({
          lens: 'expert',
          counterpartyLabel: 'Northwind Industrial',
          canReschedule: false,
          canProposeReschedule: true,
        })}
      />
    );
    const button = await screen.findByRole('button', { name: 'Propose a new time' });
    expect(classTokens(button)).toContain('bg-primary');
    expect(screen.queryByRole('button', { name: 'Reschedule instead' })).not.toBeInTheDocument();
  });

  it('calls onMoveInstead("reschedule"), and neither onClose nor onCancelled, when chosen', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onMoveInstead = vi.fn();
    const onClose = vi.fn();
    const onCancelled = vi.fn();
    render(<CancelConsultationDialog {...props({ onMoveInstead, onClose, onCancelled })} />);

    await user.click(await screen.findByRole('button', { name: 'Reschedule instead' }));

    expect(onMoveInstead).toHaveBeenCalledTimes(1);
    expect(onMoveInstead).toHaveBeenCalledWith('reschedule');
    expect(onClose).not.toHaveBeenCalled();
    expect(onCancelled).not.toHaveBeenCalled();
    expect(mockCancelAction).not.toHaveBeenCalled();
  });

  it('calls onMoveInstead("propose") for the expert CTA', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onMoveInstead = vi.fn();
    render(
      <CancelConsultationDialog
        {...props({
          lens: 'expert',
          canReschedule: false,
          canProposeReschedule: true,
          onMoveInstead,
        })}
      />
    );

    await user.click(await screen.findByRole('button', { name: 'Propose a new time' }));

    expect(onMoveInstead).toHaveBeenCalledTimes(1);
    expect(onMoveInstead).toHaveBeenCalledWith('propose');
  });

  it('disables the move button while a cancel is submitting', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mockCancelAction.mockReturnValue(new Promise(() => {}));
    render(<CancelConsultationDialog {...props()} />);

    await user.click(await screen.findByRole('button', { name: 'Cancel consultation' }));

    expect(await screen.findByRole('button', { name: 'Reschedule instead' })).toBeDisabled();
  });
});

// ── Subject identity ────────────────────────────────────────────────────────

describe('CancelConsultationDialog — subject identity (BAL-421)', () => {
  it('the TITLE carries the absolute date/time — three near-identical rows must be distinguishable', async () => {
    render(<CancelConsultationDialog {...props()} />);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveAccessibleName(/Cancel the consultation on/);
  });

  /** A text node outside `AlertDialogHeader` is never wired into `aria-describedby`, so a DOM
   *  presence check alone would miss a reintroduced stray `<p>` sibling. */
  it('the DESCRIPTION carries the ordinal, duration and the facts — asserted through aria-describedby', async () => {
    render(<CancelConsultationDialog {...props({ ordinal: 3, scheduledMinutes: 45 })} />);
    const dialog = await screen.findByRole('alertdialog');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const description = describedBy === null ? null : document.getElementById(describedBy);
    if (description === null) throw new Error('expected an aria-describedby target element');

    expect(description.textContent).toContain('Consultation 3 · 45 minutes.');
    expect(description.textContent).toContain('nothing is charged');
    expect(description.textContent).toContain('CloudPeak');
    // ⚠ The date is stated ONCE, in the title — the description never repeats it.
    expect(description.textContent).not.toContain('Scheduled for');

    const paragraphs = Array.from(dialog.querySelectorAll('p'));
    expect(paragraphs.length).toBeGreaterThan(0);
    const stray = paragraphs.filter((paragraph) => !description.contains(paragraph));
    expect(stray).toEqual([]);
  });

  it('drops the ordinal clause, keeping only the duration, when ordinal is null', async () => {
    render(<CancelConsultationDialog {...props({ ordinal: null, scheduledMinutes: 20 })} />);
    const dialog = await screen.findByRole('alertdialog');
    const describedBy = dialog.getAttribute('aria-describedby');
    const description = describedBy === null ? null : document.getElementById(describedBy);
    expect(description?.textContent).toContain('20 minutes.');
    expect(description?.textContent).not.toContain('Consultation null');
  });

  it('threads `source` through to the analytics event', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CancelConsultationDialog {...props({ source: 'row' })} />);
    await user.click(await screen.findByRole('button', { name: 'Cancel consultation' }));

    await waitFor(() => {
      expect(mockTrack).toHaveBeenCalledWith(
        'booking_cancelled',
        expect.objectContaining({ source: 'row' })
      );
    });
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
   * ⚠ `initiated_by` COMES FROM THE ACTION'S RESPONSE — the API's own arm. The `admin` case
   * proves it: the dialog is mounted with `lens: 'client'` and still reports `'admin'`.
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
        source: 'nudge',
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

// ── Focus lands on headingRef, deterministically ───────────────────────────────

/** `open` must actually flip to `false` here — `onCloseAutoFocus` only fires once Radix's own
 *  `open` prop transitions and the content unmounts, so a static `open={true}` harness would
 *  never observe it regardless of which callback fired. */
function Harness(over: Record<string, unknown> = {}): React.JSX.Element {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [open, setOpen] = useState(true);
  const close = (): void => setOpen(false);
  return (
    <>
      <h2 ref={headingRef} tabIndex={-1}>
        Consultations
      </h2>
      <CancelConsultationDialog
        {...props(over)}
        open={open}
        onClose={close}
        onCancelled={close}
        onTerminalFailure={close}
        headingRef={headingRef}
      />
    </>
  );
}

describe('CancelConsultationDialog — focus lands on headingRef (F4)', () => {
  it('sends focus to headingRef after a SUCCESSFUL cancel, deterministically via onCloseAutoFocus', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Harness />);

    await user.click(await screen.findByRole('button', { name: 'Cancel consultation' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Consultations' })).toHaveFocus();
    });
  });

  it('sends focus to headingRef after a TERMINAL failure too', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mockCancelAction.mockResolvedValue({
      success: false,
      code: 'meeting_not_cancellable',
      error: 'x',
    });
    render(<Harness />);

    await user.click(await screen.findByRole('button', { name: 'Cancel consultation' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Consultations' })).toHaveFocus();
    });
  });

  it('does NOT steal focus to headingRef on a plain dismiss ("Keep it") — only terminal closes do', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Harness />);

    await user.click(await screen.findByRole('button', { name: 'Keep it' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Consultations' })).not.toHaveFocus();
    });
    expect(mockCancelAction).not.toHaveBeenCalled();
  });
});

/**
 * The real hop (`case-surface.tsx`) never flips `open`: it re-keys the selection so this
 * component unmounts while the matching picker mounts in the same commit. This harness mirrors
 * that shape — `open` stays `true` throughout, and `onMoveInstead` swaps which component renders.
 */
function MoveHopHarness({
  verb,
  moveOver = {},
}: Readonly<{
  verb: 'reschedule' | 'propose';
  moveOver?: Record<string, unknown>;
}>): React.JSX.Element {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [mode, setMode] = useState<'cancel' | 'moved'>('cancel');
  return (
    <>
      <h2 ref={headingRef} tabIndex={-1}>
        Consultations
      </h2>
      {mode === 'cancel' ? (
        <CancelConsultationDialog
          {...props(moveOver)}
          open
          onMoveInstead={() => setMode('moved')}
          headingRef={headingRef}
        />
      ) : (
        <div data-testid={`${verb}-stub`} />
      )}
    </>
  );
}

const EXPERT_PROPOSE_OVER = {
  lens: 'expert' as const,
  canReschedule: false,
  canProposeReschedule: true,
};

describe('CancelConsultationDialog — the move hop', () => {
  it('the RESCHEDULE hop does NOT send focus to headingRef — the mounting dialog claims it', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<MoveHopHarness verb="reschedule" />);

    await user.click(await screen.findByRole('button', { name: 'Reschedule instead' }));

    await waitFor(() => {
      expect(screen.getByTestId('reschedule-stub')).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { name: 'Consultations' })).not.toHaveFocus();
  });

  it('the PROPOSE hop does NOT send focus to headingRef either', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<MoveHopHarness verb="propose" moveOver={EXPERT_PROPOSE_OVER} />);

    await user.click(await screen.findByRole('button', { name: 'Propose a new time' }));

    await waitFor(() => {
      expect(screen.getByTestId('propose-stub')).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { name: 'Consultations' })).not.toHaveFocus();
  });

  it('⚠ fires booking_cancel_abandoned with diverted_to: "reschedule" for the reschedule hop', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<MoveHopHarness verb="reschedule" />);

    await user.click(await screen.findByRole('button', { name: 'Reschedule instead' }));

    await waitFor(() => {
      expect(mockTrack).toHaveBeenCalledWith('booking_cancel_abandoned', {
        diverted_to: 'reschedule',
      });
    });
    expect(
      mockTrack.mock.calls.filter(([event]) => event === 'booking_cancel_abandoned')
    ).toHaveLength(1);
  });

  it('⚠ fires booking_cancel_abandoned with diverted_to: "propose" for the propose hop', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<MoveHopHarness verb="propose" moveOver={EXPERT_PROPOSE_OVER} />);

    await user.click(await screen.findByRole('button', { name: 'Propose a new time' }));

    await waitFor(() => {
      expect(mockTrack).toHaveBeenCalledWith('booking_cancel_abandoned', {
        diverted_to: 'propose',
      });
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

  it('fires EXACTLY ONCE, diverted_to: null, on an open → close cycle with no confirm', () => {
    const { rerender } = render(<CancelConsultationDialog {...props({ open: true })} />);
    rerender(<CancelConsultationDialog {...props({ open: false })} />);

    expect(abandons()).toBe(1);
    expect(mockTrack).toHaveBeenCalledWith('booking_cancel_abandoned', { diverted_to: null });
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
