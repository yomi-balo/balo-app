import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'jest-axe';
import userEvent from '@testing-library/user-event';
import { MAX_AVAILABILITY_WINDOW_DAYS } from '@balo/shared/availability';
import { render, screen, waitFor } from '@/test/utils';
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

describe('ExpertAvailabilityCalendar', () => {
  it('renders the loading skeleton before the fetch resolves', () => {
    fetchMock.mockReturnValue(new Promise(() => {})); // never resolves
    render(
      <ExpertAvailabilityCalendar expertProfileId={EXPERT_ID} viewerTimezone="UTC" daysAhead={14} />
    );
    expect(screen.getByRole('status', { name: /loading availability/i })).toBeInTheDocument();
  });

  it('ready: clicking a day with slots renders rows with times in the viewer timezone', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
    const user = userEvent.setup();
    render(
      <ExpertAvailabilityCalendar expertProfileId={EXPERT_ID} viewerTimezone="UTC" daysAhead={14} />
    );

    await user.click(await screen.findByRole('button', { name: /June 5th, 2026/ }));

    expect(await screen.findByText('9:00 AM')).toBeInTheDocument();
    expect(screen.getByText('10:00 AM')).toBeInTheDocument();
  });

  describe('BAL-409 — fixedDurationMinutes', () => {
    it('locks the filter and hides the manual pills when supplied', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      const user = userEvent.setup();
      render(
        <ExpertAvailabilityCalendar
          expertProfileId={EXPERT_ID}
          viewerTimezone="UTC"
          daysAhead={14}
          fixedDurationMinutes={60}
        />
      );
      await user.click(await screen.findByRole('button', { name: /June 5th, 2026/ }));

      // The 60-min slot (9:00 AM) shows; the 30-min-only slot (10:00 AM) is filtered out.
      expect(await screen.findByText('9:00 AM')).toBeInTheDocument();
      expect(screen.queryByText('10:00 AM')).not.toBeInTheDocument();

      // No manual duration pills — nothing to click.
      expect(screen.queryByRole('button', { name: '60 min' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '30 min' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Any' })).not.toBeInTheDocument();
    });

    // B6(a) — the confirm step must show ONE non-interactive line, never a radio group whose
    // answer the server discards, and the Confirm button must be enabled immediately (the
    // duration is auto-set, not left for the user to answer).
    it('B6(a) — confirm step shows a non-interactive line, no radio group, and confirms immediately', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      const onSlotSelect = vi.fn();
      const user = userEvent.setup();
      render(
        <ExpertAvailabilityCalendar
          expertProfileId={EXPERT_ID}
          viewerTimezone="UTC"
          daysAhead={14}
          mode="selectable"
          fixedDurationMinutes={60}
          onSlotSelect={onSlotSelect}
        />
      );
      await user.click(await screen.findByRole('button', { name: /June 5th, 2026/ }));
      await user.click(await screen.findByRole('button', { name: /9:00 AM/ }));
      await user.click(screen.getByRole('button', { name: /Continue with/ }));

      // No radio group — the "How long do you need?" question never appears.
      expect(screen.queryByRole('radio')).not.toBeInTheDocument();
      expect(screen.queryByText(/how long do you need/i)).not.toBeInTheDocument();
      // The non-interactive line, and the Confirm button already enabled.
      expect(
        screen.getByText('60 minutes — same as your current consultation')
      ).toBeInTheDocument();
      const confirmButton = screen.getByRole('button', { name: /Confirm 60-min consultation/ });
      expect(confirmButton).toBeEnabled();

      await user.click(confirmButton);

      expect(onSlotSelect).toHaveBeenCalledWith({
        start: '2026-06-05T09:00:00.000Z',
        end: '2026-06-05T10:00:00.000Z',
        duration: 60,
      });
    });

    // B6(b)/(c) — a day with NO ≥60-min slot must render as EMPTY while pinned, never silently
    // widen to show a shorter slot as selectable (that is exactly the `window_not_available`
    // 409 the pin exists to prevent), and the auto-reset "Show all →" escape hatch must not
    // appear — it exists only to discard the pin.
    it('B6(b)/(c) — a day with only a shorter slot stays empty while pinned, with no "Show all"', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          200,
          okBody({
            slots: [
              {
                start: '2026-06-05T09:00:00.000Z',
                end: '2026-06-05T10:00:00.000Z',
                maxDuration: 60,
              },
              {
                start: '2026-06-06T09:00:00.000Z',
                end: '2026-06-06T09:15:00.000Z',
                maxDuration: 15,
              },
            ],
          })
        )
      );
      const user = userEvent.setup();
      render(
        <ExpertAvailabilityCalendar
          expertProfileId={EXPERT_ID}
          viewerTimezone="UTC"
          daysAhead={14}
          fixedDurationMinutes={60}
        />
      );
      await user.click(await screen.findByRole('button', { name: /June 5th, 2026/ }));
      await screen.findByText('9:00 AM');

      await user.click(await screen.findByRole('button', { name: /June 6th, 2026/ }));

      // The 15-min-only slot never appears as a selectable row — not widened to 'any'.
      expect(screen.queryByText('9:00 AM')).not.toBeInTheDocument();
      // No escape hatch back to 'any' while pinned.
      expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument();
      expect(screen.queryByText(/No 60-min slots that day\./)).not.toBeInTheDocument();
      expect(screen.getByText(/0 times available/)).toBeInTheDocument();
    });

    it('changes nothing when omitted — the shipped free-choice behaviour', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      const user = userEvent.setup();
      render(
        <ExpertAvailabilityCalendar
          expertProfileId={EXPERT_ID}
          viewerTimezone="UTC"
          daysAhead={14}
        />
      );
      await user.click(await screen.findByRole('button', { name: /June 5th, 2026/ }));

      expect(await screen.findByText('9:00 AM')).toBeInTheDocument();
      expect(screen.getByText('10:00 AM')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '60 min' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Any' })).toBeInTheDocument();
    });
  });

  it('clicking a duration pill filters the list and fires DURATION_FILTER_USED', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
    const user = userEvent.setup();
    render(
      <ExpertAvailabilityCalendar expertProfileId={EXPERT_ID} viewerTimezone="UTC" daysAhead={14} />
    );
    await user.click(await screen.findByRole('button', { name: /June 5th, 2026/ }));
    await screen.findByText('9:00 AM');

    await user.click(screen.getByRole('button', { name: '60 min' }));

    expect(screen.getByText('9:00 AM')).toBeInTheDocument();
    expect(screen.queryByText('10:00 AM')).not.toBeInTheDocument();
    expect(track).toHaveBeenCalledWith(
      'availability_duration_filter_used',
      expect.objectContaining({ expert_id: EXPERT_ID, filter_value: 60 })
    );
  });

  it('switching to a day with no match for the active filter auto-resets to Any with a warning, and fires no filter-used event for the reset', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        okBody({
          slots: [
            { start: '2026-06-05T09:00:00.000Z', end: '2026-06-05T10:00:00.000Z', maxDuration: 60 },
            { start: '2026-06-06T09:00:00.000Z', end: '2026-06-06T09:15:00.000Z', maxDuration: 15 },
          ],
        })
      )
    );
    const user = userEvent.setup();
    render(
      <ExpertAvailabilityCalendar expertProfileId={EXPERT_ID} viewerTimezone="UTC" daysAhead={14} />
    );
    await user.click(await screen.findByRole('button', { name: /June 5th, 2026/ }));
    await screen.findByText('9:00 AM');
    await user.click(screen.getByRole('button', { name: '60 min' }));
    vi.mocked(track).mockClear();

    await user.click(screen.getByRole('button', { name: /June 6th, 2026/ }));

    expect(await screen.findByText(/No 60-min slots that day\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Show all/ })).toBeInTheDocument();
    expect(track).not.toHaveBeenCalledWith('availability_duration_filter_used', expect.anything());
  });

  it('selectable: slot -> Continue -> duration -> confirm calls onSlotSelect with start/end/duration and fires SLOT_SELECTED', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
    const onSlotSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <ExpertAvailabilityCalendar
        expertProfileId={EXPERT_ID}
        viewerTimezone="UTC"
        daysAhead={14}
        mode="selectable"
        onSlotSelect={onSlotSelect}
      />
    );
    await user.click(await screen.findByRole('button', { name: /June 5th, 2026/ }));
    await user.click(await screen.findByRole('button', { name: /9:00 AM/ }));
    await user.click(screen.getByRole('button', { name: /Continue with/ }));
    await user.click(screen.getByLabelText(/60 minutes/));
    await user.click(screen.getByRole('button', { name: /Confirm 60-min consultation/ }));

    expect(onSlotSelect).toHaveBeenCalledWith({
      start: '2026-06-05T09:00:00.000Z',
      end: '2026-06-05T10:00:00.000Z',
      duration: 60,
    });
    expect(track).toHaveBeenCalledWith(
      'availability_slot_selected',
      expect.objectContaining({ expert_id: EXPERT_ID, duration_minutes: 60 })
    );
  });

  /**
   * ⚠ THE FALLBACK PATH HAD ZERO COVERAGE, and it contained an unrecoverable dead end: the
   * standalone confirmation short-circuited the whole right panel and was never reset, so the
   * still-clickable month calendar became a no-op for the rest of the component's life.
   */
  it('standalone confirm (no onSlotSelect): names the time, says nothing is booked, and a day click recovers', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
    const user = userEvent.setup();
    render(
      <ExpertAvailabilityCalendar
        expertProfileId={EXPERT_ID}
        viewerTimezone="UTC"
        daysAhead={14}
        mode="selectable"
      />
    );
    await user.click(await screen.findByRole('button', { name: /June 5th, 2026/ }));
    await user.click(await screen.findByRole('button', { name: /9:00 AM/ }));
    await user.click(screen.getByRole('button', { name: /Continue with/ }));
    await user.click(screen.getByLabelText(/60 minutes/));
    await user.click(screen.getByRole('button', { name: /Confirm 60-min consultation/ }));

    // Names the TIME (two confirmations on a twelve-slot day are otherwise identical) and does
    // not claim a booking this component never makes.
    const summary = await screen.findByText(/time selected: .*at 9:00 AM, 60 minutes/i);
    expect(summary).toBeInTheDocument();
    expect(screen.getByText(/nothing is booked yet/i)).toBeInTheDocument();

    // THE DEAD END, way out #1: the confirmation's own action. This is the ONLY recovery when
    // the day the user wants to change is the one already selected — react-day-picker reports a
    // click on it as a deselect, which the component ignores.
    await user.click(screen.getByRole('button', { name: /choose another time/i }));
    expect(await screen.findByRole('button', { name: /9:00 AM/ })).toBeInTheDocument();
    expect(screen.queryByText(/time selected/i)).not.toBeInTheDocument();
  });

  it('standalone confirm: clicking a DIFFERENT day also clears the confirmation', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        okBody({
          slots: [
            { start: '2026-06-05T09:00:00.000Z', end: '2026-06-05T10:00:00.000Z', maxDuration: 60 },
            { start: '2026-06-06T11:00:00.000Z', end: '2026-06-06T12:00:00.000Z', maxDuration: 60 },
          ],
        })
      )
    );
    const user = userEvent.setup();
    render(
      <ExpertAvailabilityCalendar
        expertProfileId={EXPERT_ID}
        viewerTimezone="UTC"
        daysAhead={14}
        mode="selectable"
      />
    );
    await user.click(await screen.findByRole('button', { name: /June 5th, 2026/ }));
    await user.click(await screen.findByRole('button', { name: /9:00 AM/ }));
    await user.click(screen.getByRole('button', { name: /Continue with/ }));
    await user.click(screen.getByLabelText(/60 minutes/));
    await user.click(screen.getByRole('button', { name: /Confirm 60-min consultation/ }));
    await screen.findByText(/time selected/i);

    // Way out #2 — the month calendar stays interactive behind the confirmation, so a day click
    // must not be a silent no-op.
    await user.click(screen.getByRole('button', { name: /June 6th, 2026/ }));

    expect(await screen.findByRole('button', { name: /11:00 AM/ })).toBeInTheDocument();
    expect(screen.queryByText(/time selected/i)).not.toBeInTheDocument();
  });

  it('a double-click on Confirm emits exactly one selection', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
    const onSlotSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <ExpertAvailabilityCalendar
        expertProfileId={EXPERT_ID}
        viewerTimezone="UTC"
        daysAhead={14}
        mode="selectable"
        onSlotSelect={onSlotSelect}
      />
    );
    await user.click(await screen.findByRole('button', { name: /June 5th, 2026/ }));
    await user.click(await screen.findByRole('button', { name: /9:00 AM/ }));
    await user.click(screen.getByRole('button', { name: /Continue with/ }));
    await user.click(screen.getByLabelText(/60 minutes/));

    const confirm = screen.getByRole('button', { name: /Confirm 60-min consultation/ });
    await user.dblClick(confirm);

    // A parent that treats `onSlotSelect` as a booking trigger would otherwise fire two holds.
    expect(onSlotSelect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /confirming/i })).toBeDisabled();
  });

  it('renders times in the VIEWER timezone, not UTC', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
    const user = userEvent.setup();
    render(
      <ExpertAvailabilityCalendar
        expertProfileId={EXPERT_ID}
        viewerTimezone="Australia/Sydney"
        daysAhead={14}
      />
    );
    // 2026-06-05T09:00Z is 7:00 PM in Sydney (AEST, UTC+10) — a shifted label AND a shifted day.
    await user.click(await screen.findByRole('button', { name: /June 5th, 2026/ }));
    expect(await screen.findByText('7:00 PM')).toBeInTheDocument();
    expect(screen.queryByText('9:00 AM')).not.toBeInTheDocument();
  });

  it('falls back to the browser zone when viewerTimezone is omitted or invalid', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
    const { unmount } = render(
      <ExpertAvailabilityCalendar expertProfileId={EXPERT_ID} daysAhead={14} />
    );
    expect(await screen.findByText(/times in/i)).toBeInTheDocument();
    unmount();

    // An invalid IANA string must not crash — `isValidTimezone` sends it down the same fallback.
    render(
      <ExpertAvailabilityCalendar
        expertProfileId={EXPERT_ID}
        viewerTimezone="Not/AZone"
        daysAhead={14}
      />
    );
    expect(await screen.findByText(/times in/i)).toBeInTheDocument();
  });

  /** D10 — cross-midnight intervals group under their START day, LABELLED to show the crossing. */
  it('marks a slot whose own end lands on the next viewer-zone day', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        okBody({
          slots: [
            { start: '2026-06-05T23:45:00.000Z', end: '2026-06-06T00:45:00.000Z', maxDuration: 60 },
          ],
        })
      )
    );
    const user = userEvent.setup();
    render(
      <ExpertAvailabilityCalendar
        expertProfileId={EXPERT_ID}
        viewerTimezone="UTC"
        daysAhead={14}
        mode="preview"
      />
    );
    await user.click(await screen.findByRole('button', { name: /June 5th, 2026/ }));

    // 6 June 2026 is a Saturday. Preview mode has no duration step, so this row is the ONLY
    // place the crossing can be shown at all.
    expect(await screen.findByText('→ Sat')).toBeInTheDocument();
  });

  it('does not mark a slot that stays inside its own day', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
    const user = userEvent.setup();
    render(
      <ExpertAvailabilityCalendar expertProfileId={EXPERT_ID} viewerTimezone="UTC" daysAhead={14} />
    );
    await user.click(await screen.findByRole('button', { name: /June 5th, 2026/ }));
    await screen.findByText('9:00 AM');
    expect(screen.queryByText(/^→ /)).not.toBeInTheDocument();
  });

  it('moves focus into the panel on each step transition, never dropping it to <body>', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
    const user = userEvent.setup();
    render(
      <ExpertAvailabilityCalendar
        expertProfileId={EXPERT_ID}
        viewerTimezone="UTC"
        daysAhead={14}
        mode="selectable"
        onSlotSelect={vi.fn()}
      />
    );
    await user.click(await screen.findByRole('button', { name: /June 5th, 2026/ }));
    await screen.findByRole('button', { name: /9:00 AM/ });
    expect(document.activeElement).not.toBe(document.body);

    await user.click(screen.getByRole('button', { name: /9:00 AM/ }));
    await user.click(screen.getByRole('button', { name: /Continue with/ }));

    // The element the user just activated has unmounted; focus must land on the step's own
    // "← Back", not fall back to <body>.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /Back/ }))
    );
  });

  it('preview mode: no Continue CTA, slot rows are not buttons and are not tabbable', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
    const user = userEvent.setup();
    render(
      <ExpertAvailabilityCalendar
        expertProfileId={EXPERT_ID}
        viewerTimezone="UTC"
        daysAhead={14}
        mode="preview"
      />
    );
    await user.click(await screen.findByRole('button', { name: /June 5th, 2026/ }));
    await screen.findByText('9:00 AM');

    expect(screen.queryByRole('button', { name: /9:00 AM/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Continue with/ })).not.toBeInTheDocument();
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

  it('not_published (404) renders its own copy', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: 'not_found' }));
    render(
      <ExpertAvailabilityCalendar
        expertProfileId={EXPERT_ID}
        viewerTimezone="UTC"
        daysAhead={14}
        mode="preview"
      />
    );
    expect(await screen.findByText(/isn't published yet/i)).toBeInTheDocument();
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
