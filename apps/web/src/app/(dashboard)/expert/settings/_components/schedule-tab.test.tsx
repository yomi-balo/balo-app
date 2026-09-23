import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { track } from '@/lib/analytics';
import { SCHEDULE_EVENTS } from '@balo/analytics/events';
import { toast } from 'sonner';
import type { ScheduleLoadResult } from '../_actions/get-schedule';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// Stub the calendar section (has its own fetch + searchParams) — we only assert where it mounts.
vi.mock('./calendar-connections-section', () => ({
  CalendarConnectionsSection: () => (
    <div data-testid="calendar-connections-section-stub">calendar</div>
  ),
}));

// BAL-397 §3.1 — DateOverridesCard renders from ScheduleTab as a sibling of the calendar
// section, with its own fetch (a failed calendar fetch must not take it down), so it needs
// its own stub here.
vi.mock('./date-overrides-card', () => ({
  DateOverridesCard: () => <div data-testid="date-overrides-card-stub">time off</div>,
}));

// Stub the Radix-heavy timezone combobox (rendered by the header's timezone line) so we can
// drive the timezone handler deterministically. Its own list behaviour is covered by
// schedule-timezone-combobox.test.tsx.
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

// BAL-236 — stub the picker. Its own behaviour is covered by
// `components/availability/ExpertAvailabilityCalendar.test.tsx`; this suite only proves the
// mount condition and the expertProfileId ref→state promotion (D15).
vi.mock('@/components/availability', () => ({
  ExpertAvailabilityCalendar: ({ expertProfileId }: { expertProfileId: string }) => (
    <div data-testid="availability-preview-stub">preview:{expertProfileId}</div>
  ),
}));

