import { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@/test/utils';
import { ProposeTimesDialog } from './propose-times-dialog';

/**
 * BAL-411 — unit tests for the EXPERT's ≤3-slot propose dialog. Mirrors
 * `reschedule-dialog.test.tsx`'s house pattern: `useIsMobile` and `ExpertAvailabilityCalendar`
 * are mocked (jsdom has no `window.matchMedia`, and the real picker fetches availability), the
 * Server Action is mocked, and Sonner/Sentry/analytics are spies.
 */

const { mockIsMobile } = vi.hoisted(() => ({ mockIsMobile: { value: false } }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mockIsMobile.value }));

const mockProposeRescheduleAction = vi.fn();
vi.mock('@/app/(dashboard)/cases/[engagementId]/_actions/propose-reschedule', () => ({
  proposeRescheduleAction: (...a: unknown[]) => mockProposeRescheduleAction(...a),
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics', () => ({
  track: (...a: unknown[]) => mockTrack(...a),
  BOOKING_EVENTS: { RESCHEDULE_PROPOSED: 'reschedule_proposed' },
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

// N9 (reschedule-dialog precedent) — `mockPickerMountCount` observes a `key` REMOUNT (as
// opposed to a mere re-render): a bump unmounts and remounts the child, running its effect
// again, which is what proves the calendar resets between picks.
const { mockPickerMountCount } = vi.hoisted(() => ({ mockPickerMountCount: { value: 0 } }));

let nextSlotStart = '2026-09-08T10:00:00.000Z';
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
        onClick={() =>
          onSlotSelect({ start: nextSlotStart, end: '2026-09-08T10:30:00.000Z', duration: 30 })
        }
      >
        pick-slot
      </button>
    );
  },
}));

const BASE_PROPS = {
  open: true,
  onClose: vi.fn(),
  onProposed: vi.fn(),
  engagementId: 'e0000000-0000-4000-8000-000000000001',
  meetingId: 'm0000000-0000-4000-8000-000000000002',
  expertProfileId: 'p0000000-0000-4000-8000-000000000003',
  currentScheduledStartIso: '2026-09-01T09:00:00.000Z',
  durationMinutes: 30,
  caseTitle: 'Salesforce integration',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockIsMobile.value = false;
  mockPickerMountCount.value = 0;
  nextSlotStart = '2026-09-08T10:00:00.000Z';
  mockProposeRescheduleAction.mockResolvedValue({
    success: true,
    proposalId: 'proposal-1',
    meetingId: BASE_PROPS.meetingId,
    expiresAtIso: '2026-09-01T09:00:00.000Z',
    options: [
      {
        optionId: 'opt-1',
        scheduledStart: nextSlotStart,
        scheduledEnd: '2026-09-08T10:30:00.000Z',
        position: 0,
      },
    ],
  });
});

