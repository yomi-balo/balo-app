import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// Stub the calendar tab (has its own fetch + searchParams) — we only assert it mounts below.
vi.mock('./calendar-tab', () => ({
  CalendarTab: () => <div data-testid="calendar-tab-stub">calendar</div>,
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
  windowDays: 60,
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
    expect(screen.getByTestId('calendar-tab-stub')).toBeInTheDocument();
  });

  it('shows booking rules but no consultation-length control', async () => {
    render(<ScheduleTab />);
    await screen.findByText('Weekly hours');
    expect(screen.getByText('Booking rules')).toBeInTheDocument();
    expect(screen.getByText('Booking window')).toBeInTheDocument();
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

  it('shows the error state and retries when loading fails', async () => {
    mockGetSchedule.mockResolvedValueOnce(null).mockResolvedValueOnce(loadResult());
    const user = userEvent.setup();
    render(<ScheduleTab />);

    expect(await screen.findByText("We couldn't load your hours")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('Weekly hours')).toBeInTheDocument();
  });

  it('saves the schedule and fires schedule + booking-rules analytics', async () => {
    const user = userEvent.setup();
    render(<ScheduleTab />);
    await screen.findByText('Weekly hours');

    await user.click(screen.getByRole('button', { name: 'Save schedule' }));

    await waitFor(() => expect(mockSaveSchedule).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith('Schedule saved');
    expect(track).toHaveBeenCalledWith(
      SCHEDULE_EVENTS.SAVED,
      expect.objectContaining({ expert_id: 'profile-1', has_split_days: false })
    );
    expect(track).toHaveBeenCalledWith(SCHEDULE_EVENTS.BOOKING_RULES_SAVED, {
      expert_id: 'profile-1',
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

  it('persists a timezone change and fires the timezone analytics event', async () => {
    const user = userEvent.setup();
    render(<ScheduleTab />);
    await screen.findByText('Weekly hours');

    await user.click(screen.getByRole('button', { name: /timezone:Australia\/Melbourne/ }));

    await waitFor(() => expect(mockUpdateTimezone).toHaveBeenCalledWith('Australia/Sydney'));
    expect(track).toHaveBeenCalledWith(SCHEDULE_EVENTS.TIMEZONE_CHANGED, {
      expert_id: 'profile-1',
      from_timezone: 'Australia/Melbourne',
      to_timezone: 'Australia/Sydney',
    });
    expect(toast.success).toHaveBeenCalledWith('Timezone updated');
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

  it('reports a save failure without firing the saved event', async () => {
    mockSaveSchedule.mockResolvedValue({ success: false, error: 'nope' });
    const user = userEvent.setup();
    render(<ScheduleTab />);
    await screen.findByText('Weekly hours');

    await user.click(screen.getByRole('button', { name: 'Save schedule' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nope'));
    expect(track).not.toHaveBeenCalledWith(SCHEDULE_EVENTS.SAVED, expect.anything());
  });
});
