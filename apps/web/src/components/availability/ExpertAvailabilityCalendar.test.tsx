import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from '@/test/axe';
import userEvent from '@testing-library/user-event';
import { MAX_AVAILABILITY_WINDOW_DAYS } from '@balo/shared/availability';
import { act } from '@testing-library/react';
import { render, screen, waitFor, within } from '@/test/utils';
import { track } from '@/lib/analytics';
import {
  AVAILABILITY_EXPERT_ID as EXPERT_ID,
  jsonResponse,
  okAvailabilityBody as okBody,
} from '@/test/fixtures/availability';
import { ExpertAvailabilityCalendar } from './ExpertAvailabilityCalendar';

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(track).mockClear();
  // Only `Date` is faked (not `setTimeout`) — testing-library's internal polling in
  // `findBy*`/`waitFor` keeps running on real timers, but the component's `new Date()` (which
  // anchors the calendar's initial visible month) is pinned so the fixture's June 2026 slots
  // land in the month the calendar opens on.
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Slot = { start: string; end: string; maxDuration: number };

function slot(start: string, maxDuration: number): Slot {
  const end = new Date(Date.parse(start) + maxDuration * 60_000).toISOString();
  return { start, end, maxDuration };
}

const JUN5_9 = '2026-06-05T09:00:00.000Z';
const JUN5_10 = '2026-06-05T10:00:00.000Z';
const JUN5_11 = '2026-06-05T11:00:00.000Z';

function mockSlots(slots: Slot[]): void {
  fetchMock.mockResolvedValue(jsonResponse(200, okBody({ slots })));
}

type PickerProps = Partial<React.ComponentProps<typeof ExpertAvailabilityCalendar>>;

function renderPicker(props: PickerProps = {}): ReturnType<typeof render> {
  return render(
    <ExpertAvailabilityCalendar
      expertProfileId={EXPERT_ID}
      viewerTimezone="UTC"
      daysAhead={14}
      {...props}
    />
  );
}

async function openDay(user: ReturnType<typeof userEvent.setup>, name: RegExp): Promise<void> {
  await user.click(await screen.findByRole('button', { name }));
}

const radioNamed = (name: string): HTMLElement => screen.getByRole('radio', { name });

