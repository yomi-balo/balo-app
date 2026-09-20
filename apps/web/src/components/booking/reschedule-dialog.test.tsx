import { useEffect, useRef, useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axe } from 'jest-axe';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@/test/utils';
import type { AvailabilityView } from '@/components/availability/use-expert-availability';
import { RescheduleDialog } from './reschedule-dialog';

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub({ animatePresenceMode: 'wait' });
});

// jsdom does not implement `window.matchMedia`; the house pattern
// (`booking-flow-dialog.test.tsx`) mocks the hook directly rather than polyfilling it.
//
// N9 — CONTROLLABLE, not a hard-coded `false`. The old mock made "renders at a 375px viewport
// without throwing" exercise nothing: `window.innerWidth = 375` has zero effect on a mocked
// hook returning a constant, so the mobile `Sheet` branch never actually rendered. `mockIsMobile`
// is set per-test (`beforeEach` resets it to `false`, the desktop default every other test in
// this file assumes).
const { mockIsMobile } = vi.hoisted(() => ({ mockIsMobile: { value: false } }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mockIsMobile.value }));

const mockRescheduleAction = vi.fn();
vi.mock('@/app/(dashboard)/cases/[engagementId]/_actions/reschedule-consultation', () => ({
  rescheduleConsultationAction: (...a: unknown[]) => mockRescheduleAction(...a),
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics', () => ({
  track: (...a: unknown[]) => mockTrack(...a),
  BOOKING_EVENTS: { RESCHEDULED: 'booking_rescheduled' },
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

const PICKED_START = '2026-09-08T10:00:00.000Z';
const PICKED_END = '2026-09-08T10:30:00.000Z';

// N9 — `mockPickerMountCount` lets the `pickerKey` REMOUNT (as opposed to a mere re-render) be
// observed: a `key` bump unmounts and remounts the child, running its effect again.
const { mockPickerMountCount } = vi.hoisted(() => ({ mockPickerMountCount: { value: 0 } }));

// Defaults to a NON-ready view (no suggestions, no real fetch) so step 1 falls straight through
// to the mocked calendar below — the same shape every pre-suggested-view test in this file
// already assumes. The "suggested" describe block overrides this per test.
const { mockAvailabilityView } = vi.hoisted(() => ({
  mockAvailabilityView: { value: { kind: 'not_configured' } as AvailabilityView },
}));
vi.mock('@/components/availability/use-expert-availability', () => ({
  useExpertAvailability: () => ({ view: mockAvailabilityView.value, reload: vi.fn() }),
}));

vi.mock('@/components/availability', () => ({
  ExpertAvailabilityCalendar: ({
    onSlotSelect,
  }: {
    onSlotSelect: (s: { start: string; end: string; duration: number }) => void;
  }) => {
    useEffect(() => {
      mockPickerMountCount.value += 1;
    }, []);
    return (
      <button
        type="button"
        onClick={() => onSlotSelect({ start: PICKED_START, end: PICKED_END, duration: 30 })}
      >
        pick-slot
      </button>
    );
  },
}));

const BASE_PROPS = {
  open: true,
  onClose: vi.fn(),
  onRescheduled: vi.fn(),
  engagementId: 'e0000000-0000-4000-8000-000000000001',
  meetingId: 'm0000000-0000-4000-8000-000000000002',
  expertProfileId: 'p0000000-0000-4000-8000-000000000003',
  currentScheduledStartIso: '2026-09-01T09:00:00.000Z',
  durationMinutes: 30,
  caseTitle: 'Salesforce integration',
  ordinal: 2,
  source: 'nudge' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockIsMobile.value = false;
  mockPickerMountCount.value = 0;
  mockAvailabilityView.value = { kind: 'not_configured' };
});

async function advanceToConfirm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'pick-slot' }));
}

