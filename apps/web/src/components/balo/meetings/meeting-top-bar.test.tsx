import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MeetingTopBar, type MeetingTopBarProps } from './meeting-top-bar';

/**
 * BAL-435 / BAL-436 — the top bar's SEAT CHIP.
 *
 * ── ⚠⚠ THE THREE THINGS THIS FILE HOLDS ──────────────────────────────────────────────────
 *
 *   1. **`roster === null` RENDERS NOTHING.** An unavailable count is not a count, and a lone
 *      numberless `Users` glyph reads as a control that broke.
 *   2. **THE CHIP IS A `<button>` ONLY WHEN THE PEOPLE SLOT IS REGISTERED.** Absent or real;
 *      never a disabled control saying "this exists and is being withheld from you".
 *   3. **THE NUMBERS ARE THE SERVER'S SEAT COUNTS**, rendered verbatim. They are NOT the tile
 *      count and the two routinely differ.
 */

function renderBar(overrides: Partial<MeetingTopBarProps> = {}): HTMLElement {
  const props: MeetingTopBarProps = {
    isPrimaryHeading: true,
    clock: { kind: 'live' },
    network: 'strong',
    roster: null,
    ...overrides,
  };
  return render(<MeetingTopBar {...props} />).container;
}

describe('MeetingTopBar — the seat chip', () => {
  it('⚠ renders NOTHING when `roster` is null — no glyph, no zero', () => {
    const container = renderBar({ roster: null });

    expect(screen.queryByTestId('meeting-roster')).toBeNull();
    expect(container.textContent ?? '').not.toContain('of 10');
  });

  it('⚠ is a NON-INTERACTIVE span when the People slot is unregistered', () => {
    renderBar({ roster: { participantCount: 3, participantCap: 10 } });

    const chip = screen.getByTestId('meeting-roster');
    expect(chip.tagName).toBe('SPAN');
    expect(screen.queryByRole('button', { name: /people/i })).toBeNull();
  });

  it('is a REAL BUTTON once `onOpenPeople` is supplied', async () => {
    const user = userEvent.setup();
    const onOpenPeople = vi.fn();
    renderBar({ roster: { participantCount: 3, participantCap: 10 }, onOpenPeople });

    const chip = screen.getByRole('button', { name: 'People — 3 of 10 seats' });
    await user.click(chip);

    expect(onOpenPeople).toHaveBeenCalledTimes(1);
  });

  it('⚠ THE `sr-only` NAME IS ON BOTH ARMS — it is just as correct on the button', () => {
    const { rerender } = render(
      <MeetingTopBar
        isPrimaryHeading
        clock={{ kind: 'live' }}
        network="strong"
        roster={{ participantCount: 4, participantCap: 10 }}
      />
    );
    expect(screen.getByText('People — 4 of 10 seats')).toBeInTheDocument();

    rerender(
      <MeetingTopBar
        isPrimaryHeading
        clock={{ kind: 'live' }}
        network="strong"
        roster={{ participantCount: 4, participantCap: 10 }}
        onOpenPeople={vi.fn()}
      />
    );
    expect(screen.getByText('People — 4 of 10 seats')).toBeInTheDocument();
  });

  it('⚠ renders the SERVER counts verbatim — never a derived or local number', () => {
    renderBar({ roster: { participantCount: 7, participantCap: 10 }, onOpenPeople: vi.fn() });

    expect(screen.getByText('7 of 10')).toBeInTheDocument();
  });
});

describe('MeetingTopBar — headings and accessibility', () => {
  it('emits exactly one `<h1>` when it owns the primary heading', () => {
    renderBar({ isPrimaryHeading: true });

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('⚠ emits NO heading at all when the stage owns it', () => {
    renderBar({ isPrimaryHeading: false });

    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it.each([
    ['unregistered', undefined],
    ['registered', vi.fn()],
  ])('has no axe violations with the chip %s', async (_label, onOpenPeople) => {
    const container = renderBar({
      roster: { participantCount: 3, participantCap: 10 },
      ...(onOpenPeople === undefined ? {} : { onOpenPeople }),
    });

    expect(await axe(container)).toHaveNoViolations();
  });
});