describe('ExpertAvailabilityCalendar', () => {
  it('renders the loading skeleton before the fetch resolves', () => {
    fetchMock.mockReturnValue(new Promise(() => {})); // never resolves
    renderPicker();
    expect(screen.getByRole('status', { name: /loading availability/i })).toBeInTheDocument();
  });

  describe('the up-front length', () => {
    it('asks once as a radiogroup of four lengths, with 60 preselected and no "Any"', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      renderPicker();

      const group = await screen.findByRole('radiogroup', { name: 'How long do you need?' });
      expect(within(group).getAllByRole('radio')).toHaveLength(4);
      expect(radioNamed('60 min')).toBeChecked();
      expect(screen.queryByRole('radio', { name: 'Any' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Any' })).not.toBeInTheDocument();
    });

    it('steps the default down the ladder and disables lengths nothing can hold', async () => {
      mockSlots([slot(JUN5_9, 30), slot(JUN5_10, 15)]);
      renderPicker();

      await screen.findByRole('radiogroup');
      expect(radioNamed('30 min')).toBeChecked();
      expect(radioNamed('45 min')).toBeDisabled();
      expect(radioNamed('60 min')).toBeDisabled();
      expect(radioNamed('15 min')).toBeEnabled();
    });

    it('honours defaultDurationMinutes when it is available', async () => {
      mockSlots([slot(JUN5_9, 60)]);
      renderPicker({ defaultDurationMinutes: 30 });

      await screen.findByRole('radiogroup');
      expect(radioNamed('30 min')).toBeChecked();
    });

    it('shows the billing note under the control, unpinned only', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      const { unmount } = renderPicker({ lengthNote: <p>You pay for minutes used.</p> });
      expect(await screen.findByText('You pay for minutes used.')).toBeInTheDocument();
      unmount();

      renderPicker({ lengthNote: <p>You pay for minutes used.</p>, fixedDurationMinutes: 60 });
      await screen.findByText(/same as your current consultation/);
      expect(screen.queryByText('You pay for minutes used.')).not.toBeInTheDocument();
    });
  });

  describe('the day and its rows', () => {
    it('lists times as ranges at the chosen length, with a long-date heading', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      const user = userEvent.setup();
      renderPicker();
      await openDay(user, /June 5th, 2026/);

      expect(await screen.findByRole('button', { name: /9:00 – 10:00 am/ })).toBeInTheDocument();
      expect(screen.queryByText(/up to/)).not.toBeInTheDocument();
      expect(screen.queryByText(/· 60 min/)).not.toBeInTheDocument();
      expect(screen.getByText('Friday 5 June')).toBeInTheDocument();
      expect(screen.getByText('1 time available')).toBeInTheDocument();
      expect(screen.queryByText('Today')).not.toBeInTheDocument();
    });

    it('names the day in full and badges today, never headlining the word "Today"', async () => {
      vi.setSystemTime(new Date('2026-06-05T08:00:00.000Z'));
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      const user = userEvent.setup();
      renderPicker();
      await openDay(user, /June 5th, 2026/);

      expect(await screen.findByText('Friday 5 June')).toBeInTheDocument();
      expect(screen.getByText('Today')).toBeInTheDocument();
    });

    it('prompts for a date, naming the length, before one is chosen', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      renderPicker();

      expect(await screen.findByText('Select a date')).toBeInTheDocument();
      expect(screen.getByText('Days with a dot have 60-minute times.')).toBeInTheDocument();
    });

    // ⚠ `staggerChildren` propagates only when the PARENT transitions between variants, and the
    // slot list's `motion.ul` keeps its place in the tree across a day change. jsdom runs no
    // animation, so opacity is not assertable; the remount is.
    it('remounts the slot list on a day change, so the reveal animation re-runs', async () => {
      mockSlots([slot(JUN5_9, 60), slot('2026-06-06T09:00:00.000Z', 60)]);
      const user = userEvent.setup();
      const { container } = renderPicker();

      await openDay(user, /June 5th, 2026/);
      await screen.findByRole('button', { name: /9:00 – 10:00 am/ });
      const firstList = container.querySelector('ul');
      expect(firstList).not.toBeNull();

      await openDay(user, /June 6th, 2026/);
      await screen.findByRole('button', { name: /9:00 – 10:00 am/ });
      const secondList = container.querySelector('ul');
      expect(secondList).not.toBeNull();
      expect(secondList).not.toBe(firstList);
    });

    it('renders times in the VIEWER timezone, not UTC', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      const user = userEvent.setup();
      renderPicker({ viewerTimezone: 'Australia/Sydney' });
      // 2026-06-05T09:00Z is 7:00 pm in Sydney (AEST, UTC+10).
      await openDay(user, /June 5th, 2026/);

      expect(await screen.findByRole('button', { name: /7:00 – 8:00 pm/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /9:00 – 10:00 am/ })).not.toBeInTheDocument();
    });

    it('falls back to the browser zone when viewerTimezone is omitted or invalid', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      const { unmount } = render(
        <ExpertAvailabilityCalendar expertProfileId={EXPERT_ID} daysAhead={14} />
      );
      expect(await screen.findByText(/times in/i)).toBeInTheDocument();
      unmount();

      // An invalid IANA string must not crash: `isValidTimezone` sends it down the same fallback.
      renderPicker({ viewerTimezone: 'Not/AZone' });
      expect(await screen.findByText(/times in/i)).toBeInTheDocument();
    });

    // D10: a cross-midnight interval groups under its START day, LABELLED to show the crossing.
    it('marks a slot whose own end lands on the next viewer-zone day', async () => {
      mockSlots([slot('2026-06-05T23:45:00.000Z', 60)]);
      const user = userEvent.setup();
      renderPicker({ mode: 'preview' });
      await openDay(user, /June 5th, 2026/);

      // 6 June 2026 is a Saturday.
      expect(await screen.findByText('→ Sat')).toBeInTheDocument();
    });

    it('does not mark a slot that stays inside its own day', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      const user = userEvent.setup();
      renderPicker();
      await openDay(user, /June 5th, 2026/);
      await screen.findByRole('button', { name: /9:00 – 10:00 am/ });
      expect(screen.queryByText(/^→ /)).not.toBeInTheDocument();
    });

    it('moves focus to the day heading when a day is picked', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      const user = userEvent.setup();
      renderPicker({ onSlotSelect: vi.fn() });
      await openDay(user, /June 5th, 2026/);
      await screen.findByRole('button', { name: /9:00 – 10:00 am/ });

      expect(document.activeElement).not.toBe(document.body);
      // Programmatic focus on a non-interactive block must not paint the browser's default ring.
      expect(document.activeElement).toHaveClass('focus-visible:outline-none');
    });

    it('preview mode: no Continue CTA, rows are not buttons', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      const user = userEvent.setup();
      renderPicker({ mode: 'preview' });
      await openDay(user, /June 5th, 2026/);
      await screen.findByText(/9:00 – 10:00 am/);

      expect(screen.queryByRole('button', { name: /9:00 – 10:00 am/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Continue with/ })).not.toBeInTheDocument();
    });
  });

  describe('changing the length', () => {
    it('keeps a selected time that still fits the new length', async () => {
      mockSlots([slot(JUN5_9, 60), slot(JUN5_11, 45)]);
      const user = userEvent.setup();
      renderPicker();
      await openDay(user, /June 5th, 2026/);
      await user.click(await screen.findByRole('button', { name: /9:00 – 10:00 am/ }));

      await user.click(radioNamed('30 min'));

      expect(screen.getByRole('button', { name: /^9:00 – 9:30 am/ })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      expect(radioNamed('30 min')).toBeChecked();
    });

    it('clears a selected time that cannot hold the new length', async () => {
      mockSlots([slot(JUN5_9, 60), slot(JUN5_11, 45)]);
      const user = userEvent.setup();
      renderPicker({ defaultDurationMinutes: 45 });
      await openDay(user, /June 5th, 2026/);
      await user.click(await screen.findByRole('button', { name: /^11:00 – 11:45 am/ }));
      expect(screen.getByRole('button', { name: /Continue with/ })).toBeInTheDocument();

      await user.click(radioNamed('60 min'));

      expect(screen.queryByRole('button', { name: /11:00/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Continue with/ })).not.toBeInTheDocument();
    });

    it('reports the choice with its source and the previous length', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      const user = userEvent.setup();
      renderPicker();
      await screen.findByRole('radiogroup');

      await user.click(radioNamed('30 min'));

      expect(track).toHaveBeenCalledWith('availability_duration_chosen', {
        expert_id: EXPERT_ID,
        duration_minutes: 30,
        previous_minutes: 60,
        source: 'pill',
      });
    });

    it('does nothing when the current length is chosen again', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      const user = userEvent.setup();
      renderPicker();
      await screen.findByRole('radiogroup');

      await user.click(radioNamed('60 min'));

      expect(track).not.toHaveBeenCalledWith('availability_duration_chosen', expect.anything());
    });
  });

  describe('"Need it sooner?" offers', () => {
    it('offers an earlier shorter call; taking it switches the length and selects the time', async () => {
      mockSlots([slot(JUN5_9, 30), slot(JUN5_10, 60)]);
      const user = userEvent.setup();
      renderPicker();
      await openDay(user, /June 5th, 2026/);

      expect(await screen.findByText('Need it sooner? Try a shorter call:')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Switch to 9:00 am 30 min' }));

      expect(radioNamed('30 min')).toBeChecked();
      expect(screen.getByRole('button', { name: /^9:00 – 9:30 am/ })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      expect(track).toHaveBeenCalledWith(
        'availability_duration_chosen',
        expect.objectContaining({ source: 'sooner_offer', previous_minutes: 60 })
      );
    });

    it('moves focus to the newly pressed time row after taking an offer', async () => {
      mockSlots([slot(JUN5_9, 30), slot(JUN5_10, 60)]);
      const user = userEvent.setup();
      renderPicker();
      await openDay(user, /June 5th, 2026/);

      await user.click(await screen.findByRole('button', { name: 'Switch to 9:00 am 30 min' }));

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /^9:00 – 9:30 am/ })).toHaveFocus()
      );
    });

    it('falls back to the day heading when no row is pressed (preview)', async () => {
      mockSlots([slot(JUN5_9, 30), slot(JUN5_10, 60)]);
      const user = userEvent.setup();
      renderPicker({ mode: 'preview' });
      await openDay(user, /June 5th, 2026/);

      await user.click(await screen.findByRole('button', { name: 'Switch to 9:00 am 30 min' }));

      await waitFor(() =>
        expect(screen.getByText('Friday 5 June').closest('[tabindex="-1"]')).toHaveFocus()
      );
    });

    it('names an offer by its visible text, with no aria-label overriding it', async () => {
      mockSlots([slot(JUN5_9, 30), slot(JUN5_10, 60)]);
      const user = userEvent.setup();
      renderPicker();
      await openDay(user, /June 5th, 2026/);

      await screen.findByText('Need it sooner? Try a shorter call:');
      const offer = await screen.findByRole('button', { name: 'Switch to 9:00 am 30 min' });
      expect(offer).not.toHaveAttribute('aria-label');
      expect(offer).toHaveTextContent('9:00 am');
      expect(offer).toHaveTextContent('30 min');
    });

    it('reports the offers shown once per day and length', async () => {
      mockSlots([slot(JUN5_9, 30), slot(JUN5_10, 60), slot('2026-06-06T09:00:00.000Z', 60)]);
      const user = userEvent.setup();
      renderPicker();
      await openDay(user, /June 5th, 2026/);
      await screen.findByText('Need it sooner? Try a shorter call:');
      await openDay(user, /June 6th, 2026/);
      await openDay(user, /June 5th, 2026/);
      await screen.findByText('Need it sooner? Try a shorter call:');

      const shown = vi
        .mocked(track)
        .mock.calls.filter((call) => call[0] === 'availability_sooner_offer_shown');
      expect(shown).toHaveLength(1);
      expect(shown[0]?.[1]).toEqual({
        expert_id: EXPERT_ID,
        chosen_minutes: 60,
        offered_minutes: [30],
      });
    });

    it('stays interactive in preview, switching the length without selecting a time', async () => {
      mockSlots([slot(JUN5_9, 30), slot(JUN5_10, 60)]);
      const user = userEvent.setup();
      renderPicker({ mode: 'preview' });
      await openDay(user, /June 5th, 2026/);

      await user.click(await screen.findByRole('button', { name: 'Switch to 9:00 am 30 min' }));

      expect(radioNamed('30 min')).toBeChecked();
      expect(screen.queryByRole('button', { name: /Continue with/ })).not.toBeInTheDocument();
    });

    it('is never shown while the length is pinned', async () => {
      mockSlots([slot(JUN5_9, 30), slot(JUN5_10, 60)]);
      const user = userEvent.setup();
      renderPicker({ fixedDurationMinutes: 60 });
      await openDay(user, /June 5th, 2026/);
      await screen.findByRole('button', { name: /10:00 – 11:00 am/ });

      expect(screen.queryByText(/Need it sooner/)).not.toBeInTheDocument();
      expect(track).not.toHaveBeenCalledWith('availability_sooner_offer_shown', expect.anything());
    });
  });

  describe('a day with nothing at the length', () => {
    const slots = [slot('2026-06-26T09:00:00.000Z', 30), slot('2026-07-02T09:00:00.000Z', 60)];

    beforeEach(() => {
      vi.setSystemTime(new Date('2026-06-25T00:00:00.000Z'));
    });

    it('explains, offers the shorter call, and jumps to the next day (a month later)', async () => {
      mockSlots(slots);
      const user = userEvent.setup();
      renderPicker();
      await openDay(user, /June 26th, 2026/);

      expect(await screen.findByText('No 60-minute times on Friday.')).toBeInTheDocument();
      expect(screen.getByText('A shorter call on Friday:')).toBeInTheDocument();
      expect(track).toHaveBeenCalledWith('availability_empty_state_shown', {
        expert_id: EXPERT_ID,
        reason: 'no_slots_at_length',
      });

      await user.click(screen.getByRole('button', { name: 'Go to Thursday 2 July' }));

      expect(await screen.findByText(/July 2026/)).toBeInTheDocument();
      expect(screen.getByText('Thursday 2 July')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /9:00 – 10:00 am/ })).toBeInTheDocument();
    });

    it('is unreachable while pinned: the day is disabled', async () => {
      mockSlots(slots);
      renderPicker({ fixedDurationMinutes: 60 });

      expect(await screen.findByRole('button', { name: /June 26th, 2026/ })).toBeDisabled();
    });
  });

  describe('Continue', () => {
    it('emits the selection directly, with no confirm step', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      const onSlotSelect = vi.fn();
      const user = userEvent.setup();
      renderPicker({ onSlotSelect });
      await openDay(user, /June 5th, 2026/);
      await user.click(await screen.findByRole('button', { name: /9:00 – 10:00 am/ }));
      expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /Continue with 9:00 – 10:00 am/ }));

      expect(onSlotSelect).toHaveBeenCalledTimes(1);
      expect(onSlotSelect).toHaveBeenCalledWith({
        start: JUN5_9,
        end: JUN5_10,
        duration: 60,
      });
      expect(track).toHaveBeenCalledWith(
        'availability_slot_selected',
        expect.objectContaining({
          expert_id: EXPERT_ID,
          duration_minutes: 60,
          duration_is_default: true,
        })
      );
    });

    it('is single-shot: a double click emits once', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      const onSlotSelect = vi.fn();
      const user = userEvent.setup();
      renderPicker({ onSlotSelect });
      await openDay(user, /June 5th, 2026/);
      await user.click(await screen.findByRole('button', { name: /9:00 – 10:00 am/ }));

      await user.dblClick(screen.getByRole('button', { name: /Continue with/ }));

      expect(onSlotSelect).toHaveBeenCalledTimes(1);
    });

    it('reports duration_is_default false once the length was changed', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      const user = userEvent.setup();
      renderPicker({ onSlotSelect: vi.fn() });
      await user.click(await screen.findByRole('radio', { name: '30 min' }));
      await openDay(user, /June 5th, 2026/);
      await user.click(await screen.findByRole('button', { name: /^9:00 – 9:30 am/ }));
      await user.click(screen.getByRole('button', { name: /Continue with/ }));

      expect(track).toHaveBeenCalledWith(
        'availability_slot_selected',
        expect.objectContaining({ duration_minutes: 30, duration_is_default: false })
      );
    });

    it('pinned: emits the pinned length and reports it as not a default', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      const onSlotSelect = vi.fn();
      const user = userEvent.setup();
      renderPicker({ onSlotSelect, fixedDurationMinutes: 60 });
      await openDay(user, /June 5th, 2026/);
      await user.click(await screen.findByRole('button', { name: /9:00 – 10:00 am/ }));
      await user.click(screen.getByRole('button', { name: /Continue with/ }));

      expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
      expect(onSlotSelect).toHaveBeenCalledWith({ start: JUN5_9, end: JUN5_10, duration: 60 });
      expect(track).toHaveBeenCalledWith(
        'availability_slot_selected',
        expect.objectContaining({ duration_is_default: false })
      );
    });

    // ⚠ The fallback path once had an unrecoverable dead end: the standalone confirmation
    // short-circuited the right panel and was never reset.
    it('standalone (no onSlotSelect): names the time, says nothing is booked, and recovers', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      const user = userEvent.setup();
      renderPicker();
      await openDay(user, /June 5th, 2026/);
      await user.click(await screen.findByRole('button', { name: /9:00 – 10:00 am/ }));
      await user.click(screen.getByRole('button', { name: /Continue with/ }));

      expect(
        await screen.findByText(/time selected: .*at 9:00 AM, 60 minutes/i)
      ).toBeInTheDocument();
      expect(screen.getByText(/nothing is booked yet/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /choose another time/i }));
      expect(await screen.findByRole('button', { name: /9:00 – 10:00 am/ })).toBeInTheDocument();
      expect(screen.queryByText(/time selected/i)).not.toBeInTheDocument();
    });

    it('standalone: clicking a different day also clears the confirmation', async () => {
      mockSlots([slot(JUN5_9, 60), slot('2026-06-06T11:00:00.000Z', 60)]);
      const user = userEvent.setup();
      renderPicker();
      await openDay(user, /June 5th, 2026/);
      await user.click(await screen.findByRole('button', { name: /9:00 – 10:00 am/ }));
      await user.click(screen.getByRole('button', { name: /Continue with/ }));
      await screen.findByText(/time selected/i);

      await user.click(screen.getByRole('button', { name: /June 6th, 2026/ }));

      expect(
        await screen.findByRole('button', { name: /11:00 am – 12:00 pm/ })
      ).toBeInTheDocument();
      expect(screen.queryByText(/time selected/i)).not.toBeInTheDocument();
    });
  });

  describe('initialSelection (Change)', () => {
    const initial = { start: JUN5_9, end: JUN5_10, duration: 60 as const };

    it('restores the length, the day and the pressed time', async () => {
      mockSlots([slot(JUN5_9, 60), slot(JUN5_11, 45)]);
      renderPicker({
        initialSelection: { start: JUN5_11, end: '2026-06-05T11:45:00.000Z', duration: 45 },
      });

      expect(await screen.findByText('Friday 5 June')).toBeInTheDocument();
      expect(radioNamed('45 min')).toBeChecked();
      expect(screen.getByRole('button', { name: /^11:00 – 11:45 am/ })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    });

    it('does not preselect the time when the length falls back from the restored one', async () => {
      mockSlots([slot(JUN5_9, 30)]);
      renderPicker({ initialSelection: initial });

      expect(await screen.findByText('Friday 5 June')).toBeInTheDocument();
      expect(radioNamed('30 min')).toBeChecked();
      expect(screen.getByRole('button', { name: /^9:00 – 9:30 am/ })).toHaveAttribute(
        'aria-pressed',
        'false'
      );
    });

    it('restores only the length and day when the time is no longer offered', async () => {
      mockSlots([slot(JUN5_10, 60)]);
      renderPicker({ initialSelection: initial });

      expect(await screen.findByText('Friday 5 June')).toBeInTheDocument();
      expect(radioNamed('60 min')).toBeChecked();
      expect(screen.getByRole('button', { name: /10:00 – 11:00 am/ })).toHaveAttribute(
        'aria-pressed',
        'false'
      );
    });
  });

  describe('count line', () => {
    it('announces the number of times politely', async () => {
      mockSlots([slot(JUN5_9, 60), slot(JUN5_10, 60)]);
      const user = userEvent.setup();
      renderPicker();
      await openDay(user, /June 5th, 2026/);

      expect(await screen.findByText('2 times available')).toHaveAttribute('aria-live', 'polite');
    });
  });

  describe('past start times', () => {
    it('lists a slot that is still ahead, then drops it once the clock passes it', async () => {
      vi.setSystemTime(new Date('2026-06-05T08:55:00.000Z'));
      mockSlots([slot(JUN5_9, 60), slot('2026-06-06T09:00:00.000Z', 60)]);
      const user = userEvent.setup();
      renderPicker();
      await openDay(user, /June 5th, 2026/);
      expect(await screen.findByRole('button', { name: /9:00 – 10:00 am/ })).toBeInTheDocument();

      act(() => {
        vi.setSystemTime(new Date('2026-06-05T09:05:00.000Z'));
        document.dispatchEvent(new Event('visibilitychange'));
      });

      await waitFor(() =>
        expect(screen.queryByRole('button', { name: /9:00 – 10:00 am/ })).not.toBeInTheDocument()
      );
    });

    it('deselects a chosen time that has started', async () => {
      vi.setSystemTime(new Date('2026-06-05T08:55:00.000Z'));
      mockSlots([slot(JUN5_9, 60), slot(JUN5_11, 60)]);
      const user = userEvent.setup();
      renderPicker({ onSlotSelect: vi.fn() });
      await openDay(user, /June 5th, 2026/);
      await user.click(await screen.findByRole('button', { name: /9:00 – 10:00 am/ }));
      expect(screen.getByRole('button', { name: /Continue with/ })).toBeInTheDocument();

      act(() => {
        vi.setSystemTime(new Date('2026-06-05T09:05:00.000Z'));
        globalThis.dispatchEvent(new Event('focus'));
      });

      await waitFor(() =>
        expect(screen.queryByRole('button', { name: /Continue with/ })).not.toBeInTheDocument()
      );
    });

    it('reads as an empty window when every slot has already started', async () => {
      vi.setSystemTime(new Date('2026-06-05T12:00:00.000Z'));
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      renderPicker();

      expect(await screen.findByText(/nothing open in the next 14 days/i)).toBeInTheDocument();
      const shown = vi
        .mocked(track)
        .mock.calls.filter((call) => call[0] === 'availability_empty_state_shown');
      expect(shown).toHaveLength(1);
      expect(shown[0]?.[1]).toMatchObject({ reason: 'no_slots' });
    });
  });

  describe('BAL-409 — fixedDurationMinutes', () => {
    it('replaces the control with a read-only line and lists only slots that hold the pin', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      const user = userEvent.setup();
      renderPicker({ fixedDurationMinutes: 60 });
      await openDay(user, /June 5th, 2026/);

      expect(await screen.findByText(/9:00 – 10:00 am/)).toBeInTheDocument();
      expect(
        screen.getByText('60 minutes — same as your current consultation')
      ).toBeInTheDocument();
      expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
      expect(screen.queryByText(/10:00 – 10:30/)).not.toBeInTheDocument();
    });

    it('a day with only a shorter slot is disabled, never widened', async () => {
      mockSlots([slot(JUN5_9, 60), slot('2026-06-06T09:00:00.000Z', 15)]);
      renderPicker({ fixedDurationMinutes: 60 });

      expect(await screen.findByRole('button', { name: /June 6th, 2026/ })).toBeDisabled();
    });

    it('changes nothing when omitted: the free control is shown', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      renderPicker();

      expect(await screen.findByRole('radiogroup')).toBeInTheDocument();
    });
  });

  it('not_configured renders its own copy', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, okBody({ status: 'not_configured', slots: [] })));
    render(
      <ExpertAvailabilityCalendar expertProfileId={EXPERT_ID} viewerTimezone="UTC" daysAhead={14} />
    );
    expect(await screen.findByText(/booking hours aren't published yet/i)).toBeInTheDocument();
  });

  it('no_slots leads with the action and refetches at the maximum window', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, okBody({ status: 'no_slots', slots: [], days: 7 }))
    );
    const user = userEvent.setup();
    render(
      <ExpertAvailabilityCalendar expertProfileId={EXPERT_ID} viewerTimezone="UTC" daysAhead={7} />
    );
    // ⚠ ACTION-LED, not absence-led (`balo-ui-skill`'s empty-state rule).
    expect(await screen.findByText(/look further ahead — nothing open/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /look further ahead/i }));

    await waitFor(() => {
      const lastCall = fetchMock.mock.calls.at(-1) as [string];
      expect(lastCall[0]).toContain(`days=${MAX_AVAILABILITY_WINDOW_DAYS}`);
    });
  });

  /**
   * The counterpart: at the maximum window there is nothing further to offer, so the invitation
   * would be a dead promise. State it plainly and offer the real next step instead.
   */
  it('no_slots at the maximum window states it plainly, with no dead "look further ahead"', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        okBody({ status: 'no_slots', slots: [], days: MAX_AVAILABILITY_WINDOW_DAYS })
      )
    );
    render(
      <ExpertAvailabilityCalendar
        expertProfileId={EXPERT_ID}
        viewerTimezone="UTC"
        daysAhead={MAX_AVAILABILITY_WINDOW_DAYS}
      />
    );
    expect(await screen.findByText(/nothing open in the next 14 days/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /look further ahead/i })).not.toBeInTheDocument();
  });

  it('unavailable renders its own copy and never reads as "no availability"', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(503, { status: 'unavailable', retryAfterSeconds: 30 })
    );
    render(
      <ExpertAvailabilityCalendar expertProfileId={EXPERT_ID} viewerTimezone="UTC" daysAhead={14} />
    );
    const message = await screen.findByText(/we can't reach their calendar right now/i);
    expect(message).toBeInTheDocument();
    expect(document.body.textContent?.toLowerCase()).not.toContain('no availability');
  });

  describe('paused (BAL-591)', () => {
    const PAUSED_BODY = { expertProfileId: EXPERT_ID, status: 'paused', days: 14 };

    it('renders the paused panel instead of a calendar, and no slots', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, PAUSED_BODY));
      render(
        <ExpertAvailabilityCalendar
          expertProfileId={EXPERT_ID}
          viewerTimezone="UTC"
          daysAhead={14}
        />
      );
      expect(await screen.findByText('Not taking on new work right now')).toBeInTheDocument();
      expect(screen.queryByRole('grid')).not.toBeInTheDocument();
      expect(screen.queryByText(/look further ahead/i)).not.toBeInTheDocument();
    });

    it('the owner preview explains what clients see, and offers no Try again', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, PAUSED_BODY));
      render(
        <ExpertAvailabilityCalendar
          expertProfileId={EXPERT_ID}
          mode="preview"
          viewerType="expert"
          viewerTimezone="UTC"
          daysAhead={14}
        />
      );
      expect(
        await screen.findByText(/clients see this message instead of your times/i)
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
    });

    it('prefers pausedAction over emptyAction on the paused state', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, PAUSED_BODY));
      render(
        <ExpertAvailabilityCalendar
          expertProfileId={EXPERT_ID}
          viewerTimezone="UTC"
          emptyAction={<span>empty action</span>}
          pausedAction={<span>paused action</span>}
        />
      );
      expect(await screen.findByText('paused action')).toBeInTheDocument();
      expect(screen.queryByText('empty action')).not.toBeInTheDocument();
    });

    it('does not report paused as an empty state', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, PAUSED_BODY));
      render(<ExpertAvailabilityCalendar expertProfileId={EXPERT_ID} viewerTimezone="UTC" />);
      await screen.findByText('Not taking on new work right now');
      expect(track).not.toHaveBeenCalledWith('availability_empty_state_shown', expect.anything());
    });

    it('requests scope=new_work by default and forwards an explicit scope', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      const { unmount } = render(
        <ExpertAvailabilityCalendar expertProfileId={EXPERT_ID} viewerTimezone="UTC" />
      );
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('scope')).toBe(
        'new_work'
      );
      unmount();
      fetchMock.mockClear();

      render(
        <ExpertAvailabilityCalendar
          expertProfileId={EXPERT_ID}
          viewerTimezone="UTC"
          scope="existing_work"
        />
      );
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('scope')).toBe(
        'existing_work'
      );
    });
  });

  it('error renders its own copy with a Try again that re-issues the fetch', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'availability_failed' }));
    const user = userEvent.setup();
    render(
      <ExpertAvailabilityCalendar expertProfileId={EXPERT_ID} viewerTimezone="UTC" daysAhead={14} />
    );
    expect(await screen.findByText(/couldn't load availability/i)).toBeInTheDocument();
    const callsBefore = fetchMock.mock.calls.length;

    await user.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('not_published (404) renders its own copy — the OWNER, in preview mode', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: 'not_found' }));
    render(
      <ExpertAvailabilityCalendar
        expertProfileId={EXPERT_ID}
        viewerTimezone="UTC"
        daysAhead={14}
        mode="preview"
        viewerType="expert"
      />
    );
    expect(await screen.findByText(/isn't published yet/i)).toBeInTheDocument();
  });

  // Item 15 — the OWNER proposing their own reschedule times hits this exact shape:
  // `mode="selectable"` (the picker is interactive) but `viewerType="expert"` (it's their own
  // profile). Before this fix the panel was gated on `mode === 'preview'` alone, so this fell
  // through to the generic, un-actionable "Couldn't load availability." + a Retry that could
  // never succeed.
  it('not_published (404) also renders its own copy for the OWNER in SELECTABLE mode, with a settings link', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: 'not_found' }));
    render(
      <ExpertAvailabilityCalendar
        expertProfileId={EXPERT_ID}
        viewerTimezone="UTC"
        daysAhead={14}
        mode="selectable"
        viewerType="expert"
      />
    );
    expect(await screen.findByText(/isn't published yet/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /availability settings/i })).toHaveAttribute(
      'href',
      '/expert/settings?tab=schedule'
    );
  });

  // The CLIENT-facing posture is unchanged: a non-owner viewer must never learn that the
  // profile exists but is unpublished (anti-enumeration, plan §5/§6) — falls through to the
  // generic error state regardless of `mode`.
  it('not_published (404) falls through to the generic error for a CLIENT viewer', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: 'not_found' }));
    render(
      <ExpertAvailabilityCalendar
        expertProfileId={EXPERT_ID}
        viewerTimezone="UTC"
        daysAhead={14}
        mode="selectable"
        viewerType="client"
      />
    );
    expect(await screen.findByText(/couldn't load availability/i)).toBeInTheDocument();
    expect(screen.queryByText(/isn't published yet/i)).not.toBeInTheDocument();
  });

  it('fires availability_calendar_viewed exactly once, not on refetches', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, okBody({ status: 'no_slots', slots: [], days: 7 }))
    );
    const user = userEvent.setup();
    render(
      <ExpertAvailabilityCalendar expertProfileId={EXPERT_ID} viewerTimezone="UTC" daysAhead={7} />
    );
    await screen.findByText(/nothing open/i);
    await user.click(screen.getByRole('button', { name: /look further ahead/i }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));

    const viewedCalls = vi
      .mocked(track)
      .mock.calls.filter((call) => call[0] === 'availability_calendar_viewed');
    expect(viewedCalls).toHaveLength(1);
  });

  it('has no accessibility violations in the ready state', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
    const { container } = render(
      <ExpertAvailabilityCalendar expertProfileId={EXPERT_ID} viewerTimezone="UTC" daysAhead={14} />
    );
    await screen.findByRole('button', { name: /June 5th, 2026/ });
    expect(await axe(container)).toHaveNoViolations();
  });
});
