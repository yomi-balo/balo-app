import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { track } from '@/lib/analytics';
import { SCHEDULE_EVENTS } from '@balo/analytics/events';
import { toast } from 'sonner';
import type { ScheduleLoadResult } from '../_actions/get-schedule';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// Stub the calendar section (has its own fetch + searchParams) — we only assert it mounts below.
vi.mock('./calendar-connections-section', () => ({
  CalendarConnectionsSection: () => (
    <div data-testid="calendar-connections-section-stub">calendar</div>
  ),
}));

// BAL-397 §3.1 — DateOverridesCard moved up out of the calendar section into ScheduleTab
// itself, so it now needs its own stub here (it has its own fetch, unrelated to the calendar
// section's, and a failed calendar fetch must not take it down).
vi.mock('./date-overrides-card', () => ({
  DateOverridesCard: () => <div data-testid="date-overrides-card-stub">time off</div>,
}));

// Stub the Radix-heavy timezone combobox so we can drive the timezone handler deterministically.
vi.mock('./schedule-timezone-combobox', () => ({
  ScheduleTimezoneCombobox: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (tz: string) => void;
  }) => (
    <button type="button" onClick={() => onChange('Australia/Sydney')}>
      timezone:{value}
    </button>
  ),
}));

// Stub the Radix-heavy booking-rules selects; expose a deterministic change button so
// the booking_rules_saved change-gate can be driven without pointer events. Field
// rendering itself is covered by booking-rules-section.test.tsx.
// BAL-236 — stub the picker. Its own behaviour is covered by
// `components/availability/ExpertAvailabilityCalendar.test.tsx`; this suite only proves the
// mount condition and the expertProfileId ref→state promotion (D15).
vi.mock('@/components/availability', () => ({
  ExpertAvailabilityCalendar: ({ expertProfileId }: { expertProfileId: string }) => (
    <div data-testid="availability-preview-stub">preview:{expertProfileId}</div>
  ),
}));

vi.mock('./booking-rules-section', () => ({
  BookingRulesSection: ({
    settings,
    onChange,
  }: {
    settings: {
      bufferBeforeMinutes: number;
      bufferAfterMinutes: number;
      minimumNoticeMinutes: number;
    };
    onChange: (next: {
      bufferBeforeMinutes: number;
      bufferAfterMinutes: number;
      minimumNoticeMinutes: number;
    }) => void;
  }) => (
    <div>
      <span>Booking rules</span>
      <button type="button" onClick={() => onChange({ ...settings, bufferBeforeMinutes: 30 })}>
        stub-change-buffer
      </button>
    </div>
  ),
}));

const mockGetSchedule = vi.fn();
const mockSaveSchedule = vi.fn();
const mockClearSchedule = vi.fn();
const mockUpdateTimezone = vi.fn();

vi.mock('../_actions/get-schedule', () => ({
  getScheduleAction: (...args: unknown[]) => mockGetSchedule(...args),
}));
vi.mock('../_actions/save-schedule', () => ({
  saveScheduleAction: (...args: unknown[]) => mockSaveSchedule(...args),
}));
vi.mock('../_actions/clear-schedule', () => ({
  clearScheduleAction: (...args: unknown[]) => mockClearSchedule(...args),
}));
vi.mock('../_actions/update-schedule-timezone', () => ({
  updateScheduleTimezoneAction: (...args: unknown[]) => mockUpdateTimezone(...args),
}));

vi.mock('motion/react', () => {
  const MOTION_PROPS = new Set(['variants', 'initial', 'animate', 'exit', 'transition']);
  const filterMotion = (props: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(props).filter(([k]) => !MOTION_PROPS.has(k)));
  return {
    motion: {
      div: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
        <div {...filterMotion(props)}>{children}</div>
      ),
    },
    AnimatePresence: ({ children }: React.PropsWithChildren) => children,
  };
});

import { ScheduleTab } from './schedule-tab';

// ── Fixtures ────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 10,
  minimumNoticeMinutes: 240,
};

