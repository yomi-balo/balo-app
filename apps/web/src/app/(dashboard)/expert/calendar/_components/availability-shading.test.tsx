import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import { AvailabilityShading } from './availability-shading';
import type { AvailabilityView } from '@/components/availability/use-expert-availability';

/**
 * BAL-498 fix round 1 — B4/B6. `availability-shading.tsx` shipped with ZERO tests; this file
 * exists to catch exactly the B4 regression (the sr-only summary read a full UTC-offset off from
 * the visible wash) and to cover the states plan §12.2 named. Run in a non-UTC-adjacent zone
 * scenario deliberately (`Australia/Sydney`, UTC+10) — a UTC-only fixture cannot distinguish the
 * broken double-zone-conversion implementation from the fixed one.
 */

let mockView: AvailabilityView = { kind: 'loading' };
vi.mock('@/components/availability/use-expert-availability', () => ({
  useExpertAvailability: () => ({ view: mockView, reload: vi.fn() }),
}));

const DAY_KEYS = ['2026-08-24', '2026-08-25'];
const GRID_RANGE = { start: 0, end: 1440 };

describe('AvailabilityShading — ready state renders the wash AND a matching sr-only summary (B4)', () => {
  it('a 9:00 AM–5:00 PM Sydney availability window reads "9:00 AM to 5:00 PM" in the sr-only summary, NOT a UTC-shifted time', () => {
    mockView = {
      kind: 'ready',
      expertTimezone: 'Australia/Sydney',
      days: 7,
      // 09:00-17:00 AEST (UTC+10) on 2026-08-24 = 2026-08-23T23:00Z - 2026-08-24T07:00Z.
      slots: [
        { start: '2026-08-23T23:00:00.000Z', end: '2026-08-24T00:00:00.000Z', maxDuration: 60 },
        { start: '2026-08-24T00:00:00.000Z', end: '2026-08-24T07:00:00.000Z', maxDuration: 60 },
      ],
    };

    render(
      <AvailabilityShading
        expertProfileId="expert-1"
        days={7}
        scheduleTimezone="Australia/Sydney"
        dayKeys={DAY_KEYS}
        gridRange={GRID_RANGE}
      />
    );

    // The regression this test exists to catch: the broken implementation rendered
    // "7:00 pm to 3:00 am" here (a full UTC-offset shift) instead of the wash's own 9-5.
    expect(screen.getByText(/9:00 AM to 5:00 PM/)).toBeInTheDocument();
    expect(screen.queryByText(/7:00 PM/i)).not.toBeInTheDocument();
  });

  it('a day with no slots reads "No availability set"', () => {
    mockView = {
      kind: 'ready',
      expertTimezone: 'Australia/Sydney',
      days: 7,
      slots: [
        { start: '2026-08-23T23:00:00.000Z', end: '2026-08-24T00:00:00.000Z', maxDuration: 60 },
      ],
    };

    render(
      <AvailabilityShading
        expertProfileId="expert-1"
        days={7}
        scheduleTimezone="Australia/Sydney"
        dayKeys={DAY_KEYS}
        gridRange={GRID_RANGE}
      />
    );

    expect(screen.getByText(/No availability set/)).toBeInTheDocument();
  });

  it('calls onViewChange with the resolved view so the parent can render the shared inline note', () => {
    mockView = { kind: 'ready', expertTimezone: 'Australia/Sydney', days: 7, slots: [] };
    const onViewChange = vi.fn();

    render(
      <AvailabilityShading
        expertProfileId="expert-1"
        days={7}
        scheduleTimezone="Australia/Sydney"
        dayKeys={DAY_KEYS}
        gridRange={GRID_RANGE}
        onViewChange={onViewChange}
      />
    );

    expect(onViewChange).toHaveBeenCalledWith(mockView);
  });
});