describe('ProposeTimesDialog — picking up to 3 times', () => {
  it('renders the picker when open', () => {
    render(<ProposeTimesDialog {...BASE_PROPS} />);
    expect(screen.getByRole('button', { name: 'pick-slot' })).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    render(<ProposeTimesDialog {...BASE_PROPS} open={false} />);
    expect(screen.queryByRole('button', { name: 'pick-slot' })).not.toBeInTheDocument();
  });

  it('adds a picked slot to the list and remounts the calendar for the next pick', async () => {
    const user = userEvent.setup();
    render(<ProposeTimesDialog {...BASE_PROPS} />);
    expect(mockPickerMountCount.value).toBe(1);

    await user.click(screen.getByRole('button', { name: 'pick-slot' }));

    expect(screen.getByRole('button', { name: 'Send proposal (1)' })).toBeInTheDocument();
    expect(mockPickerMountCount.value).toBe(2);
  });

  it('accumulates up to 3 DISTINCT picks, then hides the calendar', async () => {
    const user = userEvent.setup();
    render(<ProposeTimesDialog {...BASE_PROPS} />);

    nextSlotStart = '2026-09-08T10:00:00.000Z';
    await user.click(screen.getByRole('button', { name: 'pick-slot' }));
    nextSlotStart = '2026-09-09T10:00:00.000Z';
    await user.click(screen.getByRole('button', { name: 'pick-slot' }));
    nextSlotStart = '2026-09-10T10:00:00.000Z';
    await user.click(screen.getByRole('button', { name: 'pick-slot' }));

    expect(screen.getByRole('button', { name: 'Send proposal (3)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'pick-slot' })).not.toBeInTheDocument();
    expect(screen.getByText(/maximum of 3 times/i)).toBeInTheDocument();
  });

  it('removing a picked time brings the calendar back', async () => {
    const user = userEvent.setup();
    render(<ProposeTimesDialog {...BASE_PROPS} />);
    await user.click(screen.getByRole('button', { name: 'pick-slot' }));
    nextSlotStart = '2026-09-09T10:00:00.000Z';
    await user.click(screen.getByRole('button', { name: 'pick-slot' }));
    nextSlotStart = '2026-09-10T10:00:00.000Z';
    await user.click(screen.getByRole('button', { name: 'pick-slot' }));
    expect(screen.queryByRole('button', { name: 'pick-slot' })).not.toBeInTheDocument();

    const [firstRemoveButton] = screen.getAllByRole('button', { name: 'Remove this time' });
    if (firstRemoveButton === undefined) throw new Error('expected a remove button');
    await user.click(firstRemoveButton);

    expect(screen.getByRole('button', { name: 'pick-slot' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send proposal (2)' })).toBeInTheDocument();
  });

  it('disables Send until at least one time is picked', () => {
    render(<ProposeTimesDialog {...BASE_PROPS} />);
    expect(screen.getByRole('button', { name: 'Send proposal' })).toBeDisabled();
  });

  // Item 20 — the `reschedule-dialog.tsx` N14(b) precedent, applied to the `atMax` transition:
  // the click that hits the cap came from a button INSIDE the calendar, which the transition
  // then unmounts — without focus management, focus falls silently to `<body>`.
  it('hitting the 3-slot cap moves focus to the cap-reached note', async () => {
    const user = userEvent.setup();
    render(<ProposeTimesDialog {...BASE_PROPS} />);

    nextSlotStart = '2026-09-08T10:00:00.000Z';
    await user.click(screen.getByRole('button', { name: 'pick-slot' }));
    nextSlotStart = '2026-09-09T10:00:00.000Z';
    await user.click(screen.getByRole('button', { name: 'pick-slot' }));
    nextSlotStart = '2026-09-10T10:00:00.000Z';
    await user.click(screen.getByRole('button', { name: 'pick-slot' }));

    await waitFor(() => expect(screen.getByText(/maximum of 3 times/i)).toHaveFocus());
  });

  it('removing a pick to drop back under the cap returns focus to the dialog heading', async () => {
    const user = userEvent.setup();
    render(<ProposeTimesDialog {...BASE_PROPS} />);
    await user.click(screen.getByRole('button', { name: 'pick-slot' }));
    nextSlotStart = '2026-09-09T10:00:00.000Z';
    await user.click(screen.getByRole('button', { name: 'pick-slot' }));
    nextSlotStart = '2026-09-10T10:00:00.000Z';
    await user.click(screen.getByRole('button', { name: 'pick-slot' }));
    await waitFor(() => expect(screen.getByText(/maximum of 3 times/i)).toHaveFocus());

    const [firstRemoveButton] = screen.getAllByRole('button', { name: 'Remove this time' });
    if (firstRemoveButton === undefined) throw new Error('expected a remove button');
    await user.click(firstRemoveButton);

    // Two "Propose new times" headings exist (the sr-only `DialogTitle`, and the visible
    // in-body one this focuses) — find the VISIBLE one specifically.
    await waitFor(() => {
      const headings = screen.getAllByRole('heading', { name: 'Propose new times' });
      const visible = headings.find((h) => !h.className.includes('sr-only'));
      expect(visible).toHaveFocus();
    });
  });
});

describe('ProposeTimesDialog — submission', () => {
  it('sends the picked ISO starts and reports success', async () => {
    const onProposed = vi.fn();
    const user = userEvent.setup();
    render(<ProposeTimesDialog {...BASE_PROPS} onProposed={onProposed} />);

    await user.click(screen.getByRole('button', { name: 'pick-slot' }));
    await user.click(screen.getByRole('button', { name: 'Send proposal (1)' }));

    expect(mockProposeRescheduleAction).toHaveBeenCalledWith({
      engagementId: BASE_PROPS.engagementId,
      meetingId: BASE_PROPS.meetingId,
      optionStartIsos: ['2026-09-08T10:00:00.000Z'],
    });
    expect(mockToastSuccess).toHaveBeenCalled();
    expect(onProposed).toHaveBeenCalledTimes(1);
  });

  it('tracks RESCHEDULE_PROPOSED on success', async () => {
    const user = userEvent.setup();
    render(<ProposeTimesDialog {...BASE_PROPS} />);
    await user.click(screen.getByRole('button', { name: 'pick-slot' }));
    await user.click(screen.getByRole('button', { name: 'Send proposal (1)' }));

    expect(mockTrack).toHaveBeenCalledWith(
      'reschedule_proposed',
      expect.objectContaining({ proposal_id: 'proposal-1', option_count: 1 })
    );
  });

  it('a slot_unavailable failure toasts and resets the picker for a retry', async () => {
    mockProposeRescheduleAction.mockResolvedValue({
      success: false,
      code: 'slot_unavailable',
      error: 'One of those times was just taken.',
    });
    const user = userEvent.setup();
    render(<ProposeTimesDialog {...BASE_PROPS} />);
    await user.click(screen.getByRole('button', { name: 'pick-slot' }));
    await user.click(screen.getByRole('button', { name: 'Send proposal (1)' }));

    expect(mockToastError).toHaveBeenCalledWith('One of those times was just taken.');
    expect(screen.getByRole('button', { name: 'pick-slot' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send proposal' })).toBeDisabled();
  });

  it('a non-slot failure toasts without clearing the picked list', async () => {
    mockProposeRescheduleAction.mockResolvedValue({
      success: false,
      code: 'proposal_already_pending',
      error: 'You already have a proposal waiting on this consultation.',
    });
    const user = userEvent.setup();
    render(<ProposeTimesDialog {...BASE_PROPS} />);
    await user.click(screen.getByRole('button', { name: 'pick-slot' }));
    await user.click(screen.getByRole('button', { name: 'Send proposal (1)' }));

    expect(mockToastError).toHaveBeenCalledWith(
      'You already have a proposal waiting on this consultation.'
    );
    expect(screen.getByRole('button', { name: 'Send proposal (1)' })).toBeInTheDocument();
  });

  // Item 3 — BAL-409's `closeOnAcknowledge` precedent, carried over: a TERMINAL failure means
  // the dialog was rendered from state that no longer exists (the meeting/case/proposal is
  // gone), so it must close AND refresh rather than re-offer a Send that will fail again.
  it('a TERMINAL failure (meeting_not_reschedulable) toasts, closes, AND refreshes via onProposed', async () => {
    mockProposeRescheduleAction.mockResolvedValue({
      success: false,
      code: 'meeting_not_reschedulable',
      error: 'This consultation can no longer be moved.',
    });
    const onClose = vi.fn();
    const onProposed = vi.fn();
    const user = userEvent.setup();
    render(<ProposeTimesDialog {...BASE_PROPS} onClose={onClose} onProposed={onProposed} />);
    await user.click(screen.getByRole('button', { name: 'pick-slot' }));
    await user.click(screen.getByRole('button', { name: 'Send proposal (1)' }));

    expect(mockToastError).toHaveBeenCalledWith('This consultation can no longer be moved.');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onProposed).toHaveBeenCalledTimes(1);
  });

  it('Cancel resets the picked list and closes', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ProposeTimesDialog {...BASE_PROPS} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'pick-slot' }));

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