// Stub the Radix-heavy booking-rules selects; expose a deterministic change button so
// the booking_rules_saved change-gate can be driven without pointer events. Field
// rendering itself is covered by booking-rules-section.test.tsx.
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
    useReducedMotion: () => false,
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
    expect(screen.getByRole('button', { name: 'Clear schedule' })).toBeInTheDocument();
    expect(screen.getByTestId('calendar-connections-section-stub')).toBeInTheDocument();
  });

  it('heads the tab with the title, description and the timezone line — no separate timezone card', async () => {
    render(<ScheduleTab />);
    await screen.findByText('Weekly hours');

    expect(screen.getByRole('heading', { level: 1, name: 'Schedule' })).toBeInTheDocument();
    expect(
      screen.getByText(/These hours, minus anything busy on your calendar, become the times/)
    ).toBeInTheDocument();
    const line = screen.getByText(/Hours are set in/);
    expect(line).toHaveTextContent(/Hours are set in Melbourne \(GMT\+1[01]\)/);
    expect(line).toHaveTextContent(/currently (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}:\d{2} (AM|PM)/);
    expect(
      screen.getByRole('button', { name: /timezone:Australia\/Melbourne/ })
    ).toBeInTheDocument();
    expect(screen.queryByText('Timezone')).not.toBeInTheDocument();
  });

  it('orders the cards Availability → Time off → Calendars → What clients see', async () => {
    render(<ScheduleTab />);
    await screen.findByText('Weekly hours');

    const sequence = [
      screen.getByRole('region', { name: 'Availability' }),
      screen.getByTestId('date-overrides-card-stub'),
      screen.getByTestId('calendar-connections-section-stub'),
      screen.getByRole('region', { name: 'What clients see' }),
    ];
    for (const [index, node] of sequence.entries()) {
      const next = sequence[index + 1];
      if (next === undefined) break;
      expect(node.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('renders the calendar section bare, as a direct sibling of the other cards', async () => {
    render(<ScheduleTab />);
    await screen.findByText('Weekly hours');

    const availability = screen.getByRole('region', { name: 'Availability' });
    const calendars = screen.getByTestId('calendar-connections-section-stub');
    expect(calendars.parentElement).toBe(availability.parentElement);
  });

  it('keeps weekly hours, booking rules, the footnote and the actions inside the Availability card', async () => {
    render(<ScheduleTab />);
    await screen.findByText('Weekly hours');

    const card = screen.getByRole('region', { name: 'Availability' });
    expect(
      within(card).getByText('Your open hours, turned into bookable slots.')
    ).toBeInTheDocument();
    expect(
      within(card).getByRole('heading', { level: 3, name: 'Weekly hours' })
    ).toBeInTheDocument();
    expect(within(card).getAllByRole('switch')).toHaveLength(7);
    expect(within(card).getByText('Booking rules')).toBeInTheDocument();
    expect(
      within(card).getByText(
        'Clients see these hours minus anything already busy on your connected calendar, converted to their own timezone.'
      )
    ).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Clear schedule' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Save schedule' })).toBeInTheDocument();
    // The footnote is the only calendar explainer — nothing repeats it outside the card.
    expect(screen.queryByText(/We automatically hide any times/)).not.toBeInTheDocument();
  });

  it('shows a loading skeleton inside the Availability card, with no timezone line or actions', () => {
    mockGetSchedule.mockReturnValue(new Promise(() => {})); // never resolves
    render(<ScheduleTab />);

    const card = screen.getByRole('region', { name: 'Availability' });
    const loading = within(card).getByRole('status');
    expect(loading).toHaveTextContent('Loading your hours');
    // A native <output>, not a role on a <div> (SonarCloud S6819).
    expect(loading.tagName).toBe('OUTPUT');
    expect(screen.queryByText(/Hours are set in/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save schedule' })).not.toBeInTheDocument();
    // Time off and Calendars load independently, so they mount regardless.
    expect(screen.getByTestId('date-overrides-card-stub')).toBeInTheDocument();
    expect(screen.getByTestId('calendar-connections-section-stub')).toBeInTheDocument();
  });

  // BAL-397 §3.1 — DateOverridesCard renders from ScheduleTab directly, not nested inside
  // the calendar section, so a broken calendar fetch can never take Time off down with it.
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
    const card = screen.getByRole('region', { name: 'Availability' });
    expect(within(card).getByText('Set your weekly hours')).toBeInTheDocument();
    // The timezone line stays available — it persists on its own, independent of rules.
    expect(screen.getByText(/Hours are set in/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save schedule' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Use these hours' }));
    expect(await screen.findByText('Weekly hours')).toBeInTheDocument();
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) {
      expect(screen.getByRole('switch', { name: `${day} availability` })).toBeChecked();
    }
    expect(screen.getByRole('switch', { name: 'Saturday availability' })).not.toBeChecked();
  });

  it('starts "set them up myself" from Monday alone', async () => {
    mockGetSchedule.mockResolvedValue(loadResult({ rules: [] }));
    const user = userEvent.setup();
    render(<ScheduleTab />);

    await user.click(await screen.findByRole('button', { name: 'Set them up myself' }));
    expect(await screen.findByText('Weekly hours')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Monday availability' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Tuesday availability' })).not.toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Monday range 1 start time' })).toHaveTextContent(
      '9:00 AM'
    );
  });

  // ── BAL-236 — the availability preview mount (D15) ────────────

  it('renders the availability preview once the schedule loads, with the promoted expertProfileId', async () => {
    mockGetSchedule.mockResolvedValue(loadResult({ expertProfileId: 'profile-xyz' }));
    render(<ScheduleTab />);

    await screen.findByText('Weekly hours');
    const preview = screen.getByRole('region', { name: 'What clients see' });
    expect(
      within(preview).getByText(
        'Your hours, minus anything already busy on your connected calendar.'
      )
    ).toBeInTheDocument();
    expect(within(preview).getByTestId('availability-preview-stub')).toHaveTextContent(
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
    const card = screen.getByRole('region', { name: 'Availability' });
    expect(within(card).getByText("We couldn't load your hours")).toBeInTheDocument();
    // The zone is unknown until the load succeeds, so the line waits for it.
    expect(screen.queryByText(/Hours are set in/)).not.toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: /Try again/ }));
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
    // The toast is the confirmation — no separate saved-hours summary is rendered.
    expect(screen.queryByText('Your bookable hours')).not.toBeInTheDocument();
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
    expect(screen.getByText('Tue')).toHaveClass('text-muted-foreground');
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

    // Straight from the empty state — nothing is persisted, so no reinterpret risk.
    await user.click(await screen.findByRole('button', { name: /timezone:Australia\/Melbourne/ }));

    await waitFor(() => expect(mockUpdateTimezone).toHaveBeenCalledWith('Australia/Sydney'));
    expect(screen.queryByText('Change your timezone?')).not.toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('Timezone updated');
    expect(screen.getByText(/Hours are set in/)).toHaveTextContent(/Hours are set in Sydney/);
  });

  it('changes timezone immediately after clearing, since no rules remain to reinterpret', async () => {
    const user = userEvent.setup();
    render(<ScheduleTab />);
    await screen.findByText('Weekly hours');

    await user.click(screen.getByRole('button', { name: 'Clear schedule' }));
    await user.click(await screen.findByRole('button', { name: 'Yes, clear it' }));
    await screen.findByText('Set your weekly hours');

    await user.click(screen.getByRole('button', { name: /timezone:Australia\/Melbourne/ }));
    await waitFor(() => expect(mockUpdateTimezone).toHaveBeenCalledWith('Australia/Sydney'));
    expect(screen.queryByText('Change your timezone?')).not.toBeInTheDocument();
  });

  it('reverts the timezone line and reports the error when the change fails', async () => {
    mockGetSchedule.mockResolvedValue(loadResult({ rules: [] }));
    mockUpdateTimezone.mockResolvedValue({ success: false, error: 'Timezone rejected' });
    const user = userEvent.setup();
    render(<ScheduleTab />);

    await user.click(await screen.findByRole('button', { name: /timezone:Australia\/Melbourne/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Timezone rejected'));
    expect(screen.getByText(/Hours are set in/)).toHaveTextContent(/Melbourne/);
    expect(track).not.toHaveBeenCalledWith(SCHEDULE_EVENTS.TIMEZONE_CHANGED, expect.anything());
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
    // An inline note inside the Availability card, not a card of its own.
    expect(screen.getByRole('region', { name: 'Availability' })).toContainElement(alert);
  });

  it('shows no DST note when no range lands in a spring-forward gap', async () => {
    render(<ScheduleTab />);
    await screen.findByText('Weekly hours');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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

  it('reports a clear failure and keeps the editor', async () => {
    mockClearSchedule.mockResolvedValue({ success: false, error: 'Could not clear' });
    const user = userEvent.setup();
    render(<ScheduleTab />);
    await screen.findByText('Weekly hours');

    await user.click(screen.getByRole('button', { name: 'Clear schedule' }));
    await user.click(await screen.findByRole('button', { name: 'Yes, clear it' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not clear'));
    expect(track).not.toHaveBeenCalledWith(SCHEDULE_EVENTS.CLEARED, expect.anything());
    expect(screen.getByText('Weekly hours')).toBeInTheDocument();
  });

  // Explicit timeout: four sequential real Radix Select/Popover interactions comfortably
  // clear the default 5s under an isolated run but can miss it under full-repo worker
  // contention (matches the repo's other pointer-capture-driven tests' behaviour).
  it('adds, edits, removes, and copies a range through the real day-row wiring', async () => {
    const user = userEvent.setup();
    render(<ScheduleTab />);
    await screen.findByText('Weekly hours');

    // Add a second range to Monday.
    await user.click(screen.getByRole('button', { name: 'Add range to Monday' }));
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