describe('RescheduleDialog — T-WEB-UI', () => {
  it('renders the picker at step 1', () => {
    render(<RescheduleDialog {...BASE_PROPS} />);
    expect(screen.getByRole('button', { name: 'pick-slot' })).toBeInTheDocument();
  });

  it('advancing to confirm shows old → new time', async () => {
    const user = userEvent.setup();
    render(<RescheduleDialog {...BASE_PROPS} />);

    await advanceToConfirm(user);

    expect(screen.getByText('Currently')).toBeInTheDocument();
    expect(screen.getByText('Moving to')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move consultation' })).toBeInTheDocument();
  });

  it('submit disables and shows a pending state', async () => {
    const user = userEvent.setup();
    let resolveAction: ((v: unknown) => void) | undefined;
    mockRescheduleAction.mockReturnValue(
      new Promise((resolve) => {
        resolveAction = resolve;
      })
    );
    render(<RescheduleDialog {...BASE_PROPS} />);
    await advanceToConfirm(user);

    await user.click(screen.getByRole('button', { name: 'Move consultation' }));

    expect(await screen.findByRole('button', { name: 'Moving…' })).toBeDisabled();
    resolveAction?.({ success: true, scheduledStart: PICKED_START, scheduledEnd: PICKED_END });
    // Let the resolution's state update settle inside `act()` before the test tears down.
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
  });

  it('success toasts and calls onRescheduled, and fires the analytics event', async () => {
    const user = userEvent.setup();
    const onRescheduled = vi.fn();
    mockRescheduleAction.mockResolvedValue({
      success: true,
      scheduledStart: PICKED_START,
      scheduledEnd: PICKED_END,
    });
    render(<RescheduleDialog {...BASE_PROPS} onRescheduled={onRescheduled} />);
    await advanceToConfirm(user);

    await user.click(screen.getByRole('button', { name: 'Move consultation' }));

    await waitFor(() => expect(onRescheduled).toHaveBeenCalledTimes(1));
    expect(mockToastSuccess).toHaveBeenCalledWith('Consultation moved', expect.anything());
    expect(mockTrack).toHaveBeenCalledWith(
      'booking_rescheduled',
      expect.objectContaining({ initiated_by: 'client' })
    );
  });

  it.each([
    ['slot_unavailable', 'That time was just taken. Pick another.'],
    ['meeting_not_reschedulable', 'This consultation can no longer be moved.'],
    ['meeting_not_found', "We couldn't find that consultation."],
    ['rate_limited', 'Too many changes just now — try again shortly.'],
    ['unknown', 'Something went wrong. Please try again.'],
  ])('maps failure code %s to its own copy', async (code, expectedMessage) => {
    const user = userEvent.setup();
    mockRescheduleAction.mockResolvedValue({ success: false, code, error: 'server literal' });
    render(<RescheduleDialog {...BASE_PROPS} />);
    await advanceToConfirm(user);

    await user.click(screen.getByRole('button', { name: 'Move consultation' }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(expectedMessage));
    // Never echoes the server's raw literal.
    expect(mockToastError).not.toHaveBeenCalledWith('server literal');
  });

  // N9 — `closeOnAcknowledge` and the `pickerKey` remount were both untested.
  it('closeOnAcknowledge=true (meeting_not_reschedulable) closes the dialog via onClose', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    mockRescheduleAction.mockResolvedValue({
      success: false,
      code: 'meeting_not_reschedulable',
      error: 'server literal',
    });
    render(<RescheduleDialog {...BASE_PROPS} onClose={onClose} />);
    await advanceToConfirm(user);

    await user.click(screen.getByRole('button', { name: 'Move consultation' }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closeOnAcknowledge=true (meeting_not_found) closes the dialog via onClose', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    mockRescheduleAction.mockResolvedValue({
      success: false,
      code: 'meeting_not_found',
      error: 'server literal',
    });
    render(<RescheduleDialog {...BASE_PROPS} onClose={onClose} />);
    await advanceToConfirm(user);

    await user.click(screen.getByRole('button', { name: 'Move consultation' }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closeOnAcknowledge=false + slot_unavailable: stays open, returns to pick_time, and REMOUNTS the picker (pickerKey bump)', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    mockRescheduleAction.mockResolvedValue({
      success: false,
      code: 'slot_unavailable',
      error: 'server literal',
    });
    render(<RescheduleDialog {...BASE_PROPS} onClose={onClose} />);
    await advanceToConfirm(user);
    const mountsBeforeFailure = mockPickerMountCount.value;

    await user.click(screen.getByRole('button', { name: 'Move consultation' }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    // Back at pick_time — the picker button is visible again — and the dialog was NOT closed.
    expect(await screen.findByRole('button', { name: 'pick-slot' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    // The `key={pickerKey}` bump unmounted and remounted the picker — a second mount, not a
    // mere re-render of the same instance.
    expect(mockPickerMountCount.value).toBeGreaterThan(mountsBeforeFailure);
  });

  it('closeOnAcknowledge=false + rate_limited: stays on the confirm step, no remount, no close', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    mockRescheduleAction.mockResolvedValue({
      success: false,
      code: 'rate_limited',
      error: 'server literal',
    });
    render(<RescheduleDialog {...BASE_PROPS} onClose={onClose} />);
    await advanceToConfirm(user);
    const mountsBeforeFailure = mockPickerMountCount.value;

    await user.click(screen.getByRole('button', { name: 'Move consultation' }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    // Still on the confirm step (the "Move consultation" button, not the picker).
    expect(screen.getByRole('button', { name: 'Move consultation' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(mockPickerMountCount.value).toBe(mountsBeforeFailure);
  });

  // N14(b) — focus follows the pick_time ↔ confirm step transition, mirroring
  // `availability-slots-panel.tsx`'s `backRef`/`headingRef` pattern one level down.
  it('N14(b) — advancing to confirm moves focus to "Choose a different time"', async () => {
    const user = userEvent.setup();
    render(<RescheduleDialog {...BASE_PROPS} />);

    await advanceToConfirm(user);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Choose a different time' })).toHaveFocus()
    );
  });

  it('N14(b) — going back moves focus to the pick_time heading, not <body>', async () => {
    const user = userEvent.setup();
    render(<RescheduleDialog {...BASE_PROPS} />);
    await advanceToConfirm(user);

    await user.click(screen.getByRole('button', { name: 'Choose a different time' }));

    // The sr-only `DialogTitle`'s accessible name now carries the ordinal, so it no longer
    // collides with the visible heading's exact "Reschedule consultation" text.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Reschedule consultation' })).toHaveFocus();
    });
    // Programmatic focus on a non-interactive heading must not paint the browser's default ring.
    expect(screen.getByRole('heading', { name: 'Reschedule consultation' })).toHaveClass(
      'focus-visible:outline-none'
    );
  });

  // N14(c) — a TERMINAL failure routes to `onTerminalFailure`, not plain `onClose`.
  it('N14(c) — meeting_not_reschedulable calls onTerminalFailure, not onClose', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onTerminalFailure = vi.fn();
    mockRescheduleAction.mockResolvedValue({
      success: false,
      code: 'meeting_not_reschedulable',
      error: 'server literal',
    });
    render(
      <RescheduleDialog {...BASE_PROPS} onClose={onClose} onTerminalFailure={onTerminalFailure} />
    );
    await advanceToConfirm(user);

    await user.click(screen.getByRole('button', { name: 'Move consultation' }));

    await waitFor(() => expect(onTerminalFailure).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('N14(c) — falls back to onClose when onTerminalFailure is omitted', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    mockRescheduleAction.mockResolvedValue({
      success: false,
      code: 'meeting_not_found',
      error: 'server literal',
    });
    render(<RescheduleDialog {...BASE_PROPS} onClose={onClose} />);
    await advanceToConfirm(user);

    await user.click(screen.getByRole('button', { name: 'Move consultation' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  // ── Focus lands on headingRef, deterministically, terminal only ──────────────────

  /** `open` must actually flip to `false` here — `onCloseAutoFocus` only fires once Radix's own
   *  `open` prop transitions and the content unmounts, so a static `open={true}` harness would
   *  never observe it regardless of which callback fired. */
  function Harness(): React.JSX.Element {
    const headingRef = useRef<HTMLHeadingElement>(null);
    const [open, setOpen] = useState(true);
    const close = (): void => setOpen(false);
    return (
      <>
        <h2 ref={headingRef} tabIndex={-1}>
          Consultations
        </h2>
        <RescheduleDialog
          {...BASE_PROPS}
          open={open}
          onClose={close}
          onRescheduled={close}
          onTerminalFailure={close}
          headingRef={headingRef}
        />
      </>
    );
  }

  it('sends focus to headingRef after a TERMINAL failure, deterministically via onCloseAutoFocus', async () => {
    const user = userEvent.setup();
    mockRescheduleAction.mockResolvedValue({
      success: false,
      code: 'meeting_not_reschedulable',
      error: 'server literal',
    });
    render(<Harness />);
    await advanceToConfirm(user);

    await user.click(screen.getByRole('button', { name: 'Move consultation' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Consultations' })).toHaveFocus();
    });
  });

  /** ⚠ Deliberately asymmetric with `CancelConsultationDialog`: a successful reschedule keeps
   *  the row mounted, so `case-surface.tsx`'s `handleRescheduled` sends focus to the row's own
   *  trigger instead — `terminalCloseRef` is never set on this path. */
  it('does NOT send focus to headingRef on a SUCCESSFUL reschedule — that is the row trigger’s job, outside this dialog', async () => {
    const user = userEvent.setup();
    mockRescheduleAction.mockResolvedValue({
      success: true,
      scheduledStart: PICKED_START,
      scheduledEnd: PICKED_END,
    });
    render(<Harness />);
    await advanceToConfirm(user);

    await user.click(screen.getByRole('button', { name: 'Move consultation' }));

    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalled();
    });
    expect(screen.getByRole('heading', { name: 'Consultations' })).not.toHaveFocus();
  });

  it('does NOT steal focus to headingRef on a plain dismiss (the "Close" button) — only the terminal close does', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Consultations' })).not.toHaveFocus();
    });
    expect(mockRescheduleAction).not.toHaveBeenCalled();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<RescheduleDialog {...BASE_PROPS} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('renders at a 375px viewport without throwing', () => {
    window.innerWidth = 375;
    expect(() => render(<RescheduleDialog {...BASE_PROPS} />)).not.toThrow();
  });

  // N9 — the mobile branch itself, which the test above never actually reached. Both `Dialog`
  // and `Sheet` render into a PORTAL (document.body), not the render container.
  it('renders the mobile Sheet (not the desktop Dialog) when useIsMobile(768) is true', () => {
    mockIsMobile.value = true;
    render(<RescheduleDialog {...BASE_PROPS} />);

    expect(document.querySelector('[data-slot="sheet-content"]')).toBeInTheDocument();
    expect(document.querySelector('[data-slot="dialog-content"]')).not.toBeInTheDocument();
  });

  it('renders the desktop Dialog (not the Sheet) when useIsMobile(768) is false', () => {
    render(<RescheduleDialog {...BASE_PROPS} />);

    expect(document.querySelector('[data-slot="dialog-content"]')).toBeInTheDocument();
    expect(document.querySelector('[data-slot="sheet-content"]')).not.toBeInTheDocument();
  });

  // Wide enough for the embedded ExpertAvailabilityCalendar's two-pane layout (300px slots
  // column + a month grid that doesn't bunch), capped so it never overflows a small viewport.
  it('is wide enough to host the two-pane calendar, capped against the viewport', () => {
    render(<RescheduleDialog {...BASE_PROPS} />);
    expect(document.querySelector('[data-slot="dialog-content"]')).toHaveClass(
      'sm:max-w-[min(92vw,840px)]'
    );
  });

  // ── Subject identity ──────────────────────────────────────────────────────────

  it('step 1 shows a "Currently {date} · {duration} min" subject strip', () => {
    render(<RescheduleDialog {...BASE_PROPS} />);
    expect(screen.getByText(/Currently/).textContent).toContain('30 min');
  });

  it('the programmatic name carries the ordinal and the current time', () => {
    render(<RescheduleDialog {...BASE_PROPS} ordinal={3} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName(/Reschedule consultation 3 — currently/);
  });

  it('the programmatic name omits the ordinal number when it is null', () => {
    render(<RescheduleDialog {...BASE_PROPS} ordinal={null} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName(/^Reschedule consultation — currently/);
  });

  it('threads `source` through to the analytics event', async () => {
    const user = userEvent.setup();
    mockRescheduleAction.mockResolvedValue({
      success: true,
      scheduledStart: PICKED_START,
      scheduledEnd: PICKED_END,
    });
    render(<RescheduleDialog {...BASE_PROPS} source="row" />);
    await advanceToConfirm(user);

    await user.click(screen.getByRole('button', { name: 'Move consultation' }));

    await waitFor(() =>
      expect(mockTrack).toHaveBeenCalledWith(
        'booking_rescheduled',
        expect.objectContaining({ source: 'row' })
      )
    );
  });
});

function readyView(starts: readonly string[]): AvailabilityView {
  return {
    kind: 'ready',
    expertTimezone: 'UTC',
    days: 14,
    slots: starts.map((start) => ({
      start,
      end: new Date(new Date(start).getTime() + 30 * 60_000).toISOString(),
      maxDuration: 30,
    })),
  };
}

const SUGGESTED_TIME = /Wed, 2 Sept, 9:00 – 9:30 am · 30 min/;

describe('RescheduleDialog — suggested times', () => {
  it('opens on suggested times when availability is ready with candidates', () => {
    mockAvailabilityView.value = readyView(['2026-09-02T09:00:00.000Z']);
    render(<RescheduleDialog {...BASE_PROPS} />);

    expect(screen.getByText('Suggested times')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: SUGGESTED_TIME })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'pick-slot' })).not.toBeInTheDocument();
  });

  it('opens straight on the calendar when availability is ready but nothing suggests', () => {
    mockAvailabilityView.value = readyView([]);
    render(<RescheduleDialog {...BASE_PROPS} />);

    expect(screen.getByRole('button', { name: 'pick-slot' })).toBeInTheDocument();
    expect(screen.queryByText('Suggested times')).not.toBeInTheDocument();
  });

  it('opens straight on the calendar when availability is not ready', () => {
    mockAvailabilityView.value = { kind: 'error' };
    render(<RescheduleDialog {...BASE_PROPS} />);

    expect(screen.getByRole('button', { name: 'pick-slot' })).toBeInTheDocument();
    expect(screen.queryByText('Suggested times')).not.toBeInTheDocument();
  });

  it('picking a suggested time advances straight to confirm', async () => {
    mockAvailabilityView.value = readyView(['2026-09-02T09:00:00.000Z']);
    const user = userEvent.setup();
    render(<RescheduleDialog {...BASE_PROPS} />);

    await user.click(screen.getByRole('button', { name: SUGGESTED_TIME }));

    expect(screen.getByText('Currently')).toBeInTheDocument();
    expect(screen.getByText('Moving to')).toBeInTheDocument();
  });

  it('"See more times" switches to the calendar', async () => {
    mockAvailabilityView.value = readyView(['2026-09-02T09:00:00.000Z']);
    const user = userEvent.setup();
    render(<RescheduleDialog {...BASE_PROPS} />);

    await user.click(screen.getByRole('button', { name: 'See more times' }));

    expect(screen.getByRole('button', { name: 'pick-slot' })).toBeInTheDocument();
    // The suggested SLOT is gone — a "← Suggested times" back link is expected here instead.
    expect(screen.queryByRole('button', { name: SUGGESTED_TIME })).not.toBeInTheDocument();
  });

  it('"Choose a different time" returns to SUGGESTED when the pick came from there', async () => {
    mockAvailabilityView.value = readyView(['2026-09-02T09:00:00.000Z']);
    const user = userEvent.setup();
    render(<RescheduleDialog {...BASE_PROPS} />);
    await user.click(screen.getByRole('button', { name: SUGGESTED_TIME }));

    await user.click(screen.getByRole('button', { name: 'Choose a different time' }));

    expect(screen.getByRole('button', { name: SUGGESTED_TIME })).toBeInTheDocument();
  });

  it('"Choose a different time" returns to the CALENDAR when the pick came from there', async () => {
    mockAvailabilityView.value = readyView(['2026-09-02T09:00:00.000Z']);
    const user = userEvent.setup();
    render(<RescheduleDialog {...BASE_PROPS} />);
    await user.click(screen.getByRole('button', { name: 'See more times' }));
    await advanceToConfirm(user);

    await user.click(screen.getByRole('button', { name: 'Choose a different time' }));

    expect(screen.getByRole('button', { name: 'pick-slot' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: SUGGESTED_TIME })).not.toBeInTheDocument();
  });

  it('a suggested pick moves focus to "Choose a different time", same as the calendar path', async () => {
    mockAvailabilityView.value = readyView(['2026-09-02T09:00:00.000Z']);
    const user = userEvent.setup();
    render(<RescheduleDialog {...BASE_PROPS} />);

    await user.click(screen.getByRole('button', { name: SUGGESTED_TIME }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Choose a different time' })).toHaveFocus()
    );
  });
});