function loadResult(overrides: Partial<ScheduleLoadResult> = {}): ScheduleLoadResult {
  return {
    expertProfileId: 'profile-1',
    timezone: 'Australia/Melbourne',
    bookingSettings: DEFAULT_SETTINGS,
    rules: [
      { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' },
      { dayOfWeek: 2, startTime: '09:00', endTime: '17:00' },
    ],
    ...overrides,
  };
}

// Radix Select drives the open/select interaction through Pointer Capture APIs
// jsdom doesn't implement — stub them so the real time-select listbox can open.
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn();
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

// ── Tests ───────────────────────────────────────────────────────

describe('ScheduleTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSchedule.mockResolvedValue(loadResult());
    mockSaveSchedule.mockResolvedValue({ success: true });
    mockClearSchedule.mockResolvedValue({ success: true });
    mockUpdateTimezone.mockResolvedValue({ success: true });
  });

  it('renders the ready editor after loading a schedule', async () => {
    render(<ScheduleTab />);
    expect(await screen.findByText('Weekly hours')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save schedule' })).toBeInTheDocument();
    expect(screen.getByTestId('calendar-connections-section-stub')).toBeInTheDocument();
  });

  // Relocated from calendar-tab.test.tsx (BAL-397 §3.1) — DateOverridesCard now renders
  // from ScheduleTab directly, no longer nested inside the calendar section, so a broken
  // calendar fetch can never take Time off down with it.
  it('mounts the Time off card even when no calendar is connected', async () => {
    render(<ScheduleTab />);
    await screen.findByText('Weekly hours');
    expect(screen.getByTestId('date-overrides-card-stub')).toBeInTheDocument();
  });

  it('shows booking rules but no consultation-length or booking-window control', async () => {
    render(<ScheduleTab />);
    await screen.findByText('Weekly hours');
    expect(screen.getByText('Booking rules')).toBeInTheDocument();
    expect(screen.queryByText('Booking window')).not.toBeInTheDocument();
    expect(screen.queryByText(/consultation length/i)).not.toBeInTheDocument();
  });

  it('shows the invitation empty state when there are no rules', async () => {
    mockGetSchedule.mockResolvedValue(loadResult({ rules: [] }));
    const user = userEvent.setup();
    render(<ScheduleTab />);

    expect(await screen.findByText('Set your weekly hours')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use these hours' }));
    expect(await screen.findByText('Weekly hours')).toBeInTheDocument();
  });

  // ── BAL-236 — the availability preview mount (D15) ────────────

  it('renders the availability preview once the schedule loads, with the promoted expertProfileId', async () => {
    mockGetSchedule.mockResolvedValue(loadResult({ expertProfileId: 'profile-xyz' }));
    render(<ScheduleTab />);

    await screen.findByText('Weekly hours');
    expect(screen.getByText('What clients see')).toBeInTheDocument();
    expect(screen.getByTestId('availability-preview-stub')).toHaveTextContent(
      'preview:profile-xyz'
    );
  });

  it('does not render the availability preview in the empty state', async () => {
    mockGetSchedule.mockResolvedValue(loadResult({ rules: [] }));
    render(<ScheduleTab />);

    await screen.findByText('Set your weekly hours');
    expect(screen.queryByTestId('availability-preview-stub')).not.toBeInTheDocument();
  });

  it('does not render the availability preview while loading', () => {
    mockGetSchedule.mockReturnValue(new Promise(() => {})); // never resolves
    render(<ScheduleTab />);

    expect(screen.queryByTestId('availability-preview-stub')).not.toBeInTheDocument();
  });

  it('shows the error state and retries when loading fails', async () => {
    mockGetSchedule.mockResolvedValueOnce(null).mockResolvedValueOnce(loadResult());
    const user = userEvent.setup();
    render(<ScheduleTab />);

    expect(await screen.findByText("We couldn't load your hours")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('Weekly hours')).toBeInTheDocument();
  });

  it('saves the schedule and fires schedule_saved; suppresses booking_rules_saved when unchanged', async () => {
    const user = userEvent.setup();
    render(<ScheduleTab />);
    await screen.findByText('Weekly hours');

    await user.click(screen.getByRole('button', { name: 'Save schedule' }));

    await waitFor(() => expect(mockSaveSchedule).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith('Schedule saved');
    expect(track).toHaveBeenCalledWith(
      SCHEDULE_EVENTS.SAVED,
      expect.objectContaining({
        expert_id: 'profile-1',
        has_split_days: false,
        has_overnight_window: false,
        has_late_window: false,
      })
    );
    // Booking settings equal the persisted values → the change-gate suppresses the event.
    expect(track).not.toHaveBeenCalledWith(SCHEDULE_EVENTS.BOOKING_RULES_SAVED, expect.anything());
  });

  it('fires schedule_saved with has_overnight_window when a rule crosses midnight', async () => {
    mockGetSchedule.mockResolvedValue(
      loadResult({ rules: [{ dayOfWeek: 1, startTime: '21:00', endTime: '01:00' }] })
    );
    const user = userEvent.setup();
    render(<ScheduleTab />);
    await screen.findByText('Weekly hours');

    await user.click(screen.getByRole('button', { name: 'Save schedule' }));

    await waitFor(() => expect(mockSaveSchedule).toHaveBeenCalledTimes(1));
    expect(track).toHaveBeenCalledWith(
      SCHEDULE_EVENTS.SAVED,
      expect.objectContaining({ has_overnight_window: true, has_late_window: false })
    );
    // AC3: a crossing rule round-trips — saved, reloaded, and shown as one range.
    expect(mockSaveSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        rules: [{ dayOfWeek: 1, startTime: '21:00', endTime: '01:00' }],
      })
    );
  });

  it('fires schedule_saved with has_late_window for a same-day range ending after 22:00', async () => {
    mockGetSchedule.mockResolvedValue(
      loadResult({ rules: [{ dayOfWeek: 1, startTime: '18:00', endTime: '22:30' }] })
    );
    const user = userEvent.setup();
    render(<ScheduleTab />);
    await screen.findByText('Weekly hours');

    await user.click(screen.getByRole('button', { name: 'Save schedule' }));

    await waitFor(() => expect(mockSaveSchedule).toHaveBeenCalledTimes(1));
    expect(track).toHaveBeenCalledWith(
      SCHEDULE_EVENTS.SAVED,
      expect.objectContaining({ has_late_window: true, has_overnight_window: false })
    );
  });

  it('blocks save on a cross-day conflict, shows the toast and inline pointer, and clears on edit', async () => {
    mockGetSchedule.mockResolvedValue(
      loadResult({
        rules: [
          { dayOfWeek: 1, startTime: '22:00', endTime: '02:00' },
          { dayOfWeek: 2, startTime: '01:00', endTime: '09:00' },
        ],
      })
    );
    const user = userEvent.setup();
    render(<ScheduleTab />);
    await screen.findByText('Weekly hours');

    await user.click(screen.getByRole('button', { name: 'Save schedule' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(
          /Monday's 10:00 PM – 2:00 AM \(next day\) range runs into Tuesday morning/
        )
      )
    );
    expect(mockSaveSchedule).not.toHaveBeenCalled();
    expect(await screen.findAllByText(/Overlaps with/)).toHaveLength(2);

    // Editing any control clears the stale highlight (markEdited).
    await user.click(screen.getByRole('switch', { name: 'Tuesday availability' }));
    expect(screen.queryByText(/Overlaps with/)).not.toBeInTheDocument();
  });

  it('fires booking_rules_saved with the new values when a booking rule changes', async () => {
    const user = userEvent.setup();
    render(<ScheduleTab />);
    await screen.findByText('Weekly hours');

    // Change the before-buffer via the stub, then save.
    await user.click(screen.getByRole('button', { name: 'stub-change-buffer' }));
    await user.click(screen.getByRole('button', { name: 'Save schedule' }));

    await waitFor(() => expect(mockSaveSchedule).toHaveBeenCalledTimes(1));
    expect(track).toHaveBeenCalledWith(SCHEDULE_EVENTS.BOOKING_RULES_SAVED, {
      expert_id: 'profile-1',
      buffer_before_minutes: 30,
      buffer_after_minutes: 10,
      minimum_notice_minutes: 240,
    });
  });

  it('confirms before clearing, then fires analytics and returns to the empty state', async () => {
    const user = userEvent.setup();
    render(<ScheduleTab />);
    await screen.findByText('Weekly hours');

    // Clicking the toolbar button only opens the confirmation dialog — it must NOT clear yet.
    await user.click(screen.getByRole('button', { name: /Clear schedule/ }));
    expect(await screen.findByText('Clear your whole schedule?')).toBeInTheDocument();
    expect(mockClearSchedule).not.toHaveBeenCalled();

    // Confirming the destructive action performs the clear.
    await user.click(screen.getByRole('button', { name: 'Yes, clear it' }));

    await waitFor(() => expect(mockClearSchedule).toHaveBeenCalledTimes(1));
    expect(track).toHaveBeenCalledWith(SCHEDULE_EVENTS.CLEARED, { expert_id: 'profile-1' });
    expect(await screen.findByText('Set your weekly hours')).toBeInTheDocument();
  });

  it('confirms before changing timezone when rules exist, then persists and fires analytics', async () => {
    const user = userEvent.setup();
    render(<ScheduleTab />);
    await screen.findByText('Weekly hours');

    // Selecting a new timezone opens the reinterpret confirmation — it must NOT persist yet.
    await user.click(screen.getByRole('button', { name: /timezone:Australia\/Melbourne/ }));
    expect(await screen.findByText('Change your timezone?')).toBeInTheDocument();
    expect(mockUpdateTimezone).not.toHaveBeenCalled();

    // Confirming performs the change.
    await user.click(screen.getByRole('button', { name: 'Change timezone' }));

    await waitFor(() => expect(mockUpdateTimezone).toHaveBeenCalledWith('Australia/Sydney'));
    expect(track).toHaveBeenCalledWith(SCHEDULE_EVENTS.TIMEZONE_CHANGED, {
      expert_id: 'profile-1',
      from_timezone: 'Australia/Melbourne',
      to_timezone: 'Australia/Sydney',
    });
    expect(toast.success).toHaveBeenCalledWith('Timezone updated');
  });

  it('cancels a timezone change, leaving it unpersisted', async () => {
    const user = userEvent.setup();
    render(<ScheduleTab />);
    await screen.findByText('Weekly hours');

    await user.click(screen.getByRole('button', { name: /timezone:Australia\/Melbourne/ }));
    expect(await screen.findByText('Change your timezone?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Keep current timezone' }));

    expect(mockUpdateTimezone).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalledWith(SCHEDULE_EVENTS.TIMEZONE_CHANGED, expect.anything());
  });

  it('changes timezone immediately (no confirmation) when no schedule is saved yet', async () => {
    mockGetSchedule.mockResolvedValue(loadResult({ rules: [] }));
    const user = userEvent.setup();
    render(<ScheduleTab />);

    // Enter the editor from the empty state — nothing is persisted, so no reinterpret risk.
    await user.click(await screen.findByRole('button', { name: 'Use these hours' }));
    await screen.findByText('Weekly hours');

    await user.click(screen.getByRole('button', { name: /timezone:Australia\/Melbourne/ }));

    await waitFor(() => expect(mockUpdateTimezone).toHaveBeenCalledWith('Australia/Sydney'));
    expect(screen.queryByText('Change your timezone?')).not.toBeInTheDocument();
  });

  it('surfaces a non-blocking DST warning when a range lands in a spring-forward gap', async () => {
    // A Sunday 01:00–04:00 range overlaps the Melbourne 02:00→03:00 spring-forward gap.
    mockGetSchedule.mockResolvedValue(
      loadResult({ rules: [{ dayOfWeek: 0, startTime: '01:00', endTime: '04:00' }] })
    );
    render(<ScheduleTab />);
    await screen.findByText('Weekly hours');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/daylight saving/i);
  });

  it('surfaces the previous-day-attribution DST copy when the gap lands in an overnight tail', async () => {
    // Saturday 22:00–04:00 (Melbourne): the tail [0, 240) contains the Sunday 02:00–03:00 gap.
    mockGetSchedule.mockResolvedValue(
      loadResult({ rules: [{ dayOfWeek: 6, startTime: '22:00', endTime: '04:00' }] })
    );
    render(<ScheduleTab />);
    await screen.findByText('Weekly hours');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/overnight range you set/);
  });

  it('reports a save failure without firing the saved event', async () => {
    mockSaveSchedule.mockResolvedValue({ success: false, error: 'nope' });
    const user = userEvent.setup();
    render(<ScheduleTab />);
    await screen.findByText('Weekly hours');

    await user.click(screen.getByRole('button', { name: 'Save schedule' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nope'));
    expect(track).not.toHaveBeenCalledWith(SCHEDULE_EVENTS.SAVED, expect.anything());
  });

  // Explicit timeout: four sequential real Radix Select/Popover interactions comfortably
  // clear the default 5s under an isolated run but can miss it under full-repo worker
  // contention (matches the repo's other pointer-capture-driven tests' behaviour).
  it('adds, edits, removes, and copies a range through the real day-row wiring', async () => {
    const user = userEvent.setup();
    render(<ScheduleTab />);
    await screen.findByText('Weekly hours');

    // Add a second range to Monday (first "Add a time range" button in display order).
    const addButtons = screen.getAllByRole('button', { name: /Add a time range/ });
    const [firstAddButton] = addButtons;
    if (!firstAddButton) throw new Error('expected an Add a time range button');
    await user.click(firstAddButton);
    expect(screen.getByRole('combobox', { name: 'Monday range 2 start time' })).toBeInTheDocument();

    // Change Monday's range 1 start time via the real Radix Select.
    await user.click(screen.getByRole('combobox', { name: 'Monday range 1 start time' }));
    await user.click(screen.getByRole('option', { name: '10:00 AM' }));
    expect(screen.getByRole('combobox', { name: 'Monday range 1 start time' })).toHaveTextContent(
      '10:00 AM'
    );

    // Remove the range just added.
    await user.click(screen.getByRole('button', { name: 'Remove Monday range 2' }));
    expect(
      screen.queryByRole('combobox', { name: 'Monday range 2 start time' })
    ).not.toBeInTheDocument();

    // Copy Monday's hours onto Wednesday via the copy popover.
    await user.click(screen.getByRole('button', { name: 'Copy Monday hours to other days' }));
    await user.click(screen.getByLabelText('Wednesday'));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('switch', { name: 'Wednesday availability' })).toBeChecked();
    expect(
      screen.getByRole('combobox', { name: 'Wednesday range 1 start time' })
    ).toHaveTextContent('10:00 AM');
  }, 15000);
});