describe('AvailabilityShading — days outside the queried window are NOT called "No availability set" (R2)', () => {
  /**
   * BAL-498 fix round 3, R2. The endpoint's window is `[today, today + days)`. For a partially-
   * beyond-horizon week (weekStart = today+10 -> `days: 14`) the last three columns and, in the
   * current week, every past day, were NEVER QUERIED — yet the summary announced "No availability
   * set" about them, which is a positive claim about data that does not exist. D3 forbids exactly
   * this. Branching on `runs.length` alone cannot tell the two apart; branching on the DAY can.
   */
  const WEEK = ['2026-08-23', '2026-08-24', '2026-08-25', '2026-08-26'];

  function renderWindowed(): void {
    mockView = { kind: 'ready', expertTimezone: 'Australia/Sydney', days: 2, slots: [] };
    render(
      <AvailabilityShading
        expertProfileId="expert-1"
        days={2}
        scheduleTimezone="Australia/Sydney"
        dayKeys={WEEK}
        gridRange={GRID_RANGE}
        todayDayKey="2026-08-24"
        coverageEndDayKey="2026-08-25"
      />
    );
  }

  it('a day BEFORE today reads "Past", not "No availability set"', () => {
    renderWindowed();

    const summary = document.getElementById('calendar-availability-summary-2026-08-23');
    expect(summary?.textContent).toBe('Sun: Past');
    expect(summary?.textContent).not.toContain('No availability set');
  });

  it('a day BEYOND the queried horizon reads "Beyond the availability window"', () => {
    renderWindowed();

    const summary = document.getElementById('calendar-availability-summary-2026-08-26');
    expect(summary?.textContent).toBe('Wed: Beyond the availability window');
    expect(summary?.textContent).not.toContain('No availability set');
  });

  it('a day INSIDE the queried window with genuinely no slots still reads "No availability set"', () => {
    renderWindowed();

    const today = document.getElementById('calendar-availability-summary-2026-08-24');
    const covered = document.getElementById('calendar-availability-summary-2026-08-25');
    expect(today?.textContent).toBe('Mon: No availability set');
    expect(covered?.textContent).toBe('Tue: No availability set');
  });
});

describe('AvailabilityShading — cross-midnight slots paint as TWO fragments (R3)', () => {
  /**
   * `apps/api/src/services/availability/resolver.ts` supports `crossesMidnight`
   * (`endTime < startTime`), so a 22:00→02:00 rule is reachable. The previous
   * `height: (end - start) * PX_PER_MINUTE` then went NEGATIVE — an invalid CSS value — and the
   * band silently did not paint at all, on either day.
   */
  it('a 22:00–02:00 Sydney window clips at midnight and continues at 00:00 on the next day', () => {
    mockView = {
      kind: 'ready',
      expertTimezone: 'Australia/Sydney',
      days: 7,
      // 2026-08-24 22:00 AEST = 2026-08-24T12:00Z; 2026-08-25 02:00 AEST = 2026-08-24T16:00Z.
      slots: [
        { start: '2026-08-24T12:00:00.000Z', end: '2026-08-24T16:00:00.000Z', maxDuration: 60 },
      ],
    };

    const { container } = render(
      <AvailabilityShading
        expertProfileId="expert-1"
        days={7}
        scheduleTimezone="Australia/Sydney"
        dayKeys={DAY_KEYS}
        gridRange={GRID_RANGE}
      />
    );

    // TWO rects, and NEITHER has a negative height (the regression: one rect, height -1200px).
    const rects = [...container.querySelectorAll('span[style]')];
    const heights = rects.map((rect) => (rect as HTMLElement).style.height);
    expect(heights).toHaveLength(2);
    for (const height of heights) {
      expect(height.startsWith('-')).toBe(false);
    }

    // And the text equivalent names both halves, on the right days.
    expect(document.getElementById('calendar-availability-summary-2026-08-24')?.textContent).toBe(
      'Mon: Available 10:00 PM to 12:00 AM'
    );
    expect(document.getElementById('calendar-availability-summary-2026-08-25')?.textContent).toBe(
      'Tue: Available 12:00 AM to 2:00 AM'
    );
  });
});

describe('AvailabilityShading — the four explained-absence states render NOTHING (caller draws the note)', () => {
  it.each([
    ['not_published' as const],
    ['not_configured' as const],
    ['unavailable' as const],
    ['error' as const],
  ])('kind=%s renders no wash and no sr-only text', (kind) => {
    mockView = { kind };
    const { container } = render(
      <AvailabilityShading
        expertProfileId="expert-1"
        days={7}
        scheduleTimezone="Australia/Sydney"
        dayKeys={DAY_KEYS}
        gridRange={GRID_RANGE}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('kind=empty_window also renders nothing itself — the shell draws the "no bookable time" note', () => {
    mockView = { kind: 'empty_window', days: 7 };
    const { container } = render(
      <AvailabilityShading
        expertProfileId="expert-1"
        days={7}
        scheduleTimezone="Australia/Sydney"
        dayKeys={DAY_KEYS}
        gridRange={GRID_RANGE}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('kind=loading also renders nothing', () => {
    mockView = { kind: 'loading' };
    const { container } = render(
      <AvailabilityShading
        expertProfileId="expert-1"
        days={7}
        scheduleTimezone="Australia/Sydney"
        dayKeys={DAY_KEYS}
        gridRange={GRID_RANGE}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });
});
