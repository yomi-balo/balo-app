import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import type { MeetingClocks } from '@balo/shared/meetings';
import { MeetingClockSlot, type MeetingClockState } from './meeting-clock-slot';

/**
 * BAL-435 (ruling R4) — the top-bar clock chip.
 *
 * ⚠⚠ ALL FOUR ARMS ARE COVERED, INCLUDING THE TWO BAL-134 WIRES UP. They ship as specified
 * behaviour rather than as dead code that would land as uncovered changed lines — and BAL-134
 * then changes ONE PRODUCER LINE rather than this component.
 *
 * ⚠⚠ `aria-live` IS `off` ON EVERY ARM. A duration announced every second is a screen-reader
 * denial of service; the value is exposed as a STATIC `aria-label` for the user to query on
 * demand. That is the assertion this file exists for.
 */

const CLOCKS: MeetingClocks = {
  expertPresentMs: 192_000, // 03:12
  billableMs: 754_000, // 12:34
  expertFirstJoinedAt: new Date('2026-09-02T10:00:00.000Z'),
  billableStartedAt: new Date('2026-09-02T10:02:00.000Z'),
};

/** ⚠ `asOf` === now, so the snapshot arms render their base value with no drift added. */
const AS_OF = new Date('2026-09-02T10:20:00.000Z');

const ALL_STATES: ReadonlyArray<{ label: string; state: MeetingClockState }> = [
  { label: 'not_started', state: { kind: 'not_started' } },
  { label: 'live', state: { kind: 'live' } },
  { label: 'billable', state: { kind: 'billable', clocks: CLOCKS, asOf: AS_OF } },
  { label: 'counted', state: { kind: 'counted', clocks: CLOCKS, asOf: AS_OF } },
];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(AS_OF);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MeetingClockSlot — all four arms', () => {
  it('⚠ BAL-435 produces "Not started" before the join', () => {
    render(<MeetingClockSlot state={{ kind: 'not_started' }} />);

    expect(screen.getByText('Not started')).toBeInTheDocument();
  });

  it('⚠ ruling R4 — the joined state is "Live". PRESENCE, NOT DURATION', () => {
    const { container } = render(<MeetingClockSlot state={{ kind: 'live' }} />);

    expect(screen.getByText('Live')).toBeInTheDocument();
    // ⚠ NO `mm:ss` ANYWHERE. There is no client-side interval timer in this ticket, and a
    // locally-computed number on a surface whose sibling numbers settle money is a promise the
    // platform cannot keep.
    expect(container.textContent ?? '').not.toMatch(/\d{2}:\d{2}/);
  });

  it('renders the BAL-134 billable snapshot as mm:ss', () => {
    render(<MeetingClockSlot state={{ kind: 'billable', clocks: CLOCKS, asOf: AS_OF }} />);

    expect(screen.getByText('12:34')).toBeInTheDocument();
  });

  it('renders the BAL-134 counted snapshot, labelled — the waiting-state-patch top-bar fix', () => {
    render(<MeetingClockSlot state={{ kind: 'counted', clocks: CLOCKS, asOf: AS_OF }} />);

    // While the expert waits their time IS counting, and the bar used to say "Not started".
    expect(screen.getByText(/03:12 counted/)).toBeInTheDocument();
  });

  it('⚠ ticks from `asOf`, so it never accumulates its own drift', () => {
    render(<MeetingClockSlot state={{ kind: 'billable', clocks: CLOCKS, asOf: AS_OF }} />);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(screen.getByText('12:39')).toBeInTheDocument();
  });

  it('⚠ never runs backwards — a clock that does reads as a bug', () => {
    // `asOf` in the future (a clock-skewed client) must clamp to the base, not go negative.
    const future = new Date(AS_OF.getTime() + 60_000);
    render(<MeetingClockSlot state={{ kind: 'billable', clocks: CLOCKS, asOf: future }} />);

    expect(screen.getByText('12:34')).toBeInTheDocument();
  });

  it('⚠ never renders a cost — elapsed time only (BAL-403 precedent)', () => {
    for (const { state } of ALL_STATES) {
      const { container } = render(<MeetingClockSlot state={state} />);
      expect(container.textContent ?? '').not.toMatch(/[$£€]|\bAUD\b|\bUSD\b/);
    }
  });
});

describe('MeetingClockSlot — assistive tech', () => {
  for (const { label, state } of ALL_STATES) {
    it(`⚠⚠ ${label}: aria-live is OFF, and a static aria-label carries the value`, () => {
      const { container } = render(<MeetingClockSlot state={state} />);

      const chip = container.firstElementChild;
      expect(chip).not.toBeNull();
      expect(chip).toHaveAttribute('aria-live', 'off');
      expect(chip?.getAttribute('aria-label') ?? '').not.toBe('');
    });

    it(`has no accessibility violations (${label})`, async () => {
      const { container } = render(<MeetingClockSlot state={state} />);

      expect(await axe(container)).toHaveNoViolations();
    });
  }
});
